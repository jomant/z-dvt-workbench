; Z-DVT Workbench setup. Built by installer\build.ps1.

#ifndef AppVersion
  #define AppVersion "2026.9.0"
#endif

#define AppName "Z-DVT Workbench"

[Setup]
AppId={{A7E3C1B4-5D28-4F0A-9C6E-2B8F4D0E1A73}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Z-Jomant Meister
AppPublisherURL=https://github.com/jomant/z-dvt-workbench
AppSupportURL=https://github.com/jomant/z-dvt-workbench/releases
AppUpdatesURL=https://github.com/jomant/z-dvt-workbench/releases
VersionInfoVersion={#AppVersion}.0
VersionInfoProductName={#AppName}
VersionInfoCompany=Z-Jomant Meister
DefaultDirName={autopf}\Z-DVT Workbench
DefaultGroupName=Z-DVT Workbench
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=Z-DVT-Workbench-Setup
SetupIconFile=zdvt.ico
UninstallDisplayIcon={app}\Z-DVT Workbench.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
MinVersion=10.0
ChangesAssociations=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Add a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: checkedonce

[Files]
Source: "..\build\staging\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Z-DVT Workbench"; Filename: "{app}\Z-DVT Workbench.exe"; Comment: "Crafted by Z-Jomant Meister"
Name: "{autodesktop}\Z-DVT Workbench"; Filename: "{app}\Z-DVT Workbench.exe"; Comment: "Crafted by Z-Jomant Meister"; Tasks: desktopicon

[Run]
Filename: "{app}\Z-DVT Workbench.exe"; Description: "Open Z-DVT Workbench"; Flags: nowait postinstall skipifsilent

[Messages]
WelcomeLabel2=This installs Z-DVT Workbench on your computer.%n%nThe workbench watches CAN, talks CANopen, and runs an inverter setup on the bench. It is crafted by Z-Jomant Meister. It is not a BorgWarner or Sevcon product.%n%nA newer version can install over this one. The program checks GitHub for that update.
