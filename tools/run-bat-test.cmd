@echo off
rem Test helper: runs the launcher .bat in the project root on the given port, avoiding non-ASCII names on the command line.
rem A port is required so that a test can never touch the default port 8091.
if "%~1"=="" (echo usage: run-bat-test.cmd PORT& exit /b 1)
if "%~1"=="8091" (echo refusing to test on 8091& exit /b 1)
cd /d "%~dp0.."
for %%f in (*.bat) do call "%%f" %~1
