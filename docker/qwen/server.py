import io
import base64
import gc
import tempfile
import os
import subprocess
import sys
import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image
from transformers import AutoModelForCausalLM, AutoTokenizer

app = FastAPI(title="Qwen VLM Service")

model_state = {
    "model": None,
    "tokenizer": None,
    "loaded_path": None,
}


class LoadRequest(BaseModel):
    model_path: str


class GenerateRequest(BaseModel):
    image_base64: str
    prompt: str


def auto_install(module_name: str):
    pkg_map = {
        "tiktoken": "tiktoken",
        "peft": "peft",
        "google.protobuf": "protobuf<4.0.0",
        "google": "protobuf<4.0.0",
        "sentencepiece": "sentencepiece",
        "einops": "einops",
        "timm": "timm",
        "sklearn": "scikit-learn",
        "cv2": "opencv-python-headless",
    }
    pkg = pkg_map.get(module_name, module_name)
    print(f"[qwen] Auto-installing missing module '{module_name}' as '{pkg}' ...")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", pkg, "-q"],
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )
    print(f"[qwen] Installed: {pkg}")


def _do_load(model_path: str):
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    try:
        from transformers import BitsAndBytesConfig
        quant_config = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16)
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            device_map="cuda",
            trust_remote_code=True,
            quantization_config=quant_config,
        ).eval()
    except Exception as e:
        print(f"[qwen] 4-bit load failed, falling back to FP16: {e}")
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            device_map="cuda",
            trust_remote_code=True,
            torch_dtype=torch.float16,
        ).eval()
    return tokenizer, model


def load_with_auto_install(model_path: str, retries: int = 5):
    for attempt in range(retries):
        try:
            return _do_load(model_path)
        except ModuleNotFoundError as e:
            missing = e.name or str(e).split("'")[1] if "'" in str(e) else str(e)
            if attempt < retries - 1:
                auto_install(missing)
            else:
                raise


@app.post("/load")
def load_model(req: LoadRequest):
    if model_state["loaded_path"] == req.model_path:
        return {"status": "already loaded"}

    if model_state["model"] is not None:
        del model_state["model"]
        del model_state["tokenizer"]
        model_state["model"] = None
        model_state["tokenizer"] = None
        gc.collect()
        torch.cuda.empty_cache()

    try:
        print(f"[qwen] Loading model from {req.model_path}")
        tokenizer, model = load_with_auto_install(req.model_path)
        model_state["model"] = model
        model_state["tokenizer"] = tokenizer
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

        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_path = tmp.name
            pil_image.save(tmp_path)

        try:
            query = model_state["tokenizer"].from_list_format([
                {"image": tmp_path},
                {"text": req.prompt},
            ])
            with torch.inference_mode():
                response, _ = model_state["model"].chat(
                    model_state["tokenizer"], query=query, history=None
                )
            return {"caption": response.strip()}
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        print(f"[qwen] Error during generation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/unload")
def unload():
    if model_state["model"] is not None:
        del model_state["model"]
        del model_state["tokenizer"]
        model_state["model"] = None
        model_state["tokenizer"] = None
        model_state["loaded_path"] = None
        gc.collect()
        torch.cuda.empty_cache()
    return {"status": "unloaded"}
