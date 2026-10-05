param(
  [Parameter(Mandatory=$true)][string]$CompilerPath,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture,
  [Parameter(Mandatory=$true)][string]$ExpectedSdkVersion
)
$ErrorActionPreference = 'Stop'
# Build only, in a preinstalled Microsoft Native Tools environment. No install,
# download, elevation, machine settings change, or application activation.
if (-not [IO.Path]::IsPathRooted($CompilerPath)) { throw 'absolute-compiler-required' }
$compiler = Get-Item -LiteralPath $CompilerPath
$signature = Get-AuthenticodeSignature -LiteralPath $compiler.FullName
if ($compiler.Name -ine 'cl.exe' -or $signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { throw 'reviewed-microsoft-compiler-required' }
if ($env:VSCMD_ARG_TGT_ARCH -ne $Architecture -or $env:WindowsSDKVersion.TrimEnd('\') -ne $ExpectedSdkVersion.TrimEnd('\')) { throw 'build-environment-mismatch' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = Join-Path $root ('build\windows-' + $Architecture)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$helper = Join-Path $output 'agentvac-metadata-research.exe'
$source = Join-Path $root 'src\native-helper.cpp'
$manifest = Join-Path $root 'src\helper.manifest'
$arch = $Architecture.ToUpperInvariant()
$launcher = Join-Path $output 'agentvac-restricted-fixture-launcher.exe'
$helperHash = $null
$launcherBuild = 'not-attempted'
Push-Location $output
try {
  & $compiler.FullName /nologo /std:c++17 /EHsc /MT /W4 /WX /O2 /guard:cf /sdl /Brepro /utf-8 /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0602 /DWINVER=0x0602 $source "/Fe:$helper" /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /GUARD:CF /DEPENDENTLOADFLAG:0x800 /SUBSYSTEM:CONSOLE /MANIFEST:EMBED "/MANIFESTINPUT:$manifest" "/MACHINE:$arch" advapi32.lib
  if ($LASTEXITCODE -ne 0) { throw 'native-build-failed' }
  $helperHash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
  ('#define AGENTVAC_REVIEWED_HELPER_SHA256 "' + $helperHash + '"') | Set-Content -LiteralPath (Join-Path $output 'reviewed-helper-binding.h') -Encoding ASCII
  & $compiler.FullName /nologo /std:c++17 /EHsc /MT /W4 /WX /O2 /guard:cf /sdl /Brepro /utf-8 /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 (Join-Path $root 'src\restricted-fixture-launcher.cpp') "/I$output" "/Fe:$launcher" /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /GUARD:CF /DEPENDENTLOADFLAG:0x800 /SUBSYSTEM:CONSOLE /MANIFEST:EMBED "/MANIFESTINPUT:$manifest" "/MACHINE:$arch" advapi32.lib bcrypt.lib user32.lib
  $launcherBuild = if ($LASTEXITCODE -eq 0) { 'built' } else { 'compile-failed' }
  # Preserve the helper/protocol lane when the optional research launcher cannot build.
  & $compiler.FullName /nologo /std:c++17 /EHsc /MT /W4 /WX /O2 /utf-8 (Join-Path $root 'tests\core.test.cpp') '/Fe:core-tests.exe'
  if ($LASTEXITCODE -ne 0) { throw 'core-test-build-failed' }
} finally { Pop-Location }
$inputs = @('.gitattributes','include/core.hpp','src/native-helper.cpp','src/restricted-fixture-launcher.cpp','src/helper.manifest','protocol.mjs','restricted-protocol.mjs','smoke-results.mjs','transport.mjs','scripts/build-windows.ps1','scripts/native-smoke.mjs','scripts/source-manifest.mjs')
$hashes = [ordered]@{}
$lines = @()
[Array]::Sort($inputs, [StringComparer]::Ordinal)
foreach ($relative in $inputs) {
  $hash = (Get-FileHash -LiteralPath (Join-Path $root $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
  $hashes[$relative] = $hash
  $lines += $relative + [char]0 + $hash + "`n"
}
$sha = [Security.Cryptography.SHA256]::Create()
try { $tree = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join '')))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
[ordered]@{
  schema = 1; status = 'built-not-native-accepted'; sourceTreeSha256 = $tree; sources = $hashes
  compilerVersion = $compiler.VersionInfo.FileVersion
  compilerSha256 = (Get-FileHash -LiteralPath $compiler.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  helperSha256 = $helperHash
  helperBuild = 'built'; restrictedLauncherBuild = $launcherBuild
  restrictedLauncherSha256 = if ($launcherBuild -eq 'built') { (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
  generatedBindingSha256 = (Get-FileHash -LiteralPath (Join-Path $output 'reviewed-helper-binding.h') -Algorithm SHA256).Hash.ToLowerInvariant()
  targetArchitecture = $Architecture; sdkVersion = $ExpectedSdkVersion
  buildTimeUtc = [DateTime]::UtcNow.ToString('o'); crt = 'static-MT'; nativeWindows = 'NOT_RUN'
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output 'build-provenance.json') -Encoding UTF8
# This is not a trusted launch receipt. A reviewer separately binds an exact
# installed local non-reparse helper path and hash before the read-only runner.
