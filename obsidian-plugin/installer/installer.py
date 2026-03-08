"""Obsidian AI Meeting Notes Plugin Installer — standalone GUI installer."""

import shutil
import sys
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox

PLUGIN_ID = "obsidian-ai-meeting-notes"
PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"]


def get_bundle_dir() -> Path:
    """Return the directory containing bundled plugin files."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "plugin_files"
    return Path(__file__).parent.parent


def find_obsidian_vaults() -> list[Path]:
    """Auto-detect Obsidian vault locations from the Obsidian config."""
    config_path = Path.home() / "AppData" / "Roaming" / "obsidian" / "obsidian.json"
    vaults: list[Path] = []
    if config_path.exists():
        import json
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
            for info in data.get("vaults", {}).values():
                vault_path = Path(info.get("path", ""))
                if vault_path.exists() and (vault_path / ".obsidian").exists():
                    vaults.append(vault_path)
        except (json.JSONDecodeError, KeyError):
            pass
    return vaults


def install_plugin(vault_path: Path, bundle_dir: Path) -> str:
    """Copy plugin files to the vault's plugins directory."""
    obsidian_dir = vault_path / ".obsidian"
    if not obsidian_dir.exists():
        return f"Not a valid Obsidian vault:\n{vault_path}"

    dest = obsidian_dir / "plugins" / PLUGIN_ID
    dest.mkdir(parents=True, exist_ok=True)

    copied = []
    for fname in PLUGIN_FILES:
        src = bundle_dir / fname
        if src.exists():
            shutil.copy2(src, dest / fname)
            copied.append(fname)

    if not copied:
        return "No plugin files found in installer bundle."

    return ""


class InstallerApp:
    """Tkinter GUI for the plugin installer."""

    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("AI Meeting Notes — Plugin Installer")
        self.root.resizable(False, False)
        self.root.configure(bg="#1e1e1e")
        self._center_window(420, 320)
        self.bundle_dir = get_bundle_dir()
        self.vaults = find_obsidian_vaults()
        self._build_ui()

    def _center_window(self, w: int, h: int) -> None:
        x = (self.root.winfo_screenwidth() - w) // 2
        y = (self.root.winfo_screenheight() - h) // 2
        self.root.geometry(f"{w}x{h}+{x}+{y}")

    def _build_ui(self) -> None:
        bg = "#1e1e1e"
        fg = "#e0e0e0"
        accent = "#4a9eff"
        btn_bg = "#2d2d2d"

        # Header
        tk.Label(
            self.root, text="AI Meeting Notes", font=("Segoe UI", 16, "bold"),
            bg=bg, fg=fg,
        ).pack(pady=(20, 2))
        tk.Label(
            self.root, text="Obsidian Plugin Installer", font=("Segoe UI", 10),
            bg=bg, fg="#888",
        ).pack(pady=(0, 15))

        # Vault selection
        frame = tk.Frame(self.root, bg=bg)
        frame.pack(fill="x", padx=30)

        tk.Label(
            frame, text="Select vault:", font=("Segoe UI", 9),
            bg=bg, fg=fg, anchor="w",
        ).pack(fill="x")

        if self.vaults:
            self.vault_var = tk.StringVar(value=str(self.vaults[0]))
            dropdown = tk.OptionMenu(
                frame, self.vault_var, *[str(v) for v in self.vaults],
            )
            dropdown.configure(
                bg=btn_bg, fg=fg, font=("Segoe UI", 9),
                activebackground="#3d3d3d", activeforeground=fg,
                highlightthickness=0, relief="flat",
            )
            dropdown["menu"].configure(bg=btn_bg, fg=fg, font=("Segoe UI", 9))
            dropdown.pack(fill="x", pady=(4, 0))
        else:
            self.vault_var = tk.StringVar(value="")
            tk.Label(
                frame, text="No vaults auto-detected", font=("Segoe UI", 9),
                bg=bg, fg="#888",
            ).pack(fill="x", pady=(4, 0))

        # Browse button
        browse_btn = tk.Button(
            frame, text="Browse...", font=("Segoe UI", 9),
            bg=btn_bg, fg=fg, relief="flat", cursor="hand2",
            activebackground="#3d3d3d", activeforeground=fg,
            command=self._browse,
        )
        browse_btn.pack(fill="x", pady=(8, 0), ipady=2)

        # Install button
        install_btn = tk.Button(
            self.root, text="Install Plugin", font=("Segoe UI", 11, "bold"),
            bg=accent, fg="#fff", relief="flat", cursor="hand2",
            activebackground="#3a8ae6", activeforeground="#fff",
            command=self._install,
        )
        install_btn.pack(fill="x", padx=30, pady=(20, 0), ipady=6)

        # Status label
        self.status_var = tk.StringVar(value="")
        tk.Label(
            self.root, textvariable=self.status_var, font=("Segoe UI", 9),
            bg=bg, fg="#888", wraplength=360,
        ).pack(pady=(10, 0))

    def _browse(self) -> None:
        path = filedialog.askdirectory(title="Select Obsidian Vault Folder")
        if path:
            self.vault_var.set(path)

    def _install(self) -> None:
        vault = self.vault_var.get().strip()
        if not vault:
            messagebox.showwarning("No vault selected", "Please select an Obsidian vault folder.")
            return

        vault_path = Path(vault)
        error = install_plugin(vault_path, self.bundle_dir)
        if error:
            messagebox.showerror("Installation Failed", error)
            return

        self.status_var.set(f"Installed to: {vault_path.name}/.obsidian/plugins/{PLUGIN_ID}/")
        messagebox.showinfo(
            "Installation Complete",
            f"Plugin installed successfully!\n\n"
            f"Restart Obsidian and enable '{PLUGIN_ID}'\n"
            f"in Settings > Community Plugins.",
        )

    def run(self) -> None:
        self.root.mainloop()


if __name__ == "__main__":
    InstallerApp().run()
