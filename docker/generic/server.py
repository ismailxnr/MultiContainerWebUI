import io
import base64
import gc
import subprocess
import sys
import os
import torch
from typing import List
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

app = FastAPI(title="Generic VLM Service")

model_state = {
    "obj": None,
    "processor": None,
    "loaded_path": None,
    "strategy": None,
}


class LoadRequest(BaseModel):
    model_path: str
    family: str = "pipeline"
    requirements: List[str] = []


class GenerateRequest(BaseModel):
    image_base64: str
    prompt: str


# ── Helpers ──────────────────────────────────────────────────────────────────

def ensure_requirements(packages: List[str]):
    """pip install any packages not already available."""
    for pkg in packages:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", pkg, "-q"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
            )
            print(f"[generic] Installed: {pkg}")
        except Exception as e:
            print(f"[generic] Warning: could not install {pkg}: {e}")


def _unload_current():
    if model_state["obj"] is not None:
        del model_state["obj"]
        model_state["obj"] = None
    if model_state["processor"] is not None:
        del model_state["processor"]
        model_state["processor"] = None
    model_state["loaded_path"] = None
    model_state["strategy"] = None
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _quant_config():
    try:
        from transformers import BitsAndBytesConfig
        return BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16)
    except Exception:
        return None


# ── Strategy: pipeline ────────────────────────────────────────────────────────

def _load_pipeline(model_path: str):
    from transformers import pipeline
    quant = _quant_config()
    try:
        pipe = pipeline(
            "image-to-text",
            model=model_path,
            device_map="auto",
            model_kwargs={"quantization_config": quant} if quant else {},
        )
    except Exception:
        pipe = pipeline("image-to-text", model=model_path, device_map="auto")
    model_state["obj"] = pipe


def _generate_pipeline(pil_image: Image.Image, prompt: str) -> str:
    with torch.inference_mode():
        outputs = model_state["obj"](pil_image, prompt=prompt)
    if isinstance(outputs, list) and outputs:
        return outputs[0].get("generated_text", str(outputs[0])).strip()
    return str(outputs).strip()


# ── Strategy: causal_lm ───────────────────────────────────────────────────────

def _load_causal_lm(model_path: str):
    from transformers import AutoModelForCausalLM, AutoProcessor
    quant = _quant_config()
    try:
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            device_map="auto",
            trust_remote_code=True,
            quantization_config=quant,
        ).eval()
    except Exception:
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            device_map="auto",
            trust_remote_code=True,
            torch_dtype=torch.float16,
        ).eval()
    processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
    model_state["obj"] = model
    model_state["processor"] = processor


def _generate_causal_lm(pil_image: Image.Image, prompt: str) -> str:
    model = model_state["obj"]
    processor = model_state["processor"]
    inputs = processor(images=pil_image, text=prompt, return_tensors="pt").to(model.device)
    with torch.inference_mode():
        out = model.generate(**inputs, max_new_tokens=512)
    return processor.decode(out[0], skip_special_tokens=True).strip()


# ── Strategy: blip2 ───────────────────────────────────────────────────────────

def _load_blip2(model_path: str):
    from transformers import Blip2Processor, Blip2ForConditionalGeneration
    processor = Blip2Processor.from_pretrained(model_path)
    quant = _quant_config()
    try:
        model = Blip2ForConditionalGeneration.from_pretrained(
            model_path, device_map="auto", quantization_config=quant
        )
    except Exception:
        model = Blip2ForConditionalGeneration.from_pretrained(
            model_path, device_map="auto", torch_dtype=torch.float16
        )
    model_state["obj"] = model
    model_state["processor"] = processor


def _generate_blip2(pil_image: Image.Image, prompt: str) -> str:
    model = model_state["obj"]
    processor = model_state["processor"]
    inputs = processor(images=pil_image, text=prompt, return_tensors="pt").to(
        model.device, torch.float16
    )
    with torch.inference_mode():
        out = model.generate(**inputs, max_new_tokens=512)
    return processor.decode(out[0], skip_special_tokens=True).strip()


# ── Strategy: internvl ────────────────────────────────────────────────────────

def _load_internvl(model_path: str):
    from transformers import AutoModel, AutoTokenizer
    quant = _quant_config()
    try:
        model = AutoModel.from_pretrained(
            model_path,
            device_map="auto",
            trust_remote_code=True,
            quantization_config=quant,
        ).eval()
    except Exception:
        model = AutoModel.from_pretrained(
            model_path,
            device_map="auto",
            trust_remote_code=True,
            torch_dtype=torch.float16,
        ).eval()
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    model_state["obj"] = model
    model_state["processor"] = tokenizer


def _generate_internvl(pil_image: Image.Image, prompt: str) -> str:
    import torchvision.transforms as T
    from torchvision.transforms.functional import InterpolationMode

    model = model_state["obj"]
    tokenizer = model_state["processor"]

    MEAN = (0.485, 0.456, 0.406)
    STD = (0.229, 0.224, 0.225)
    transform = T.Compose([
        T.Resize((448, 448), interpolation=InterpolationMode.BICUBIC),
        T.ToTensor(),
        T.Normalize(mean=MEAN, std=STD),
    ])
    pixel_values = transform(pil_image.convert("RGB")).unsqueeze(0).to(
        dtype=torch.float16, device=next(model.parameters()).device
    )
    gen_cfg = {"max_new_tokens": 512, "do_sample": False}
    with torch.inference_mode():
        response = model.chat(tokenizer, pixel_values, prompt, gen_cfg)
    return response.strip()


# ── Strategy registry ────────────────────────────────────────────────────────

LOADERS = {
    "pipeline": _load_pipeline,
    "causal_lm": _load_causal_lm,
    "blip2": _load_blip2,
    "internvl": _load_internvl,
}

GENERATORS = {
    "pipeline": _generate_pipeline,
    "causal_lm": _generate_causal_lm,
    "blip2": _generate_blip2,
    "internvl": _generate_internvl,
}


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/strategies")
def list_strategies():
    return {"strategies": list(LOADERS.keys())}


@app.post("/load")
def load_model(req: LoadRequest):
    if model_state["loaded_path"] == req.model_path and model_state["strategy"] == req.family:
        return {"status": "already loaded"}

    _unload_current()

    if req.requirements:
        print(f"[generic] Installing requirements: {req.requirements}")
        ensure_requirements(req.requirements)

    strategy = req.family if req.family in LOADERS else "pipeline"
    if req.family not in LOADERS:
        print(f"[generic] Unknown strategy '{req.family}', falling back to 'pipeline'")

    try:
        print(f"[generic] Loading {req.model_path} with strategy '{strategy}'")
        LOADERS[strategy](req.model_path)
        model_state["loaded_path"] = req.model_path
        model_state["strategy"] = strategy
        return {"status": "success", "strategy": strategy}
    except Exception as e:
        print(f"[generic] Error loading model: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate")
def generate(req: GenerateRequest):
    if model_state["obj"] is None:
        raise HTTPException(status_code=400, detail="Model not loaded")

    strategy = model_state["strategy"] or "pipeline"
    if strategy not in GENERATORS:
        raise HTTPException(status_code=400, detail=f"No generator for strategy: {strategy}")

    try:
        image_data = base64.b64decode(req.image_base64)
        pil_image = Image.open(io.BytesIO(image_data)).convert("RGB")
        caption = GENERATORS[strategy](pil_image, req.prompt)
        return {"caption": caption}
    except Exception as e:
        print(f"[generic] Error during generation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/unload")
def unload():
    _unload_current()
    return {"status": "unloaded"}
