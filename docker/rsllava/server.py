import io
import base64
import gc
import os
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

app = FastAPI(title="RS-LLaVA VLM Service")

model_state = {
    "model": None,
    "processor": None,
    "loaded_path": None,
    "model_type": None,  # "llava_next" | "llava_15"
}


class LoadRequest(BaseModel):
    model_path: str


class GenerateRequest(BaseModel):
    image_base64: str
    prompt: str


def _load_model_auto(model_cls, model_id, **kwargs):
    """Load model with 4-bit quantization if CUDA is available, otherwise fp16/fp32."""
    from transformers import BitsAndBytesConfig

    has_cuda = torch.cuda.is_available()

    if has_cuda:
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True,
        )
        try:
            return model_cls.from_pretrained(
                model_id, device_map="auto", quantization_config=bnb_config, **kwargs,
            )
        except Exception as e:
            print(f"[rsllava] 4-bit load failed ({e}), trying fp16")

    try:
        return model_cls.from_pretrained(
            model_id, device_map="auto", torch_dtype=torch.float16, **kwargs,
        )
    except Exception as e:
        print(f"[rsllava] fp16 load failed ({e}), falling back to fp32")
        return model_cls.from_pretrained(model_id, device_map="auto", **kwargs)


def _load_lora_remap_v15(model, adapter_path):
    """
    Load a LLaVA-1.5 LoRA checkpoint trained with the liuhaotian codebase into
    an HF-native LlavaForConditionalGeneration.

    Key differences that require remapping:
      liuhaotian: base_model.model.model.layers.X ... lora_A.weight
      HF-native:  base_model.model.language_model.model.layers.X ... lora_A.default.weight
    """
    from peft import get_peft_model, LoraConfig, PeftConfig
    from safetensors.torch import load_file

    peft_cfg = PeftConfig.from_pretrained(adapter_path)
    lora_config = LoraConfig(
        r=peft_cfg.r,
        lora_alpha=peft_cfg.lora_alpha,
        lora_dropout=peft_cfg.lora_dropout,
        target_modules=list(peft_cfg.target_modules),
        bias=peft_cfg.bias,
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)

    adapter_file = os.path.join(adapter_path, "adapter_model.safetensors")
    if not os.path.exists(adapter_file):
        adapter_file = os.path.join(adapter_path, "adapter_model.bin")
    raw = load_file(adapter_file, device="cpu")

    remapped = {}
    for k, v in raw.items():
        # liuhaotian:  base_model.model.model.layers.X...lora_A.weight
        # HF-native:   base_model.model.model.language_model.layers.X...lora_A.default.weight
        new_k = k.replace(
            "base_model.model.model.layers.",
            "base_model.model.model.language_model.layers.",
        )
        new_k = new_k.replace(".lora_A.weight", ".lora_A.default.weight")
        new_k = new_k.replace(".lora_B.weight", ".lora_B.default.weight")
        remapped[new_k] = v

    missing, unexpected = model.load_state_dict(remapped, strict=False)
    lora_missing = [k for k in missing if "lora_" in k]
    if lora_missing:
        print(f"[rsllava] Warning: {len(lora_missing)} LoRA keys unmatched after remap")
    else:
        print(f"[rsllava] LLaVA-1.5 LoRA loaded successfully ({len(remapped)} keys)")

    return model


