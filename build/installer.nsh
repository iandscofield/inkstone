; Custom installer steps (picked up automatically by electron-builder).
; Inkstone registers itself as an "Open with" choice for PDFs but leaves the
; user's default PDF app alone, and quotes its path in the open command.

!macro customInit
  ; Remember the current .pdf default class so it can be put back after the
  ; standard association step overwrites it.
  ReadRegStr $0 HKCU "Software\Classes\.pdf" ""
  StrCmp $0 "Inkstone.Document" 0 +2
    StrCpy $0 ""
  WriteRegStr HKCU "Software\Inkstone\Install" "PrevPdfClass" "$0"
!macroend

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Inkstone.Document\shell\open\command" "" '"$appExe" "%1"'
  ReadRegStr $0 HKCU "Software\Inkstone\Install" "PrevPdfClass"
  StrCmp $0 "" 0 +3
    DeleteRegValue HKCU "Software\Classes\.pdf" ""
    Goto +2
  WriteRegStr HKCU "Software\Classes\.pdf" "" "$0"
  DeleteRegKey HKCU "Software\Inkstone\Install"
  DeleteRegKey /ifempty HKCU "Software\Inkstone"
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Classes\.pdf" ""
  StrCmp $0 "Inkstone.Document" 0 +2
    DeleteRegValue HKCU "Software\Classes\.pdf" ""
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "Inkstone.Document"
!macroend
