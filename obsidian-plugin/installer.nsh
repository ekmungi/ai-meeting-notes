; Custom NSIS include for AI Meeting Notes installer.
; After main install, offers to copy the Obsidian plugin into a vault.

!macro customInstall
  MessageBox MB_YESNO "Would you also like to install the Obsidian plugin?$\n$\nYou will need to select your vault's .obsidian\plugins folder." IDYES installPlugin IDNO skipPlugin

  installPlugin:
    nsDialogs::SelectFolderDialog "Select your vault's .obsidian\plugins folder" "$PROFILE"
    Pop $0
    StrCmp $0 "" skipPlugin 0
    CreateDirectory "$0\ai-meeting-notes"
    CopyFiles /SILENT "$INSTDIR\resources\obsidian-plugin\main.js" "$0\ai-meeting-notes\main.js"
    CopyFiles /SILENT "$INSTDIR\resources\obsidian-plugin\manifest.json" "$0\ai-meeting-notes\manifest.json"
    CopyFiles /SILENT "$INSTDIR\resources\obsidian-plugin\styles.css" "$0\ai-meeting-notes\styles.css"
    MessageBox MB_OK "Obsidian plugin installed to:$\n$0\ai-meeting-notes$\n$\nRestart Obsidian and enable the plugin in Settings > Community Plugins."

  skipPlugin:
!macroend