def _do_load(model_path: str):
    from transformers import (
        LlavaNextProcessor, LlavaNextForConditionalGeneration,
        LlavaForConditionalGeneration, AutoProcessor,
    )
    from peft import PeftModel, PeftConfig

    is_lora = os.path.exists(os.path.join(model_path, "adapter_config.json"))

    if is_lora:
        peft_cfg = PeftConfig.from_pretrained(model_path)
        base_id = peft_cfg.base_model_name_or_path

        if "liuhaotian" in base_id or "llava-v1.5" in base_id:
            # LoRA trained with liuhaotian codebase — load HF-native LLaVA-1.5
            hf_base = "llava-hf/llava-1.5-7b-hf"
            print(f"[rsllava] LLaVA-1.5 LoRA (liuhaotian fmt) → HF base: {hf_base}")
            processor = AutoProcessor.from_pretrained(hf_base)
            model = _load_model_auto(LlavaForConditionalGeneration, hf_base)
            model = _load_lora_remap_v15(model, model_path)
            model_type = "llava_15"
        else:
            # LLaVA-Next (1.6) HF-native LoRA
            print(f"[rsllava] LoRA checkpoint detected. Base model: {base_id}")
            processor = LlavaNextProcessor.from_pretrained(base_id)
            model = _load_model_auto(LlavaNextForConditionalGeneration, base_id)
            model = PeftModel.from_pretrained(model, model_path)
            model_type = "llava_next"
    else:
        print(f"[rsllava] Loading full model from {model_path}")
        try:
            processor = LlavaNextProcessor.from_pretrained(model_path)
            model = _load_model_auto(LlavaNextForConditionalGeneration, model_path)
            model_type = "llava_next"
        except Exception:
            processor = AutoProcessor.from_pretrained(model_path)
            model = _load_model_auto(LlavaForConditionalGeneration, model_path)
            model_type = "llava_15"

    model.eval()
    return processor, model, model_type


@app.post("/load")
def load_model(req: LoadRequest):
    if model_state["loaded_path"] == req.model_path:
        return {"status": "already loaded"}

    if model_state["model"] is not None:
        del model_state["model"]
        del model_state["processor"]
        model_state["model"] = None
        model_state["processor"] = None
        model_state["model_type"] = None
        gc.collect()
        torch.cuda.empty_cache()

    try:
        print(f"[rsllava] Loading model from {req.model_path}")
        processor, model, model_type = _do_load(req.model_path)
        model_state["model"] = model
        model_state["processor"] = processor
        model_state["loaded_path"] = req.model_path
        model_state["model_type"] = model_type
        return {"status": "success", "model_type": model_type}
    except Exception as e:
        print(f"[rsllava] Error loading model: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate")
def generate(req: GenerateRequest):
    if model_state["model"] is None:
        raise HTTPException(status_code=400, detail="Model not loaded")

    try:
        image_data = base64.b64decode(req.image_base64)
        pil_image = Image.open(io.BytesIO(image_data)).convert("RGB")

        model = model_state["model"]
        processor = model_state["processor"]
        model_type = model_state["model_type"]

        if model_type == "llava_15":
            # LLaVA-1.5 prompt format
            prompt_text = f"USER: <image>\n{req.prompt}\nASSISTANT:"
            inputs = processor(
                images=pil_image, text=prompt_text, return_tensors="pt"
            ).to(model.device)
        else:
            # LLaVA-Next (1.6) chat format
            conversation = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image"},
                        {"type": "text", "text": req.prompt},
                    ],
                }
            ]
            prompt_text = processor.apply_chat_template(
                conversation, add_generation_prompt=True
            )
            inputs = processor(
                images=pil_image, text=prompt_text, return_tensors="pt"
            ).to(model.device)

        with torch.inference_mode():
            output_ids = model.generate(
                **inputs,
                max_new_tokens=256,
                do_sample=False,
                repetition_penalty=1.1,
            )

        n_input = inputs["input_ids"].shape[1]
        caption = processor.decode(output_ids[0, n_input:], skip_special_tokens=True).strip()
        return {"caption": caption}
    except Exception as e:
        print(f"[rsllava] Error during generation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/unload")
def unload():
    if model_state["model"] is not None:
        del model_state["model"]
        del model_state["processor"]
        model_state["model"] = None
        model_state["processor"] = None
        model_state["loaded_path"] = None
        model_state["model_type"] = None
        gc.collect()
        torch.cuda.empty_cache()
    return {"status": "unloaded"}
