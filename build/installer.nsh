; Chirographum: when uninstalling, ask whether to also delete the user's
; letters, texts and settings (they live in %APPDATA%\Chirographum).
; Updates uninstall the old version silently: they never ask and never delete.
; electron-builder includes this file automatically (build/installer.nsh).

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "¿Borrar también tus letras, tus textos y tus ajustes?$\r$\n$\r$\nSi eliges «No», se quedan guardados en tu ordenador y los recuperarás al volver a instalar Chirographum." IDNO chirographumKeepUserData
        ${if} $installMode == "all"
          SetShellVarContext current
        ${endif}
        RMDir /r "$APPDATA\Chirographum"
        RMDir /r "$APPDATA\chirographum"
        ${if} $installMode == "all"
          SetShellVarContext all
        ${endif}
      chirographumKeepUserData:
    ${EndIf}
  ${endIf}
!macroend
