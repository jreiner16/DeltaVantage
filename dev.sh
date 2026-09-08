set -e

export PATH="$HOME/.local/bin:$PATH"

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Starting FastAPI backend on :8000…"
python3 -m uvicorn server.main:app --host 0.0.0.0 --port 8000 &
BACK_PID=$!

echo "Starting Vite dev server on :5173…"
(cd "$ROOT/frontend" && npx vite --host 0.0.0.0 --port 5173) &
FRONT_PID=$!

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Delta Vantage is running!                       ║"
echo "║                                                  ║"
echo "║  Frontend:  http://localhost:5173                ║"
echo "║  API docs:  http://localhost:8000/docs           ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

trap "kill $BACK_PID $FRONT_PID 2>/dev/null; exit 0" INT TERM
wait
