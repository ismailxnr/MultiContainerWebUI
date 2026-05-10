FROM docker.io/python:3.10-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /workspace/web_app

RUN pip install --no-cache-dir fastapi uvicorn pillow httpx python-multipart

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
