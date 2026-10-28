; Media directories live OUTSIDE $INSTDIR (in the parent folder).
; The installer/uninstaller only touches $INSTDIR, so media is never deleted.
;
; Structure (new installs AND upgrades):
;   .../Kitty App/                ← parent (safe, never wiped)
;       media/                    ← generated media
;       local-media/              ← cached media
;       Kitty Open Studio/          ← $INSTDIR (app files, installer manages this)
;
; Migration from old versions:
;   Old: .../Kitty Open Studio/media/      → New: .../Kitty App/media/
;   Old: .../Kitty Open Studio/local-media/ → New: .../Kitty App/local-media/

!macro customInit
  ; --- Auto-close running Kitty Open Studio before install/upgrade ---
  ; Kill main app + all child processes (Node.js server, etc.)
  nsExec::ExecToLog 'taskkill /F /IM "Kitty Open Studio.exe" /T'
  Sleep 500
  ; Kill any node.exe spawned from our install dir (Next.js server child process)
  ; wmic finds node.exe whose executable path contains "Kitty App" and kills it
  nsExec::ExecToLog 'cmd /c "wmic process where (name="node.exe" and commandline like "%Kitty%") delete"'
  nsExec::ExecToLog 'cmd /c "wmic process where (name="node.exe" and executablepath like "%Kitty App%") delete"'
  ; Also try killing by window title as last resort
  nsExec::ExecToLog 'taskkill /F /FI "WINDOWTITLE eq Kitty Open Studio*" /T'
  Sleep 1000
  ; Final force-kill attempt
  nsExec::ExecToLog 'taskkill /F /IM "Kitty Open Studio.exe" /T'

  ; --- Default install dir for ALL users (new + upgrade) ---
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Kitty App\Kitty Open Studio"

  ; --- Check for existing install to migrate media ---
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" check_hklm found_existing
  check_hklm:
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCmp $0 "" done_init found_existing

  found_existing:
    ; $0 = old install path (e.g. "C:\...\Programs\Kitty Open Studio")
    ; $INSTDIR stays as new path "C:\...\Kitty App\Kitty Open Studio"
    ; Do NOT overwrite $INSTDIR — we want upgrade users to move to new structure

    ; --- Migrate media from OLD install dir to NEW parent ---
    IfFileExists "$0\media\*.*" 0 skip_migrate_media
      ; Move old media → new parent (Kitty App\media)
      CreateDirectory "$INSTDIR\.."
      IfFileExists "$INSTDIR\..\media\*.*" merge_media 0
      Rename "$0\media" "$INSTDIR\..\media"
      IfErrors 0 skip_migrate_media
      ; Rename failed (cross-drive?) — copy instead
      CreateDirectory "$INSTDIR\..\media"
      CopyFiles /SILENT "$0\media\*.*" "$INSTDIR\..\media"
      RMDir /r "$0\media"
      Goto skip_migrate_media
    merge_media:
      ; Target already has media (shouldn't happen, but safe merge)
      CopyFiles /SILENT "$0\media\*.*" "$INSTDIR\..\media"
      RMDir /r "$0\media"
    skip_migrate_media:

    IfFileExists "$0\local-media\*.*" 0 skip_migrate_lm
      CreateDirectory "$INSTDIR\.."
      IfFileExists "$INSTDIR\..\local-media\*.*" merge_lm 0
      Rename "$0\local-media" "$INSTDIR\..\local-media"
      IfErrors 0 skip_migrate_lm
      CreateDirectory "$INSTDIR\..\local-media"
      CopyFiles /SILENT "$0\local-media\*.*" "$INSTDIR\..\local-media"
      RMDir /r "$0\local-media"
      Goto skip_migrate_lm
    merge_lm:
      CopyFiles /SILENT "$0\local-media\*.*" "$INSTDIR\..\local-media"
      RMDir /r "$0\local-media"
    skip_migrate_lm:

    ; Also check if media was already in the OLD parent (from a previous broken migration)
    IfFileExists "$0\..\media\*.*" 0 skip_old_parent_media
      ; Only migrate if it's NOT the same as our new parent
      StrCmp "$0\.." "$INSTDIR\.." skip_old_parent_media 0
      IfFileExists "$INSTDIR\..\media\*.*" skip_old_parent_media 0
      Rename "$0\..\media" "$INSTDIR\..\media"
    skip_old_parent_media:

    IfFileExists "$0\..\local-media\*.*" 0 skip_old_parent_lm
      StrCmp "$0\.." "$INSTDIR\.." skip_old_parent_lm 0
      IfFileExists "$INSTDIR\..\local-media\*.*" skip_old_parent_lm 0
      Rename "$0\..\local-media" "$INSTDIR\..\local-media"
    skip_old_parent_lm:

  done_init:
!macroend

!macro customInstall
  ; Ensure parent media dirs exist (app creates them too, but just in case)
  CreateDirectory "$INSTDIR\..\media"
  CreateDirectory "$INSTDIR\..\local-media"
!macroend

; Uninstaller: nothing to do — media is in parent dir, uninstaller only wipes $INSTDIR
!macro customUnInit
!macroend

!macro customUnInstall
!macroend
