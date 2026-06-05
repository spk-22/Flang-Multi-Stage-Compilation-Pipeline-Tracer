#!/usr/bin/env bash
set -e

# Activate the virtual environment
source .venv/bin/activate

# Optional port argument, default to 8000
PORT=${1:-8000}

# Start the FastAPI server in the background
uvicorn flang_tracer.server:app --host 0.0.0.0 --port $PORT &
SERVER_PID=$!

# Give the server a moment to start
sleep 2

if command -v explorer.exe > /dev/null; then
  explorer.exe "http://localhost:8000"
elif command -v xdg-open > /dev/null; then
  xdg-open "http://localhost:8000"
elif command -v open > /dev/null; then
  open "http://localhost:8000"
fi

# Wait for the server process to finish (keeps the script running)
wait $SERVER_PID
