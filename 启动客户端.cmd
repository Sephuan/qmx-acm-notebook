@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if exist "release\QMX-Notebook-win32-x64\QMX-Notebook.exe" (
 start "" "release\QMX-Notebook-win32-x64\QMX-Notebook.exe" --disable-gpu
) else (
 start "" "node_modules\electron\dist\electron.exe" --disable-gpu "%~dp0."
)
