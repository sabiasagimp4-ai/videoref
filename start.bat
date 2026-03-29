@echo off
echo.
echo  Eagle Modoki - 起動中...
echo.
cd /d "D:\claude\eagle-app"

:: FFmpegのパスを通す
set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin"

node server.js
pause
