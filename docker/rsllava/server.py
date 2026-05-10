import io
import base64
import gc
import sys
import os
import subprocess
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

sys.path.insert(0, os.environ.get("RS_LLAVA_PATH", "/home/ismail/project_vlm/RS-LLaVA"))

try:
    from llava.constants import IMAGE_TOKEN_INDEX, DEFAULT_IMAGE_TOKEN
    from llava.conversation import conv_templates, SeparatorStyle
    from llava.model.builder import load_pretrained_model
    from llava.utils import disable_torch_init
    from llava.mm_utils import tokenizer_image_token, get_model_name_from_path, KeywordsStoppingCriteria
    LLAVA_AVAILABLE = True
except ImportError as e:
    print(f"Warning: Failed to import llava: {e}")
    LLAVA_AVAILABLE = False
    def disable_torch_init(): pass
    def get_model_name_from_path(p): return os.path.basename(p)

app = FastAPI(title="RS-LLaVA VLM Service")

model_state = {
    "model": None,
    "tokenizer": None,
    "image_processor": None,
    "loaded_path": None,
}


class LoadRequest(BaseModel):
    model_path: str


class GenerateRequest(BaseModel):
    image_base64: str
    prompt: str


def auto_install(module_name: str):
    """Map a missing module name to its pip package and install it."""
    pkg_map = {
        "peft": "peft<=0.6.2",          # MODEL_TYPE_TO_PEFT_MODEL_MAPPING removed in peft>=0.7
        "google.protobuf": "protobuf<4.0.0",
        "google": "protobuf<4.0.0",
        "sentencepiece": "sentencepiece",
        "tiktoken": "tiktoken",
        "einops": "einops",
        "timm": "timm",
        "sklearn": "scikit-learn",
        "cv2": "opencv-python-headless",
    }
    pkg = pkg_map.get(module_name, module_name)
    print(f"[rsllava] Auto-installing missing module '{module_name}' as '{pkg}' ...")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", pkg, "-q"],
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )
    print(f"[rsllava] Installed: {pkg}")


