import io
import base64
import gc
import subprocess
import sys
import os
import torch
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

app = FastAPI(title="Generic VLM Service")

model_registry: dict = {}  # model_path -> {"obj": ..., "processor": ..., "strategy": ...}


class LoadRequest(BaseModel):
    model_path: str
    family: str = "pipeline"
    requirements: List[str] = []


class GenerateRequest(BaseModel):
    model_path: str
    image_base64: str
    prompt: str


class UnloadRequest(BaseModel):
    model_path: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def ensure_requirements(packages: List[str]):
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


def _free_entry(entry: dict):
    if entry.get("obj") is not None:
        del entry["obj"]
    if entry.get("processor") is not None:
        del entry["processor"]


def _quant_config():
    try:
        from transformers import BitsAndBytesConfig
        return BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16)
    except Exception:
        return None


# ── Strategy: pipeline ────────────────────────────────────────────────────────

def _load_pipeline(model_path: str) -> dict:
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
    return {"obj": pipe, "processor": None}


def _generate_pipeline(obj, processor, pil_image: Image.Image, prompt: str) -> str:
    with torch.inference_mode():
        outputs = obj(pil_image, prompt=prompt)
    if isinstance(outputs, list) and outputs:
        return outputs[0].get("generated_text", str(outputs[0])).strip()
    return str(outputs).strip()


# ── Strategy: causal_lm ───────────────────────────────────────────────────────

def _load_causal_lm(model_path: str) -> dict:
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
    return {"obj": model, "processor": processor}


def _generate_causal_lm(obj, processor, pil_image: Image.Image, prompt: str) -> str:
    inputs = processor(images=pil_image, text=prompt, return_tensors="pt").to(obj.device)
    with torch.inference_mode():
        out = obj.generate(**inputs, max_new_tokens=512)
    return processor.decode(out[0], skip_special_tokens=True).strip()


# ── Strategy: blip2 ───────────────────────────────────────────────────────────

def _load_blip2(model_path: str) -> dict:
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
    return {"obj": model, "processor": processor}


def _generate_blip2(obj, processor, pil_image: Image.Image, prompt: str) -> str:
    inputs = processor(images=pil_image, text=prompt, return_tensors="pt").to(
        obj.device, torch.float16
    )
    with torch.inference_mode():
        out = obj.generate(**inputs, max_new_tokens=512)
    return processor.decode(out[0], skip_special_tokens=True).strip()


# ── Strategy: internvl ────────────────────────────────────────────────────────

def _load_internvl(model_path: str) -> dict:
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
    return {"obj": model, "processor": tokenizer}


def _generate_internvl(obj, processor, pil_image: Image.Image, prompt: str) -> str:
    import torchvision.transforms as T
    from torchvision.transforms.functional import InterpolationMode

    MEAN = (0.485, 0.456, 0.406)
    STD = (0.229, 0.224, 0.225)
    transform = T.Compose([
        T.Resize((448, 448), interpolation=InterpolationMode.BICUBIC),
        T.ToTensor(),
        T.Normalize(mean=MEAN, std=STD),
    ])
    pixel_values = transform(pil_image.convert("RGB")).unsqueeze(0).to(
        dtype=torch.float16, device=next(obj.parameters()).device
    )
    gen_cfg = {"max_new_tokens": 512, "do_sample": False}
    with torch.inference_mode():
        response = obj.chat(processor, pixel_values, prompt, gen_cfg)
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
    if req.model_path in model_registry:
        return {"status": "already loaded"}

    if req.requirements:
        print(f"[generic] Installing requirements: {req.requirements}")
        ensure_requirements(req.requirements)

    strategy = req.family if req.family in LOADERS else "pipeline"
    if req.family not in LOADERS:
        print(f"[generic] Unknown strategy '{req.family}', falling back to 'pipeline'")

    try:
        print(f"[generic] Loading {req.model_path} with strategy '{strategy}'")
        entry = LOADERS[strategy](req.model_path)
        entry["strategy"] = strategy
        model_registry[req.model_path] = entry
        return {"status": "success", "strategy": strategy}
    except Exception as e:
        print(f"[generic] Error loading model: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate")
def generate(req: GenerateRequest):
    entry = model_registry.get(req.model_path)
    if entry is None:
        raise HTTPException(status_code=400, detail=f"Model not loaded: {req.model_path}")

    strategy = entry.get("strategy", "pipeline")
    if strategy not in GENERATORS:
        raise HTTPException(status_code=400, detail=f"No generator for strategy: {strategy}")

    try:
        image_data = base64.b64decode(req.image_base64)
        pil_image = Image.open(io.BytesIO(image_data)).convert("RGB")
        caption = GENERATORS[strategy](entry["obj"], entry["processor"], pil_image, req.prompt)
        return {"caption": caption}
    except Exception as e:
        print(f"[generic] Error during generation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/unload")
def unload(req: UnloadRequest = None):
    if req is None:
        req = UnloadRequest()

    if req.model_path:
        if req.model_path in model_registry:
            entry = model_registry.pop(req.model_path)
            _free_entry(entry)
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
    else:
        for entry in list(model_registry.values()):
            _free_entry(entry)
        model_registry.clear()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    return {"status": "unloaded"}
