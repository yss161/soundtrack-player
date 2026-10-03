@echo off
chcp 65001 >nul
title 声轨 Soundtrack 音乐播放器
cd /d "%~dp0"

rem ── 查找 Python 3.10+ ──────────────────────────────
set "PY="
py -3 -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>&1 && set "PY=python"
if not defined PY (
    echo [错误] 未找到 Python 3.10 或更高版本。
    echo        请先安装 Python: https://www.python.org/downloads/
    echo        安装时勾选 "Add Python to PATH"。
    pause
    exit /b 1
)

rem ── 检查 musicdl 源码 ──────────────────────────────
if exist "musicdl-master\musicdl\__init__.py" goto deps
if exist "vendor\musicdl\__init__.py" goto deps
echo [提示] 未在本目录找到 musicdl 源码（musicdl-master 或 vendor 文件夹）。
echo        将尝试使用已安装的 musicdl 包，若搜索异常请按下述方式放置源码：
echo        下载 musicdl 源码 zip 并解压，把 musicdl-master 文件夹放进本目录。
echo.

:deps
rem ── 首次运行自动安装依赖（清华镜像） ────────────────
%PY% -c "import flask, requests, click, rich, mutagen, tinytag, bs4" >nul 2>&1
if errorlevel 1 (
    echo [初始化] 正在安装依赖，仅首次需要，约 1-3 分钟 ...
    %PY% -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

rem ── 启动（app.py 会自动打开浏览器） ────────────────
echo [启动] 声轨 Soundtrack 即将启动，浏览器将自动打开 http://127.0.0.1:5000
echo        关闭本窗口即退出播放器。
%PY% app.py
pause
