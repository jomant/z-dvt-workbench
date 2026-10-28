# Build Z-DVT-Workbench-Setup.exe. Requires Inno Setup 6 and the .NET Framework C# compiler.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$stage = Join-Path $root "build\staging"
$cache = Join-Path $root "build\cache"
$dist = Join-Path $root "dist"
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version

New-Item -ItemType Directory -Force -Path $stage, $cache, $dist | Out-Null
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$zip = Join-Path $cache "node-v24.18.0-win-x64.zip"
if (-not (Test-Path $zip)) {
  Invoke-WebRequest -Uri "https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip" -OutFile $zip
}
$nodeDir = Join-Path $cache "node-v24.18.0-win-x64"
if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
  Expand-Archive -Path $zip -DestinationPath $cache -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $stage "runtime") | Out-Null
Copy-Item (Join-Path $nodeDir "node.exe") (Join-Path $stage "runtime\node.exe")
Copy-Item (Join-Path $nodeDir "LICENSE") (Join-Path $stage "runtime\LICENSE")

$app = Join-Path $stage "app"
New-Item -ItemType Directory -Force -Path $app | Out-Null
foreach ($name in @("src", "public", "plugins", "package.json", "package-lock.json", "README.md", "start.bat", "Z-DVT Workbench.vbs")) {
  $from = Join-Path $root $name
  if (Test-Path $from) { Copy-Item $from (Join-Path $app $name) -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path (Join-Path $app "node_modules\@koromix") | Out-Null
Copy-Item (Join-Path $root "node_modules\koffi") (Join-Path $app "node_modules\koffi") -Recurse -Force
# koffi resolves the native addon from this optional package, not from the koffi folder.
Copy-Item (Join-Path $root "node_modules\@koromix\koffi-win32-x64") (Join-Path $app "node_modules\@koromix\koffi-win32-x64") -Recurse -Force

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$icon = Join-Path $root "installer\zdvt.ico"
& $csc /nologo /target:winexe /win32icon:$icon /out:"$(Join-Path $stage 'Z-DVT Workbench.exe')" (Join-Path $root "installer\launcher.cs")
if ($LASTEXITCODE -ne 0) { throw "The launcher did not compile." }

$iscc = @(
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 is not installed." }

& $iscc "/DAppVersion=$version" (Join-Path $root "installer\zdvt.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup did not build the installer." }
Write-Output ("Built " + (Join-Path $dist "Z-DVT-Workbench-Setup.exe"))
