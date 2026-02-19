@echo off
REM Run AI Meeting Notes
REM Usage: run.bat [arguments]
REM   run.bat                      - Start recording (auto engine)
REM   run.bat --list-devices       - List audio devices
REM   run.bat --engine cloud       - Force cloud transcription
REM   run.bat --engine cloud -v    - Verbose cloud transcription
REM
REM Requires Python 3.12+ with project dependencies installed.
REM See README.md for installation instructions.

cd /d "%~dp0backend"
python -m meeting_notes %*
