# Obsidian AI Meeting Notes Plugin Installer
# Builds the plugin and copies it to a selected Obsidian vault.

param([string]$VaultPath)

$ErrorActionPreference = "Stop"
$PluginId = "obsidian-ai-meeting-notes"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Build ---
Write-Host "`n  Building plugin..." -ForegroundColor Cyan
Push-Location $ScriptDir
try {
    npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Build failed. Run 'npm run build' manually to see errors." -ForegroundColor Red
        exit 1
    }
    Write-Host "  Build successful." -ForegroundColor Green
} finally {
    Pop-Location
}

# --- Select vault folder ---
if (-not $VaultPath) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Select your Obsidian vault folder"
    $dialog.ShowNewFolderButton = $false
    $dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer

    $result = $dialog.ShowDialog()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
        Write-Host "`n  Installation cancelled." -ForegroundColor Yellow
        exit 0
    }
    $VaultPath = $dialog.SelectedPath
}

# --- Validate vault ---
$pluginsDir = Join-Path $VaultPath ".obsidian\plugins"
if (-not (Test-Path (Join-Path $VaultPath ".obsidian"))) {
    Write-Host "`n  '$VaultPath' does not appear to be an Obsidian vault (.obsidian folder not found)." -ForegroundColor Red
    exit 1
}

# --- Copy files ---
$destDir = Join-Path $pluginsDir $PluginId
if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
}

$files = @("main.js", "manifest.json", "styles.css")
foreach ($file in $files) {
    $src = Join-Path $ScriptDir $file
    if (Test-Path $src) {
        Copy-Item $src -Destination $destDir -Force
        Write-Host "  Copied $file" -ForegroundColor Gray
    }
}

Write-Host "`n  Plugin installed to: $destDir" -ForegroundColor Green
Write-Host "  Restart Obsidian and enable '$PluginId' in Settings > Community Plugins.`n" -ForegroundColor Cyan
