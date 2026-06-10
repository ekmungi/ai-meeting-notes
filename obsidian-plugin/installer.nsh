; Custom NSIS include for AI Meeting Notes installer.
; After main install, offers to install the Obsidian plugin into a vault.
; User selects their vault root; the installer auto-creates
; <vault>/.obsidian/plugins/ai-meeting-notes/ and drops the plugin files there.

!macro customInstall
  MessageBox MB_YESNO "Would you also like to install the Obsidian plugin?$\n$\nYou will select your Obsidian vault's root folder (not .obsidian)." IDYES installPlugin IDNO skipPlugin

  installPlugin:
    nsDialogs::SelectFolderDialog "Select your Obsidian vault folder (the folder that contains your .obsidian subfolder)" "$PROFILE"
    Pop $0
    StrCmp $0 "" skipPlugin 0

    ; Validate: the selected folder must contain a .obsidian subfolder.
    IfFileExists "$0\.obsidian\*.*" validVault 0
      MessageBox MB_YESNO "The folder you selected does not contain a .obsidian subfolder, so it does not look like an Obsidian vault.$\n$\nInstall anyway? (A .obsidian/plugins folder will be created.)" IDYES validVault IDNO skipPlugin

    validVault:
      CreateDirectory "$0\.obsidian"
      CreateDirectory "$0\.obsidian\plugins"
      CreateDirectory "$0\.obsidian\plugins\ai-meeting-notes"
      CopyFiles /SILENT "$INSTDIR\resources\obsidian-plugin\main.js" "$0\.obsidian\plugins\ai-meeting-notes\main.js"
      CopyFiles /SILENT "$INSTDIR\resources\obsidian-plugin\manifest.json" "$0\.obsidian\plugins\ai-meeting-notes\manifest.json"
      CopyFiles /SILENT "$INSTDIR\resources\obsidian-plugin\styles.css" "$0\.obsidian\plugins\ai-meeting-notes\styles.css"
      MessageBox MB_OK "Obsidian plugin installed to:$\n$0\.obsidian\plugins\ai-meeting-notes$\n$\nRestart Obsidian and enable the plugin in Settings > Community Plugins."

  skipPlugin:
!macroend
