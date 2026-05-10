#!/bin/bash
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Konfigurasyon ──────────────────────────────────────────────
# RS-LLaVA kaynak kodu konumu (RS-LLaVA'yi kullanmak icin)
export RS_LLAVA_PATH="${RS_LLAVA_PATH:-}"

# HuggingFace cache konumu
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"

# MIG GPU device (H200, 1g.35gb slice)
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-MIG-93d4192b-45e8-58d8-98fe-a960130b7efd}"

# Servis endpoint'leri (degistirme)
export QWEN_ENDPOINT="http://localhost:8001"
export RSLLAVA_ENDPOINT="http://localhost:8002"
export GENERIC_ENDPOINT="http://localhost:8003"
# ──────────────────────────────────────────────────────────────

if [ ! -d "$PROJECT_DIR/venv/webapp" ]; then
    echo "Venv bulunamadi. Once setup.sh calistir:"
    echo "  bash setup.sh"
    exit 1
fi

mkdir -p "$PROJECT_DIR/logs" "$PROJECT_DIR/.pids"

start_service() {
    local name=$1
    local dir=$2
    local port=$3
    local module=$4
    local venv="$PROJECT_DIR/venv/$name"

    echo "Baslatiliyor: $name [:$port]"
    (cd "$dir" && "$venv/bin/uvicorn" "$module" \
        --host 0.0.0.0 --port "$port" \
        > "$PROJECT_DIR/logs/$name.log" 2>&1) &
    echo $! > "$PROJECT_DIR/.pids/$name.pid"
}

start_service "qwen"    "$PROJECT_DIR/docker/qwen"    8001 "server:app"
start_service "rsllava" "$PROJECT_DIR/docker/rsllava"  8002 "server:app"
start_service "generic" "$PROJECT_DIR/docker/generic"  8003 "server:app"
start_service "webapp"  "$PROJECT_DIR/web_app"         8000 "app:app"

echo ""
echo "Tum servisler baslatildi."
echo "  Web UI  : http://localhost:8000"
echo "  Loglar  : tail -f logs/webapp.log"
echo ""
echo "Durdurmak icin: ./stop.sh"