def _load_lora_quantized(model_path: str, model_base: str, load_4bit: bool = True):
    """Load a LoRA checkpoint WITHOUT merging — merge_and_unload() breaks bitsandbytes quantization.

    Root cause of the .to() error: accelerate's dispatch_model calls model.to(device) for
    single-GPU 4-bit models when bnb >= 0.43.2 (thinking .to() works), but transformers 4.37.2
    PreTrainedModel.to() unconditionally blocks .to() on quantized models. Since the model is
    already on the correct device, we patch PreTrainedModel.to() to a no-op for quantized models
    for the entire duration of base model + peft loading.
    """
    from llava.model import LlavaLlamaForCausalLM
    from llava.constants import DEFAULT_IMAGE_PATCH_TOKEN, DEFAULT_IM_START_TOKEN, DEFAULT_IM_END_TOKEN
    from transformers import AutoTokenizer, AutoConfig, BitsAndBytesConfig, PreTrainedModel
    from peft import PeftModel

    lora_cfg_pretrained = AutoConfig.from_pretrained(model_base)
    tokenizer = AutoTokenizer.from_pretrained(model_base, use_fast=False)

    if load_4bit:
        quant_kwargs = {"quantization_config": BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True, bnb_4bit_quant_type="nf4",
        )}
        precision = "4-bit"
    else:
        quant_kwargs = {"load_in_8bit": True}
        precision = "8-bit"

    def _move_cpu_buffers_to_cuda(m):
        """Move non-persistent buffers (e.g. RoPE cos/sin cache) left on CPU by the .to() patch."""
        for mod in m.modules():
            for buf_name in list(mod._buffers.keys()):
                buf = mod._buffers[buf_name]
                if buf is not None and buf.device.type == "cpu":
                    mod._buffers[buf_name] = buf.to("cuda")

    # Patch BEFORE from_pretrained: accelerate's dispatch_model calls model.to(device)
    # when bnb >= 0.43.2 on a single GPU, which hits the transformers 4.37.2 restriction.
    _orig_to = PreTrainedModel.to
    def _noop_to_for_quantized(self, *args, **kwargs):
        if getattr(self, "quantization_method", None) is not None:
            return self  # already on correct device — skip the blocked .to() call
        return _orig_to(self, *args, **kwargs)
    PreTrainedModel.to = _noop_to_for_quantized

    try:
        print(f"[rsllava] Loading base model in {precision}...")
        model = LlavaLlamaForCausalLM.from_pretrained(
            model_base, low_cpu_mem_usage=True, config=lora_cfg_pretrained,
            device_map={"": "cuda:0"}, **quant_kwargs
        )
        _move_cpu_buffers_to_cuda(model)

        # Align embedding sizes before peft (mirrors LLaVA builder.py lines 53-56)
        token_num, tokem_dim = model.lm_head.out_features, model.lm_head.in_features
        if model.lm_head.weight.shape[0] != token_num:
            model.lm_head.weight = torch.nn.Parameter(
                torch.empty(token_num, tokem_dim, device=model.device, dtype=model.dtype)
            )
            model.model.embed_tokens.weight = torch.nn.Parameter(
                torch.empty(token_num, tokem_dim, device=model.device, dtype=model.dtype)
            )

        non_lora_path = os.path.join(model_path, "non_lora_trainables.bin")
        if os.path.exists(non_lora_path):
            print("[rsllava] Loading non-LoRA weights...")
            non_lora = torch.load(non_lora_path, map_location="cpu")
            non_lora = {(k[11:] if k.startswith("base_model.") else k): v for k, v in non_lora.items()}
            if any(k.startswith("model.model.") for k in non_lora):
                non_lora = {(k[6:] if k.startswith("model.") else k): v for k, v in non_lora.items()}
            model.load_state_dict(non_lora, strict=False)

        # Build a LoraConfig using only fields peft 0.6.0 understands (newer peft saves
        # extra fields like layer_replication, use_dora, loftq_config that break 0.6.0).
        import json, inspect
        from peft import LoraConfig
        with open(os.path.join(model_path, "adapter_config.json")) as _f:
            _raw_cfg = json.load(_f)
        _supported = set(inspect.signature(LoraConfig.__init__).parameters) - {"self"}
        _filtered = {k: v for k, v in _raw_cfg.items() if k in _supported}
        _lora_cfg = LoraConfig(**_filtered)
        _lora_cfg.inference_mode = True

        print("[rsllava] Attaching LoRA adapter (no merge — keeps quantization intact)...")
        model = PeftModel.from_pretrained(model, model_path, config=_lora_cfg)
        _move_cpu_buffers_to_cuda(model)

        mm_use_im_start_end = getattr(model.config, "mm_use_im_start_end", False)
        if getattr(model.config, "mm_use_im_patch_token", True):
            tokenizer.add_tokens([DEFAULT_IMAGE_PATCH_TOKEN], special_tokens=True)
        if mm_use_im_start_end:
            tokenizer.add_tokens([DEFAULT_IM_START_TOKEN, DEFAULT_IM_END_TOKEN], special_tokens=True)
        try:
            model.resize_token_embeddings(len(tokenizer))
        except Exception as e:
            print(f"[rsllava] resize_token_embeddings skipped: {e}")

        vision_tower = model.get_vision_tower()
        if not vision_tower.is_loaded:
            vision_tower.load_model()
        vision_tower.to(device="cuda", dtype=torch.float16)

        return tokenizer, model, vision_tower.image_processor
    finally:
        PreTrainedModel.to = _orig_to


def _do_load(model_path: str):
    if not LLAVA_AVAILABLE:
        raise RuntimeError(
            "LLaVA kutuphane bulunamadi. RS_LLAVA_PATH dogru ayarlanmis mi? "
            f"Mevcut deger: {os.environ.get('RS_LLAVA_PATH', 'ayarlanmamis')}"
        )
    disable_torch_init()
    model_name = get_model_name_from_path(model_path)

    offload_dir = "/app/offload_weights"
    os.makedirs(offload_dir, exist_ok=True)

    is_lora = os.path.exists(os.path.join(model_path, "adapter_config.json"))
    model_base = "liuhaotian/llava-v1.5-7b" if is_lora else None

    def _cleanup():
        gc.collect()
        torch.cuda.empty_cache()

    if is_lora:
        # LoRA: never call merge_and_unload() — incompatible with quantization
        try:
            return _load_lora_quantized(model_path, model_base, load_4bit=True)
        except Exception as e:
            msg = str(e)
            del e  # break traceback reference so failed model's GPU memory can be freed
            print(f"[rsllava] LoRA 4-bit load failed, trying 8-bit: {msg}")
            _cleanup()
        return _load_lora_quantized(model_path, model_base, load_4bit=False)

    # Non-LoRA: cascade through quantization levels, cleaning up between attempts
    try:
        tokenizer, model, image_processor, _ = load_pretrained_model(
            model_path, None, model_name,
            load_4bit=True, device_map={"": "cuda:0"}, offload_folder=offload_dir,
        )
        return tokenizer, model, image_processor
    except Exception as e:
        print(f"[rsllava] 4-bit load failed, trying 8-bit: {e}")
        _cleanup()

    try:
        tokenizer, model, image_processor, _ = load_pretrained_model(
            model_path, None, model_name,
            load_8bit=True, device_map={"": "cuda:0"}, offload_folder=offload_dir,
        )
        return tokenizer, model, image_processor
    except Exception as e:
        print(f"[rsllava] 8-bit load failed, trying FP16: {e}")
        _cleanup()

    tokenizer, model, image_processor, _ = load_pretrained_model(
        model_path, None, model_name,
        device_map={"": "cuda:0"}, offload_folder=offload_dir,
    )
    return tokenizer, model, image_processor


