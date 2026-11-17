@echo off
chcp 65001 >nul
title Google Earth Pro 本地复刻版 - 服务窗口
cd /d "%~dp0"
set "PORT=8091"
if not "%~1"=="" set "PORT=%~1"

echo.
echo  [1/3] 清理占用端口 %PORT% 的残留进程...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not "%%p"=="0" taskkill /F /PID %%p >nul 2>nul
)

where node >nul 2>nul
if not errorlevel 1 (
  echo  [2/3] 启动本地服务...
  echo  [3/3] 服务就绪后自动打开浏览器 http://localhost:%PORT%/
  node server.js --port %PORT% --open
  echo.
  echo  服务已停止。
  pause
  exit /b
)

where python >nul 2>nul
if not errorlevel 1 (
  echo  [2/3] 未找到 Node.js，改用 Python 启动本地服务...
  echo  [3/3] 两秒后打开浏览器 http://localhost:%PORT%/
  start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%/"
  python -m http.server %PORT% --bind 127.0.0.1
  echo.
  echo  服务已停止。
  pause
  exit /b
)

echo.
echo  [错误] 没有找到 Node.js 或 Python，无法启动本地服务。
echo  请先安装 Node.js，下载地址 https://nodejs.org ，装好后再双击本文件。
echo.
pause
