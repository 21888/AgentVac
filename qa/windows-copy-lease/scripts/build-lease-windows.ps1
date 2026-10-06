param(
  [Parameter(Mandatory=$true)][string]$CompilerPath,
  [Parameter(Mandatory=$true)][ValidateSet('x64','arm64')][string]$Architecture,
  [Parameter(Mandatory=$true)][string]$ExpectedSdkVersion,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSourceTreeSha256
)
$ErrorActionPreference='Stop'
if (-not [IO.Path]::IsPathRooted($CompilerPath)) { throw 'absolute-compiler-required' }
$compiler=Get-Item -LiteralPath $CompilerPath
$sig=Get-AuthenticodeSignature -LiteralPath $compiler.FullName
if ($compiler.Name -ine 'cl.exe' -or $sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') { throw 'reviewed-microsoft-compiler-required' }
if ($env:VSCMD_ARG_TGT_ARCH -ne $Architecture -or $env:WindowsSDKVersion.TrimEnd('\') -ne $ExpectedSdkVersion.TrimEnd('\')) { throw 'build-environment-mismatch' }
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output=Join-Path $root ('build\windows-'+$Architecture)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$helper=Join-Path $output 'agentvac-copy-lease-research.exe'
$fixture=Join-Path $output 'agentvac-initial-fixtures-research.exe'
$holder=Join-Path $output 'agentvac-delete-holder-fixture.exe'
$manifest=Join-Path $root 'src\helper.manifest'
$fixtureBuild='not-attempted'
$inputs=@(Get-Content -LiteralPath (Join-Path $root 'SOURCE-INPUTS.json') -Raw | ConvertFrom-Json)
if ($inputs.Count -lt 10 -or $inputs.Count -gt 100 -or @($inputs | Select-Object -Unique).Count -ne $inputs.Count) { throw 'invalid-source-inputs' }
foreach ($relative in $inputs) { if ($relative -notmatch '^[A-Za-z0-9_./-]+$' -or $relative.StartsWith('/') -or $relative.Split('/') -contains '..') { throw 'invalid-source-inputs' } }

[Array]::Sort($inputs,[StringComparer]::Ordinal)
function Get-SourceHashes {
  $observed=[ordered]@{}
  foreach ($relative in $inputs) { $observed[$relative]=(Get-FileHash -LiteralPath (Join-Path $root $relative) -Algorithm SHA256).Hash.ToLowerInvariant() }
  return $observed
}
$hashes=Get-SourceHashes
$lines=@();foreach ($relative in $inputs) { $lines+=$relative+[char]0+$hashes[$relative]+"`n" }
$sha=[Security.Cryptography.SHA256]::Create()
try {$tree=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($lines -join '')))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
if ($tree -ne $ExpectedSourceTreeSha256) { throw 'reviewed-source-pin-mismatch' }
function Assert-SourceUnchanged {
  $observed=Get-SourceHashes
  foreach ($relative in $inputs) { if ($observed[$relative] -ne $hashes[$relative]) { throw 'source-changed-during-build' } }
}
Push-Location $output
try {
  & $compiler.FullName /nologo /std:c++17 /EHsc /MT /W4 /WX /O2 /guard:cf /sdl /Brepro /utf-8 /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0602 /DWINVER=0x0602 (Join-Path $root 'src\lease-helper.cpp') "/Fe:$helper" /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /GUARD:CF /DEPENDENTLOADFLAG:0x800 /SUBSYSTEM:CONSOLE /MANIFEST:EMBED "/MANIFESTINPUT:$manifest" advapi32.lib
  $code=$LASTEXITCODE;Assert-SourceUnchanged
  if ($code -ne 0) { throw 'helper-build-failed' }
  & $compiler.FullName /nologo /std:c++17 /EHsc /MT /W4 /WX /O2 /guard:cf /sdl /Brepro /utf-8 /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0602 /DWINVER=0x0602 (Join-Path $root 'src\delete-holder.cpp') "/Fe:$holder" /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /GUARD:CF /DEPENDENTLOADFLAG:0x800 /SUBSYSTEM:CONSOLE /MANIFEST:EMBED "/MANIFESTINPUT:$manifest" advapi32.lib
  $code=$LASTEXITCODE;Assert-SourceUnchanged
  if ($code -ne 0) { throw 'holder-build-failed' }

  & $compiler.FullName /nologo /std:c++17 /EHsc /MT /W4 /WX /O2 /guard:cf /sdl /Brepro /utf-8 /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0602 /DWINVER=0x0602 (Join-Path $root 'src\fixture-constructor.cpp') "/Fe:$fixture" /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /GUARD:CF /DEPENDENTLOADFLAG:0x800 /SUBSYSTEM:CONSOLE /MANIFEST:EMBED "/MANIFESTINPUT:$manifest" advapi32.lib bcrypt.lib
  $code=$LASTEXITCODE;Assert-SourceUnchanged
  $fixtureBuild=if ($code -eq 0) { 'built' } else { 'compile-failed' }
  & $compiler.FullName /nologo /std:c++17 /EHsc /MT /W4 /WX /O2 /utf-8 (Join-Path $root 'tests\core.test.cpp') '/Fe:core-tests.exe'
  $code=$LASTEXITCODE;Assert-SourceUnchanged
  if ($code -ne 0) { throw 'core-test-build-failed' }
  & $compiler.FullName /nologo /std:c++17 /EHsc /MT /W4 /WX /O2 /utf-8 (Join-Path $root 'tests\inherited-policy.test.cpp') '/Fe:inherited-policy-tests.exe'
  $code=$LASTEXITCODE;Assert-SourceUnchanged
  if ($code -ne 0) { throw 'inherited-policy-test-build-failed' }
  & $compiler.FullName /nologo /std:c++17 /EHsc /MT /W4 /WX /O2 /utf-8 (Join-Path $root 'tests\lease-core.test.cpp') '/Fe:lease-core-tests.exe'
  $code=$LASTEXITCODE;Assert-SourceUnchanged
  if ($code -ne 0) { throw 'lease-core-test-build-failed' }
} finally { Pop-Location }

[ordered]@{
  schema=1;profile='generated-private-copy-lease-v2';status='built-not-native-accepted';sourcePrePostMatched=$true;sourceTreeSha256=$tree;sources=$hashes
  compilerVersion=$compiler.VersionInfo.FileVersion;compilerSha256=(Get-FileHash -LiteralPath $compiler.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  helperSha256=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
  holderSha256=(Get-FileHash -LiteralPath $holder -Algorithm SHA256).Hash.ToLowerInvariant()
  fixtureBuild=$fixtureBuild;fixtureSha256=if($fixtureBuild -eq 'built'){(Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash.ToLowerInvariant()}else{$null}
  targetArchitecture=$Architecture;sdkVersion=$ExpectedSdkVersion.TrimEnd('\');crt='static-MT';buildTimeUtc=[DateTime]::UtcNow.ToString('o');nativeWindows='NOT_RUN'
}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $output 'lease-build-provenance.json') -Encoding UTF8
# Builds only. No executable runs, deployment, credential setup or production receipt.
