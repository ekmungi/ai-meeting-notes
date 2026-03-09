@echo off
REM Build AI Meeting Notes portable bundle
REM Usage: build.bat [gui|server|plugin|all]  (default: gui)
REM Requires: pip install pyinstaller
REM Output:   ..\releases\

cd /d "%~dp0"

set TARGET=%1
if "%TARGET%"=="" set TARGET=gui
set RELEASES=%~dp0..\releases

if /i "%TARGET%"=="all" (
    call "%~f0" gui
    if %ERRORLEVEL% NEQ 0 exit /b 1
    call "%~f0" server
    if %ERRORLEVEL% NEQ 0 exit /b 1
    call "%~f0" plugin
    if %ERRORLEVEL% NEQ 0 exit /b 1
    call "%~f0" desktop
    exit /b %ERRORLEVEL%
)

if /i "%TARGET%"=="gui" (
    echo Building AI Meeting Notes GUI...
    pyinstaller meeting_notes_gui.spec --noconfirm --clean --distpath "%RELEASES%"
    if %ERRORLEVEL% EQU 0 (
        echo.
        echo Build successful!
        echo Output: %RELEASES%\AI Meeting Notes\AI Meeting Notes.exe
    ) else (
        echo Build failed. Check errors above.
        exit /b 1
    )
) else if /i "%TARGET%"=="server" (
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
    call npx tsc -p tsconfig.desktop.json
    if %ERRORLEVEL% NEQ 0 (
        echo TypeScript compilation failed.
        exit /b 1
    )
    REM Copy renderer assets to dist
    xcopy /s /y /q src\desktop\renderer\* dist-desktop\desktop\renderer\ >nul
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
    echo Usage: build.bat [gui^|server^|plugin^|desktop^|all]
    exit /b 1
)
