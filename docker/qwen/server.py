import io
import base64
import gc
import json
import os
import re
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

app = FastAPI(title="Qwen VLM Service")

model_state = {
    "model": None,
    "processor": None,
    "loaded_path": None,
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
            bnb_4bit_use_double_quant=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
        try:
            return model_cls.from_pretrained(
                model_id, quantization_config=bnb_config,
                device_map="auto", torch_dtype=torch.bfloat16, **kwargs,
            )
        except Exception as e:
            print(f"[qwen] 4-bit load failed ({e}), trying fp16")

    try:
        return model_cls.from_pretrained(
            model_id, device_map="auto", torch_dtype=torch.float16, **kwargs,
        )
    except Exception as e:
        print(f"[qwen] fp16 load failed ({e}), falling back to fp32")
        return model_cls.from_pretrained(model_id, device_map="auto", **kwargs)


def _do_load(model_path: str):
    from transformers import AutoModelForImageTextToText, AutoProcessor
    from peft import PeftModel, PeftConfig

    is_lora = os.path.exists(os.path.join(model_path, "adapter_config.json"))

    if is_lora:
        peft_cfg = PeftConfig.from_pretrained(model_path)
        base_model_id = peft_cfg.base_model_name_or_path
        print(f"[qwen] LoRA checkpoint detected. Base model: {base_model_id}")

        processor = AutoProcessor.from_pretrained(base_model_id, trust_remote_code=True)
        model = _load_model_auto(AutoModelForImageTextToText, base_model_id, trust_remote_code=True)
        model = PeftModel.from_pretrained(model, model_path)
    else:
        print(f"[qwen] Loading full model from {model_path}")
        processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
        model = _load_model_auto(AutoModelForImageTextToText, model_path, trust_remote_code=True)

    model.eval()
    return processor, model


@app.post("/load")
def load_model(req: LoadRequest):
    if model_state["loaded_path"] == req.model_path:
        return {"status": "already loaded"}

    if model_state["model"] is not None:
        del model_state["model"]
        del model_state["processor"]
        model_state["model"] = None
        model_state["processor"] = None
        gc.collect()
        torch.cuda.empty_cache()

    try:
        print(f"[qwen] Loading model from {req.model_path}")
        processor, model = _do_load(req.model_path)
        model_state["model"] = model
        model_state["processor"] = processor
        model_state["loaded_path"] = req.model_path
        return {"status": "success"}
    except Exception as e:
        print(f"[qwen] Error loading model: {e}")
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

        # Qwen2.5-VL / Qwen3.5 vision prompt format (matches training/eval scripts)
        formatted_prompt = (
            f"<|im_start|>user\n<|vision_start|><|image_pad|><|vision_end|>"
            f"{req.prompt}<|im_end|>\n"
            f"<|im_start|>assistant\n"
        )

        inputs = processor(
            text=[formatted_prompt],
            images=[pil_image],
            return_tensors="pt",
        ).to(model.device)

        with torch.inference_mode():
            output_ids = model.generate(
                **inputs,
                max_new_tokens=512,
                do_sample=False,
            )

        # Decode only the newly generated tokens
        n_input = inputs["input_ids"].shape[1]
        caption = processor.batch_decode(
            output_ids[:, n_input:], skip_special_tokens=True
        )[0].strip()

        # Handle Qwen3 thinking mode: prefer content after </think>, fall back to inner content
        if "</think>" in caption:
            after = caption.split("</think>", 1)[1].strip()
            if after:
                caption = after
            else:
                # Model only produced a think block — use its inner content as the answer
                inner = re.search(r"<think>(.*)</think>", caption, re.DOTALL)
                caption = inner.group(1).strip() if inner else caption
        elif "<think>" in caption:
            # Truncated think block — strip the tag and use whatever text remains
            caption = re.sub(r"<think>", "", caption).strip()

        return {"caption": caption}
    except Exception as e:
        print(f"[qwen] Error during generation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/unload")
def unload():
    if model_state["model"] is not None:
        del model_state["model"]
        del model_state["processor"]
        model_state["model"] = None
        model_state["processor"] = None
        model_state["loaded_path"] = None
        gc.collect()
        torch.cuda.empty_cache()
    return {"status": "unloaded"}
