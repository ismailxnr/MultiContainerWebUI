#!/bin/bash
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for pid_file in "$PROJECT_DIR/.pids"/*.pid; do
    [ -f "$pid_file" ] || continue
    pid=$(cat "$pid_file")
    name=$(basename "$pid_file" .pid)
    if kill -0 "$pid" 2>/dev/null; then
        echo "Durduruluyor: $name (PID $pid)"
        kill "$pid"
    fi
    rm -f "$pid_file"
done

echo "Tum servisler durduruldu."
