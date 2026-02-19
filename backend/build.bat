@echo off
REM Build AI Meeting Notes portable bundle
REM Usage: build.bat [gui|server]  (default: gui)
REM Requires: pip install pyinstaller

cd /d "%~dp0"

set TARGET=%1
if "%TARGET%"=="" set TARGET=gui

if /i "%TARGET%"=="gui" (
    echo Building AI Meeting Notes GUI...
    pyinstaller meeting_notes_gui.spec --noconfirm --clean
    if %ERRORLEVEL% EQU 0 (
        echo.
        echo Build successful!
        echo Output: dist\AI Meeting Notes\
        echo Run: "dist\AI Meeting Notes\AI Meeting Notes.exe"
    ) else (
        echo.
        echo Build failed. Check errors above.
        exit /b 1
    )
) else if /i "%TARGET%"=="server" (
    echo Building AI Meeting Notes Server...
    pyinstaller meeting_notes_server.spec --noconfirm --clean
    if %ERRORLEVEL% EQU 0 (
        echo.
        echo Build successful!
        echo Output: dist\ai-meeting-notes-server\
        echo Run: "dist\ai-meeting-notes-server\ai-meeting-notes-server.exe" --server
    ) else (
        echo.
        echo Build failed. Check errors above.
        exit /b 1
    )
) else (
    echo Unknown target: %TARGET%
    echo Usage: build.bat [gui^|server]
    exit /b 1
)
