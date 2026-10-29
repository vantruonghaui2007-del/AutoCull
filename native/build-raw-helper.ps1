# Builds LibRaw 0.22.3 (static, no demosaic packs, no RawSpeed/DNG SDK/zlib/jpeg) and the
# eventstory-raw helper with MSVC. Output: native/bin/win32-x64/eventstory-raw.exe
# Static CRT (/MT) so the helper runs without a separately installed VC++ runtime.
# Usage (PowerShell): powershell -ExecutionPolicy Bypass -File native/build-raw-helper.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$tar = Join-Path $root 'third_party\LibRaw-0.22.3.tar.gz'
$expected = '789f3c33466210a1a0907f747a97c715d21bbf4af712f257fcbbd90111b227e4'
if (-not (Test-Path $tar)) {
  Invoke-WebRequest -Uri 'https://www.libraw.org/data/LibRaw-0.22.3.tar.gz' -OutFile $tar
}
$actual = (Get-FileHash $tar -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "LibRaw tarball checksum mismatch: $actual" }
$src = Join-Path $root 'third_party\LibRaw-0.22.3'
if (-not (Test-Path $src)) { tar -xzf $tar -C (Join-Path $root 'third_party') }

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$out = Join-Path $root 'bin\win32-x64'
New-Item -ItemType Directory -Force $out | Out-Null
$obj = Join-Path $root 'build\win32-x64'
New-Item -ItemType Directory -Force $obj | Out-Null

$cmd = @"
call "$vcvars" >nul
cd /d "$src"
if exist object\*.obj del /q object\*.obj
if exist lib\libraw_static.lib del /q lib\libraw_static.lib
nmake /nologo -f Makefile.msvc COPT="/EHsc /MP /MT /I. /DWIN32 /O2 /W0 /nologo" lib\libraw_static.lib || exit /b 1
cl /nologo /O2 /EHsc /MT /DLIBRAW_NODLL /DWIN32 /D_CRT_SECURE_NO_WARNINGS /I"$src" "$root\raw-helper\eventstory-raw.cpp" /Fo"$obj\\" /Fe"$out\eventstory-raw.exe" "$src\lib\libraw_static.lib" || exit /b 1
"@
$bat = Join-Path $obj 'build.cmd'
Set-Content -Path $bat -Value $cmd -Encoding ascii
cmd /c $bat
if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
& "$out\eventstory-raw.exe" --version
(Get-FileHash "$out\eventstory-raw.exe" -Algorithm SHA256).Hash.ToLower() | Set-Content (Join-Path $out 'eventstory-raw.exe.sha256')
