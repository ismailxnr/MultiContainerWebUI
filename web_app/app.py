import os
import io
import json
import time
import asyncio
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

from model_wrappers import get_wrapper_for_family

PROJECT_ROOT = os.path.dirname(os.path.dirname(__file__))
CUSTOM_MODELS_FILE = os.path.join(os.path.dirname(__file__), "custom_models.json")
FAMILIES_FILE = os.path.join(os.path.dirname(__file__), "families.json")

app = FastAPI(title="VLM Studio")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Families ────────────────────────────────────────────────

BUILTIN_FAMILIES = {
    "qwenvl": {
        "name": "Qwen-VL",
        "description": "Alibaba Qwen Vision-Language modelleri",
        "endpoint_type": "qwen",
        "strategy": "qwen",
        "requirements": [],
        "builtin": True,
    },
    "rsllava": {
        "name": "LLaVA / RS-LLaVA",
        "description": "LLaVA v1.5 ve RS-LLaVA fine-tune modelleri",
        "endpoint_type": "rsllava",
        "strategy": "rsllava",
        "requirements": [],
        "builtin": True,
    },
    "pipeline": {
        "name": "HF Pipeline (image-to-text)",
        "description": "Standart HuggingFace image-to-text pipeline — BLIP, GIT, ViT-GPT2 vb.",
        "endpoint_type": "generic",
        "strategy": "pipeline",
        "requirements": [],
        "builtin": True,
    },
    "causal_lm": {
        "name": "AutoModel (CausalLM + AutoProcessor)",
        "description": "AutoModelForCausalLM + AutoProcessor ile çalışan modern VLM'ler",
        "endpoint_type": "generic",
        "strategy": "causal_lm",
        "requirements": [],
        "builtin": True,
    },
    "blip2": {
        "name": "BLIP-2",
        "description": "Salesforce BLIP-2 serisi modeller",
        "endpoint_type": "generic",
        "strategy": "blip2",
        "requirements": [],
        "builtin": True,
    },
    "internvl": {
        "name": "InternVL / InternVL2",
        "description": "InternVL2 serisi modeller — otomatik olarak timm ve einops kurulur",
        "endpoint_type": "generic",
        "strategy": "internvl",
        "requirements": ["timm", "einops"],
        "builtin": True,
    },
}


def load_families() -> dict:
    families = dict(BUILTIN_FAMILIES)
    if os.path.exists(FAMILIES_FILE):
        try:
            with open(FAMILIES_FILE, "r", encoding="utf-8") as f:
                custom = json.load(f)
            for k, v in custom.items():
                if k not in BUILTIN_FAMILIES:
                    families[k] = v
        except Exception as e:
            print(f"Error loading families: {e}")
    return families


def save_custom_family(key: str, name: str, description: str, strategy: str, requirements: list):
    custom = {}
    if os.path.exists(FAMILIES_FILE):
        try:
            with open(FAMILIES_FILE, "r", encoding="utf-8") as f:
                custom = json.load(f)
        except Exception:
            pass
    custom[key] = {
        "name": name,
        "description": description,
        "endpoint_type": "generic",
        "strategy": strategy,
        "requirements": requirements,
        "builtin": False,
    }
    with open(FAMILIES_FILE, "w", encoding="utf-8") as f:
        json.dump(custom, f, indent=4, ensure_ascii=False)


# ─── Models ──────────────────────────────────────────────────

def load_custom_models():
    if os.path.exists(CUSTOM_MODELS_FILE):
        try:
            with open(CUSTOM_MODELS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading custom models: {e}")
    return {}


def save_custom_model(key, name, path, family):
    custom = load_custom_models()
    custom[key] = {
        "name": name,
        "path": path,
        "family": family,
        "group": "Custom Models",
        "step": 999999,
    }
    with open(CUSTOM_MODELS_FILE, "w", encoding="utf-8") as f:
        json.dump(custom, f, indent=4)


def scan_available_models():
    return dict(load_custom_models())


# ─── API: Families ───────────────────────────────────────────

@app.get("/api/families")
async def list_families():
    return JSONResponse(load_families())


@app.post("/api/families/add")
async def add_family(
    name: str = Form(...),
    description: str = Form(""),
    strategy: str = Form(...),
    requirements: str = Form(""),
):
    try:
        key = f"custom_{name.lower().replace(' ', '_').replace('-', '_')}"
        reqs = [r.strip() for r in requirements.split(",") if r.strip()]
        save_custom_family(key, name, description, strategy, reqs)
        return JSONResponse({"status": "success", "key": key})
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@app.delete("/api/families/remove")
async def remove_family(key: str = Form(...)):
    if key in BUILTIN_FAMILIES:
        return JSONResponse(
            {"status": "error", "message": "Yerleşik aile silinemez."},
            status_code=400,
        )
    try:
        custom = {}
        if os.path.exists(FAMILIES_FILE):
            with open(FAMILIES_FILE, "r", encoding="utf-8") as f:
                custom = json.load(f)
        if key in custom:
            del custom[key]
            with open(FAMILIES_FILE, "w", encoding="utf-8") as f:
                json.dump(custom, f, indent=4, ensure_ascii=False)
        return JSONResponse({"status": "success"})
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


# ─── API: Models ─────────────────────────────────────────────

@app.get("/api/models")
async def list_models():
    AVAILABLE_MODELS = scan_available_models()
    grouped = {}
    for key, info in AVAILABLE_MODELS.items():
        group = info["group"]
        if group not in grouped:
            grouped[group] = []
        grouped[group].append({
            "key": key,
            "name": info["name"],
            "step": info["step"],
            "path": info.get("path", ""),
            "family": info.get("family", ""),
        })
    return JSONResponse(grouped)


@app.post("/api/models/add")
async def add_custom_model(
    name: str = Form(...),
    path: str = Form(...),
    family: str = Form(...),
):
    try:
        key = f"custom/{name.replace(' ', '_').lower()}_{int(time.time())}"
        save_custom_model(key, name, path, family)
        return JSONResponse({"status": "success", "key": key})
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@app.put("/api/models/update")
async def update_custom_model(
    key: str = Form(...),
    name: str = Form(...),
    path: str = Form(...),
    family: str = Form(...),
):
    try:
        custom_models = load_custom_models()
        if key not in custom_models:
            return JSONResponse(
                {"status": "error", "message": "Model bulunamadı."},
                status_code=404,
            )
        custom_models[key]["name"] = name
        custom_models[key]["path"] = path
        custom_models[key]["family"] = family
        with open(CUSTOM_MODELS_FILE, "w", encoding="utf-8") as f:
            json.dump(custom_models, f, indent=4)
        return JSONResponse({"status": "success"})
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


@app.delete("/api/models/remove")
async def remove_custom_model(key: str = Form(...)):
    try:
        custom_models = load_custom_models()
        if key in custom_models:
            del custom_models[key]
            with open(CUSTOM_MODELS_FILE, "w", encoding="utf-8") as f:
                json.dump(custom_models, f, indent=4)
            return JSONResponse({"status": "success"})
        else:
            return JSONResponse(
                {"status": "error", "message": "Model bulunamadı."},
                status_code=404,
            )
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=500)


