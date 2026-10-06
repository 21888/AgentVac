# Pure manifest parser. Do not collect ConvertFrom-Json's pipeline in @(...):
# Windows PowerShell 5.1 emits the JSON array as one pipeline object.
function Read-ReviewedSourceInputs {
  param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Json)
  if ($Json.Length -eq 0 -or $Json.Length -gt 65536 -or -not $Json.TrimStart().StartsWith('[') -or -not $Json.TrimEnd().EndsWith(']')) { throw 'invalid-source-inputs' }
  try {
    $command=Get-Command Microsoft.PowerShell.Utility\ConvertFrom-Json -ErrorAction Stop
    if ($command.Parameters.ContainsKey('NoEnumerate')) {
      $parsed=Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $Json -NoEnumerate -ErrorAction Stop
    } else {
      $parsed=Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $Json -ErrorAction Stop
    }
  } catch { throw 'invalid-source-inputs' }
  if ($parsed -isnot [Array] -or $parsed.Count -lt 10 -or $parsed.Count -gt 100) { throw 'invalid-source-inputs' }
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($relative in $parsed) {
    if ($relative -isnot [string] -or $relative.Length -gt 256 -or $relative -cnotmatch '\A[A-Za-z0-9_./-]+\z' -or $relative.StartsWith('/') -or -not $seen.Add($relative)) { throw 'invalid-source-inputs' }
    foreach ($part in $relative.Split('/')) {
      if ($part.Length -eq 0 -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'invalid-source-inputs' }
    }
  }
  # Preserve the validated top-level array through this function's pipeline too.
  return ,([string[]]$parsed)
}
