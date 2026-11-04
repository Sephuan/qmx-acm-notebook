@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
set QMX_USER_DATA_DIR=
cd /d "%~dp0"
if exist "%~dp0release\QMX-Notebook-win32-x64\QMX-Notebook.exe" (
 start "" "%~dp0release\QMX-Notebook-win32-x64\QMX-Notebook.exe" --disable-gpu
) else (
 start "" "%~dp0node_modules\electron\dist\electron.exe" --disable-gpu "%~dp0."
)
