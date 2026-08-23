; installer.nsh — NSIS customisations. electron-builder includes this file automatically.
;
; PURPOSE: put the app under a publisher folder, `C:\Program Files\VagueDustin Enterprises\<product>`,
; rather than electron-builder's default of `C:\Program Files\<product>`.
;
; There is no config option for this, but the NSIS template reads the default target from the
; `InstallLocation` registry value during `preInit` — before the directory page is shown. Writing that
; value here therefore sets the default the user sees, while leaving them free to change it
; (`allowToChangeInstallationDirectory: true`).
;
; A publisher folder is the Windows convention and it scales: Fatenames, Fated Updates and FATE Reader
; can all live beside this one instead of scattering top-level folders through Program Files.
;
; Both registry views and both hives are written because the template's lookup depends on
; `perMachine` and on the installer's bitness, and a miss silently falls back to the default path.

!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\VagueDustin Enterprises\${PRODUCT_FILENAME}"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\VagueDustin Enterprises\${PRODUCT_FILENAME}"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\VagueDustin Enterprises\${PRODUCT_FILENAME}"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\VagueDustin Enterprises\${PRODUCT_FILENAME}"
  SetRegView 64
!macroend

; Remove the publisher folder on uninstall, but only when it is empty — another VagueDustin product
; may still be installed alongside, and taking its directory with us would be rude.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir "$INSTDIR\.."
  ${endIf}
!macroend