def load_with_auto_install(model_path: str, retries: int = 5):
    """Try loading the model; auto-install missing packages and retry on import errors."""
    for attempt in range(retries):
        try:
            return _do_load(model_path)
        except ModuleNotFoundError as e:
            if attempt >= retries - 1:
                raise
            missing = e.name or (str(e).split("'")[1] if "'" in str(e) else str(e))
            auto_install(missing)
        except ImportError as e:
            if attempt >= retries - 1:
                raise
            # peft version conflict — downgrade to LLaVA-compatible version
            if "peft" in str(e).lower() or "MODEL_TYPE_TO_PEFT_MODEL_MAPPING" in str(e):
                print(f"[rsllava] peft version conflict, reinstalling peft<=0.6.2: {e}")
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", "peft<=0.6.2", "-q", "--force-reinstall"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                )
            else:
                raise


@app.post("/load")
def load_model(req: LoadRequest):
    if model_state["loaded_path"] == req.model_path:
        return {"status": "already loaded"}

    if model_state["model"] is not None:
        del model_state["model"]
        del model_state["tokenizer"]
        del model_state["image_processor"]
        model_state["model"] = None
        model_state["tokenizer"] = None
        model_state["image_processor"] = None
        gc.collect()
        torch.cuda.empty_cache()

    try:
        print(f"[rsllava] Loading model from {req.model_path}")
        tokenizer, model, image_processor = load_with_auto_install(req.model_path)
        model_state["model"] = model
        model_state["tokenizer"] = tokenizer
        model_state["image_processor"] = image_processor
        model_state["loaded_path"] = req.model_path
        return {"status": "success"}
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

        target_size = model_state["image_processor"].crop_size.get("height", 336)
        resized_img = pil_image.resize((target_size, target_size), Image.LANCZOS)

        image_tensor = model_state["image_processor"].preprocess(resized_img, return_tensors="pt")["pixel_values"][0]

        cur_prompt = f"{DEFAULT_IMAGE_TOKEN}\n{req.prompt}"
        conv = conv_templates["v1"].copy()
        conv.append_message(conv.roles[0], cur_prompt)
        conv.append_message(conv.roles[1], None)
        full_prompt = conv.get_prompt()

        input_ids = tokenizer_image_token(
            full_prompt, model_state["tokenizer"], IMAGE_TOKEN_INDEX, return_tensors="pt"
        ).unsqueeze(0).cuda()

        stop_str = conv.sep if conv.sep_style != SeparatorStyle.TWO else conv.sep2
        stopping_criteria = KeywordsStoppingCriteria([stop_str], model_state["tokenizer"], input_ids)

        with torch.inference_mode():
            output_ids = model_state["model"].generate(
                input_ids=input_ids,
                images=image_tensor.unsqueeze(0).to(dtype=torch.float16, device="cuda", non_blocking=True),
                do_sample=True,
                temperature=0.5,
                top_p=0.9,
                max_new_tokens=512,
                use_cache=False,
                stopping_criteria=[stopping_criteria],
            )

        input_token_len = input_ids.shape[1]
        outputs = model_state["tokenizer"].batch_decode(
            output_ids[:, input_token_len:], skip_special_tokens=True
        )[0]
        return {"caption": outputs.strip()}
    except Exception as e:
        print(f"[rsllava] Error during generation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/unload")
def unload():
    if model_state["model"] is not None:
        del model_state["model"]
        del model_state["tokenizer"]
        del model_state["image_processor"]
        model_state["model"] = None
        model_state["tokenizer"] = None
        model_state["image_processor"] = None
        model_state["loaded_path"] = None
        gc.collect()
        torch.cuda.empty_cache()
    return {"status": "unloaded"}
