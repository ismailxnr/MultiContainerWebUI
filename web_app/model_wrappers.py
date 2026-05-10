import os
import io
import base64
import httpx
from abc import ABC, abstractmethod
from PIL import Image


class BaseVLM(ABC):
    @abstractmethod
    def load(self, model_path: str, **kwargs):
        pass

    @abstractmethod
    def generate(self, pil_image: Image.Image, prompt: str) -> str:
        pass

    @abstractmethod
    def unload(self):
        pass


class RemoteVLMWrapper(BaseVLM):
    def __init__(self, endpoint: str):
        self.endpoint = endpoint
        self.model_path = None
        self.client = httpx.Client(
            timeout=httpx.Timeout(connect=30.0, read=3600.0, write=60.0, pool=30.0)
        )

    def load(self, model_path: str, family: str = None, requirements: list = None):
        self.model_path = model_path
        payload = {"model_path": model_path}
        if family:
            payload["family"] = family
        if requirements:
            payload["requirements"] = requirements
        response = self.client.post(f"{self.endpoint}/load", json=payload)
        if response.status_code != 200:
            raise RuntimeError(f"Failed to load model remotely: {response.text}")

    def generate(self, pil_image: Image.Image, prompt: str) -> str:
        buffered = io.BytesIO()
        pil_image.save(buffered, format="JPEG")
        img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")

        response = self.client.post(f"{self.endpoint}/generate", json={
            "model_path": self.model_path,
            "image_base64": img_str,
            "prompt": prompt,
        })
        if response.status_code != 200:
            raise RuntimeError(f"Inference failed: {response.text}")
        return response.json().get("caption", "")

    def unload(self):
        try:
            payload = {}
            if self.model_path:
                payload["model_path"] = self.model_path
            response = self.client.post(f"{self.endpoint}/unload", json=payload)
            if response.status_code != 200:
                print(f"Warning: Failed to unload remotely: {response.text}")
        except Exception as e:
            print(f"Warning: Failed to reach remote for unload: {e}")


def get_wrapper_for_family(family: str, families: dict = None) -> BaseVLM:
    if families and family in families:
        endpoint_type = families[family].get("endpoint_type", "generic")
    else:
        if family in ("rsllava", "llava"):
            endpoint_type = "rsllava"
        elif family in ("qwenvl", "qwen"):
            endpoint_type = "qwen"
        else:
            endpoint_type = "generic"

    if endpoint_type == "rsllava":
        endpoint = os.environ.get("RSLLAVA_ENDPOINT", "http://localhost:8002")
    elif endpoint_type == "qwen":
        endpoint = os.environ.get("QWEN_ENDPOINT", "http://localhost:8001")
    else:
        endpoint = os.environ.get("GENERIC_ENDPOINT", "http://localhost:8003")

    return RemoteVLMWrapper(endpoint)
