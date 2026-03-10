@echo off
REM Build AI Meeting Notes
REM Usage: build.bat [server|plugin|desktop|installer|all] [--force]  (default: desktop)
REM Requires: pip install pyinstaller (for server/plugin targets)
REM Output:   ..\releases\
REM
REM Targets:
REM   server    - Build the Python backend server exe
REM   plugin    - Build Obsidian plugin + standalone plugin installer exe
REM   desktop   - Build Electron desktop app (NSIS installer)
REM   installer - Build everything: server + plugin + desktop (recommended)
REM   all       - Same as installer
REM
REM Flags:
REM   --force   - Rebuild even if output already exists (skip detection off)

cd /d "%~dp0"

set TARGET=%1
if "%TARGET%"=="" set TARGET=desktop
set RELEASES=%~dp0..\releases

REM Check for --force flag in any argument position
set FORCE=0
for %%A in (%*) do (
    if /i "%%A"=="--force" set FORCE=1
)

if /i "%TARGET%"=="installer" goto build_all
if /i "%TARGET%"=="all" goto build_all
goto skip_all

:build_all
    echo ============================================
    echo  Building AI Meeting Notes - Full Installer
    echo ============================================
    echo.
    call "%~f0" server %2
    if %ERRORLEVEL% NEQ 0 exit /b 1
    call "%~f0" plugin %2
    if %ERRORLEVEL% NEQ 0 exit /b 1
    call "%~f0" desktop %2
    if %ERRORLEVEL% NEQ 0 exit /b 1
    echo.
    echo ============================================
    echo  All builds complete!
    echo ============================================
    echo  Installer: %RELEASES%\AI Meeting Notes Desktop\AI Meeting Notes Setup *.exe
    echo  Server:    %RELEASES%\ai-meeting-notes-server\ai-meeting-notes-server.exe
    echo  Plugin:    %RELEASES%\AI Meeting Notes Plugin Installer.exe
    echo ============================================
    exit /b 0

:skip_all

if /i "%TARGET%"=="server" (
    if %FORCE%==0 (
        if exist "%RELEASES%\ai-meeting-notes-server\ai-meeting-notes-server.exe" (
            echo [SKIP] Server exe already exists. Use --force to rebuild.
            exit /b 0
        )
    )
    echo Building AI Meeting Notes Server...
    pyinstaller meeting_notes_server.spec --noconfirm --clean --distpath "%RELEASES%"
    if %ERRORLEVEL% EQU 0 (
        echo.
        echo Build successful!
        echo Output: %RELEASES%\ai-meeting-notes-server\ai-meeting-notes-server.exe
    ) else (
        echo Build failed. Check errors above.
        exit /b 1
    )
) else if /i "%TARGET%"=="plugin" (
    if %FORCE%==0 (
        if exist "%RELEASES%\AI Meeting Notes Plugin Installer.exe" (
            echo [SKIP] Plugin installer already exists. Use --force to rebuild.
            exit /b 0
        )
    )
    echo Building Obsidian Plugin Installer...
    cd /d "%~dp0..\obsidian-plugin"
    call npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo Plugin build failed.
        exit /b 1
    )
    cd /d "%~dp0..\obsidian-plugin\installer"
    pyinstaller installer.spec --noconfirm --clean --distpath "%RELEASES%"
    if %ERRORLEVEL% EQU 0 (
        echo.
        echo Build successful!
        echo Output: %RELEASES%\AI Meeting Notes Plugin Installer.exe
    ) else (
        echo Build failed. Check errors above.
        exit /b 1
    )
) else if /i "%TARGET%"=="desktop" (
    echo Building Electron Desktop App...
    cd /d "%~dp0..\obsidian-plugin"
    REM Build Obsidian plugin (main.js) -- bundled into NSIS installer
    call npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo Plugin build failed.
        exit /b 1
    )
    call npx tsc -p tsconfig.desktop.json
    if %ERRORLEVEL% NEQ 0 (
        echo TypeScript compilation failed.
        exit /b 1
    )
    REM Copy renderer assets to dist
    xcopy /s /y /q src\desktop\renderer\* dist-desktop\desktop\renderer\ >nul
    REM CSC_IDENTITY_AUTO_DISCOVERY=false disables code signing (no cert configured)
    set CSC_IDENTITY_AUTO_DISCOVERY=false
    call npx electron-builder --win --config electron-builder.json
    if %ERRORLEVEL% EQU 0 (
        echo.
        echo Build successful!
        echo Output: %RELEASES%\AI Meeting Notes Desktop\
    ) else (
        echo Build failed. Check errors above.
        exit /b 1
    )
) else (
    echo Unknown target: %TARGET%
    echo Usage: build.bat [server^|plugin^|desktop^|installer^|all] [--force]
    exit /b 1
)
