@echo off
cd /d "%~dp0"
start "" http://localhost:47310
node server.js
