@echo off
echo =======================================================
echo Starting EcomAI-OS FastAPI Backend on http://localhost:8000
echo Interactive API docs at http://localhost:8000/docs
echo =======================================================
.\.venv\Scripts\uvicorn.exe backend.main:app --host 0.0.0.0 --port 8000 --reload
pause
