# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for AI Meeting Notes GUI — onedir bundle."""

import os
import sys
from pathlib import Path

block_cipher = None

# Paths
src_root = Path("src")
ui_web = src_root / "meeting_notes" / "ui" / "web"

a = Analysis(
    [str(src_root / "meeting_notes" / "ui" / "app.py")],
    pathex=[str(src_root)],
    binaries=[],
    datas=[
        (str(ui_web / "index.html"), "meeting_notes/ui/web"),
        (str(ui_web / "styles.css"), "meeting_notes/ui/web"),
        (str(ui_web / "app.js"), "meeting_notes/ui/web"),
        (str(ui_web / "icon.png"), "meeting_notes/ui/web"),
    ],
    hiddenimports=[
        "meeting_notes",
        "meeting_notes.config",
        "meeting_notes.session",
        "meeting_notes.audio",
        "meeting_notes.audio.capture",
        "meeting_notes.audio.devices",
        "meeting_notes.engines",
        "meeting_notes.engines.base",
        "meeting_notes.engines.cloud",
        "meeting_notes.engines.local",
        "meeting_notes.engines.selector",
        "meeting_notes.output",
        "meeting_notes.output.markdown",
        "meeting_notes.ui",
        "meeting_notes.ui.api",
        "meeting_notes.ui.app",
        "meeting_notes.ui.config_bridge",
        "meeting_notes.ui.session_runner",
        "meeting_notes.ui.settings_store",
        "meeting_notes.connectivity",
        "webview",
        "clr_loader",
        "pythonnet",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib",
        "scipy",
        "pandas",
        "PIL",
        "IPython",
        "jupyter",
        "notebook",
    ],
    noarchive=False,
    optimize=0,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="AI Meeting Notes",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,  # No console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ui_web / "icon.png"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="AI Meeting Notes",
)