# ─── API: Inference ──────────────────────────────────────────

@app.post("/api/compare")
async def compare(image: UploadFile = File(...), models: str = Form(...), prompt: str = Form(None)):
    if not prompt or prompt.strip() == "":
        prompt = "Bu uzaktan algılama görüntüsünü Türkçe olarak açıklayın."

    contents = await image.read()
    pil_image = Image.open(io.BytesIO(contents)).convert("RGB")
    model_keys = json.loads(models)

    AVAILABLE_MODELS = scan_available_models()
    FAMILIES = load_families()

    valid_keys = [k for k in model_keys if k in AVAILABLE_MODELS]

    async def event_stream():
        loop = asyncio.get_running_loop()

        # Announce loading for all models upfront
        for i, key in enumerate(valid_keys):
            info = AVAILABLE_MODELS[key]
            yield f"data: {json.dumps({'type': 'loading', 'model_key': key, 'model_name': info['name'], 'index': i, 'total': len(valid_keys)})}\n\n"

        # Load all models in parallel
        load_results = {}

        def _load_one(key):
            info = AVAILABLE_MODELS[key]
            model_path = info["path"]
            family_key = info.get("family", "pipeline")
            family_info = FAMILIES.get(family_key, {})
            requirements = family_info.get("requirements", [])
            wrapper = get_wrapper_for_family(family_key, FAMILIES)
            t0 = time.time()
            wrapper.load(model_path, family=family_key, requirements=requirements)
            return wrapper, time.time() - t0

        async def load_parallel(key):
            try:
                wrapper, load_time = await loop.run_in_executor(None, _load_one, key)
                load_results[key] = {"wrapper": wrapper, "load_time": load_time, "error": None}
            except Exception as e:
                load_results[key] = {"wrapper": None, "load_time": 0.0, "error": str(e)}

        await asyncio.gather(*[load_parallel(k) for k in valid_keys])

        # Generate all in parallel, stream results as they arrive
        result_q: asyncio.Queue = asyncio.Queue()

        async def gen_parallel(i, key):
            info = AVAILABLE_MODELS[key]
            lr = load_results[key]

            if lr["error"]:
                await result_q.put({
                    "type": "error", "model_key": key, "model_name": info["name"],
                    "error": lr["error"], "index": i, "total": len(valid_keys),
                })
                return

            wrapper = lr["wrapper"]
            try:
                t1 = time.time()
                caption = await loop.run_in_executor(
                    None, wrapper.generate, pil_image.copy(), prompt
                )
                infer_time = time.time() - t1
                await result_q.put({
                    "type": "result", "model_key": key, "model_name": info["name"],
                    "caption": caption,
                    "load_time": round(lr["load_time"], 1),
                    "infer_time": round(infer_time, 1),
                    "index": i, "total": len(valid_keys),
                })
            except Exception as e:
                await result_q.put({
                    "type": "error", "model_key": key, "model_name": info["name"],
                    "error": str(e), "index": i, "total": len(valid_keys),
                })

        gen_tasks = [
            asyncio.create_task(gen_parallel(i, k))
            for i, k in enumerate(valid_keys)
        ]

        completed = 0
        while completed < len(valid_keys):
            item = await result_q.get()
            yield f"data: {json.dumps(item)}\n\n"
            completed += 1

        await asyncio.gather(*gen_tasks, return_exceptions=True)

        # Unload all loaded models
        async def unload_one(wrapper):
            await loop.run_in_executor(None, wrapper.unload)

        await asyncio.gather(
            *[unload_one(lr["wrapper"]) for lr in load_results.values() if lr["wrapper"]],
            return_exceptions=True,
        )

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Mount static files
app.mount(
    "/",
    StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"), html=True),
    name="static",
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
