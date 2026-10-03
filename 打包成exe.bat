@echo off
chcp 65001 >nul
title 打包声轨 Soundtrack 为 exe
cd /d "%~dp0"

set "PY="
py -3 -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys; assert sys.version_info >= (3, 10)" >nul 2>&1 && set "PY=python"
if not defined PY (
    echo [错误] 未找到 Python 3.10 或更高版本。
    pause
    exit /b 1
)

%PY% -c "import PyInstaller" >nul 2>&1
if errorlevel 1 (
    echo [初始化] 正在安装 PyInstaller ...
    %PY% -m pip install pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple
    if errorlevel 1 (
        echo [错误] PyInstaller 安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

rem ── musicdl 源码搜索路径（优先本地解压的源码，防止 site-packages 旧版混入）──
set "MUSICDL_PATHS=.;.."
if exist "%~dp0musicdl-master\musicdl\__init__.py" set "MUSICDL_PATHS=%MUSICDL_PATHS%;%~dp0musicdl-master"
if exist "%~dp0vendor\musicdl\__init__.py" set "MUSICDL_PATHS=%MUSICDL_PATHS%;%~dp0vendor"

echo [打包] 开始构建 exe（约 1-2 分钟，产物在 dist\Soundtrack.exe）...
%PY% -m PyInstaller --noconfirm --clean --onefile --name Soundtrack ^
    --paths "%MUSICDL_PATHS%" ^
    --add-data "static;static" ^
    --collect-submodules musicdl ^
    --exclude-module nodejs_wheel ^
    --exclude-module tkinter ^
    --distpath dist --workpath build --specpath . ^
    app.py
if errorlevel 1 (
    echo [错误] 打包失败，请把上方报错信息反馈给开发者。
    pause
    exit /b 1
)

echo.
echo [完成] 生成: %~dp0dist\Soundtrack.exe
echo        双击即可运行（首次启动需解压，稍等几秒），下载的文件保存在 exe 旁边的 downloads\ 目录。
echo        提示: 打包前请先卸载 pip 里的旧版 musicdl（pip uninstall musicdl），避免旧代码被打进包里。
pause
