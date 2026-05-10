#!/bin/bash
set -e
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Virtual environment'lar olusturuluyor ==="
mkdir -p "$PROJECT_DIR/venv" "$PROJECT_DIR/logs" "$PROJECT_DIR/.pids"

create_venv() {
    local name=$1
    local req=$2
    local extra=$3
    echo ""
    echo "[$name] Kuruluyor..."
    python3 -m venv "$PROJECT_DIR/venv/$name"
    "$PROJECT_DIR/venv/$name/bin/pip" install --upgrade pip -q
    "$PROJECT_DIR/venv/$name/bin/pip" install -r "$req" -q
    if [ -n "$extra" ]; then
        "$PROJECT_DIR/venv/$name/bin/pip" install $extra -q
    fi
    echo "[$name] Tamam."
}

create_venv "webapp"  "$PROJECT_DIR/docker/webapp/requirements.txt"
create_venv "qwen"    "$PROJECT_DIR/docker/qwen/requirements.txt"
create_venv "rsllava" "$PROJECT_DIR/docker/rsllava/requirements.txt" "einops sentencepiece tiktoken shortuuid peft<=0.6.2"
create_venv "generic" "$PROJECT_DIR/docker/generic/requirements.txt"

echo ""
echo "=== Kurulum tamamlandi! ==="
echo "Baslatmak icin: ./start.sh"
