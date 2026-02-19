# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for AI Meeting Notes Server — onedir bundle (headless)."""

from pathlib import Path

block_cipher = None

src_root = Path("src")

a = Analysis(
    [str(src_root / "meeting_notes" / "__main__.py")],
    pathex=[str(src_root)],
    binaries=[],
    datas=[],
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
        "meeting_notes.connectivity",
        "meeting_notes.server",
        "meeting_notes.server.app",
        "meeting_notes.server.models",
        "meeting_notes.server.server_runner",
        "meeting_notes.server.ws",
        "fastapi",
        "fastapi.routing",
        "fastapi.middleware",
        "fastapi.middleware.cors",
        "uvicorn",
        "uvicorn.config",
        "uvicorn.main",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "starlette",
        "starlette.routing",
        "starlette.responses",
        "starlette.websockets",
        "websockets",
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
        "webview",
        "clr_loader",
        "pythonnet",
        "meeting_notes.ui",
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
    name="ai-meeting-notes-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="ai-meeting-notes-server",
)
