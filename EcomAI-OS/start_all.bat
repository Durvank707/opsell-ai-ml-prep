@echo off
echo ==========================================================
echo Launching EcomAI-OS: FastAPI Backend + React Dashboard
echo ==========================================================
start "EcomAI-OS FastAPI Backend" cmd /k ".\start_backend.bat"
start "EcomAI-OS React Frontend" cmd /k ".\start_frontend.bat"
echo Both servers launched in separate windows!
echo Backend:  http://localhost:8000 (Docs: http://localhost:8000/docs)
echo Frontend: http://localhost:5173
