; Chirographum: the installer creates "Chirographum documents" in Documents,
; and the first page of the uninstaller has a checkbox to also
; delete the user's letters, texts and settings (%APPDATA%\Chirographum).
; Unticked by default. Updates uninstall the old version silently: they
; never show the page and never delete anything.
; electron-builder includes this file automatically (build/installer.nsh).
; Everything is defined inside the macros, which are only expanded while
; building the uninstaller, after MUI2 and nsDialogs are loaded.

!macro customUnWelcomePage
  !include nsDialogs.nsh
  Var chirographumDeleteData
  Var chirographumCheckbox

  UninstPage custom un.chirographumDataPage un.chirographumDataPageLeave

  Function un.chirographumDataPage
    !insertmacro MUI_HEADER_TEXT "Desinstalar Chirographum" "Chirographum se quitará de este ordenador."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 56u "Tus letras, tus textos y tus ajustes se guardan aparte, en tu carpeta de usuario. Si no marcas la casilla, se quedan en el ordenador y los recuperarás al volver a instalar Chirographum.$\r$\n$\r$\nLos documentos de la carpeta «Chirographum documents» no se borran nunca."
    Pop $0
    ${NSD_CreateCheckbox} 0 64u 100% 12u "Borrar también mis letras, mis textos y mis ajustes"
    Pop $chirographumCheckbox
    ${If} $chirographumDeleteData == ${BST_CHECKED}
      ${NSD_Check} $chirographumCheckbox
    ${EndIf}
    ; The button goes straight to uninstalling, so say so.
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Desinstalar"
    nsDialogs::Show
  FunctionEnd

  Function un.chirographumDataPageLeave
    ${NSD_GetState} $chirographumCheckbox $chirographumDeleteData
  FunctionEnd
!macroend

; The folder where Ctrl+S saves new documents, in the user's own Documents
; (also when installing for all users). The app creates it again if it is
; missing. The uninstaller never deletes it: those are the user's documents.
!macro customInstall
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  CreateDirectory "$DOCUMENTS\Chirographum documents"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} $chirographumDeleteData == ${BST_CHECKED}
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
      RMDir /r "$APPDATA\Chirographum"
      RMDir /r "$APPDATA\chirographum"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    ${endif}
  ${endIf}
!macroend
