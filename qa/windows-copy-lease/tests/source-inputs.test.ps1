$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\scripts\source-inputs.ps1')
$script:checks=0
function Assert-InputTest([bool]$Condition) {
  if (-not $Condition) { throw 'source-input-parser-test-failed' }
  $script:checks++
}
function Assert-InputRejected([string]$Json) {
  $rejected=$false
  try { $null=Read-ReviewedSourceInputs -Json $Json } catch { $rejected=$_.Exception.Message -eq 'invalid-source-inputs' }
  Assert-InputTest $rejected
}
$valid=@(1..33 | ForEach-Object { 'src/file-'+$_.ToString('00')+'.cpp' })
$raw=ConvertTo-Json -InputObject $valid -Compress
$parsed=Read-ReviewedSourceInputs -Json $raw
Assert-InputTest ($parsed -is [Array] -and $parsed.Count -eq 33)
for ($i=0;$i -lt $valid.Count;$i++) { Assert-InputTest ($parsed[$i] -is [string] -and $parsed[$i] -ceq $valid[$i]) }
# Exercise the exact historical pipeline shape on the affected native runtime.
$legacyPipelineShape='not-applicable'
if ($PSVersionTable.PSVersion.Major -le 5) {
  $wrapped=@($raw | Microsoft.PowerShell.Utility\ConvertFrom-Json)
  Assert-InputTest ($wrapped.Count -eq 1 -and $wrapped[0] -is [Array] -and $wrapped[0].Count -eq 33)
  $legacyPipelineShape='one-nested-array-confirmed'
}
foreach ($bad in @('', 'null', '{}', '"src/file.cpp"', '[]', '[', '[null]', ('['+$raw+']'), ('/* comment */'+$raw))) { Assert-InputRejected $bad }
foreach ($count in @(9,101)) {
  $items=@(1..$count | ForEach-Object { 'src/file-'+$_+'.cpp' })
  Assert-InputRejected (ConvertTo-Json -InputObject $items -Compress)
}
foreach ($bad in @($null,1,$true,@('nested'),[pscustomobject]@{value='src/file.cpp'},'src/file-01.cpp','SRC/file-01.cpp','/absolute','C:/drive','../escape','src/../escape','src/./file','src//file','src/','src\file','src/name.','src/CON.txt','src/file:stream',"src/tab`tfile","src/file.cpp`n","src/file.cpp`r`n")) {
  $items=$valid.Clone();$items[32]=$bad
  Assert-InputRejected (ConvertTo-Json -InputObject $items -Depth 5 -Compress)
}
Assert-InputRejected (' '*65537)
$actual=Read-ReviewedSourceInputs -Json (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\SOURCE-INPUTS.json') -Raw)
Assert-InputTest ($actual.Count -ge 33 -and $actual -contains 'scripts/source-inputs.ps1' -and $actual -contains 'tests/source-inputs.test.ps1')
[ordered]@{schema=1;test='source-input-parser';checks=$script:checks;status='PASS';powershell=$PSVersionTable.PSVersion.ToString();legacyPipelineShape=$legacyPipelineShape}|ConvertTo-Json -Compress
