# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Obsidian plugin installer — single-file exe."""

from pathlib import Path

plugin_dir = Path("..").resolve()

a = Analysis(
    ["installer.py"],
    pathex=[],
    binaries=[],
    datas=[
        (str(plugin_dir / "main.js"), "plugin_files"),
        (str(plugin_dir / "manifest.json"), "plugin_files"),
        (str(plugin_dir / "styles.css"), "plugin_files"),
    ],
    hiddenimports=[],
    hookspath=[],
    excludes=["matplotlib", "scipy", "pandas", "PIL", "numpy"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="AI Meeting Notes Plugin Installer",
    debug=False,
    strip=False,
    upx=True,
    console=False,
    icon=str(plugin_dir / "icon.png") if (plugin_dir / "icon.png").exists() else None,
)
