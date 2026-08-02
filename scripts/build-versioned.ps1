$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  $package = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
  $xpiName = "margin-comments-ai-$($package.version).xpi"

  & corepack pnpm exec zotero-plugin build
  if ($LASTEXITCODE -ne 0) {
    throw "zotero-plugin build failed with exit code $LASTEXITCODE"
  }

  $builtXpi = Join-Path $projectRoot (Join-Path 'build' $xpiName)
  if (-not (Test-Path -LiteralPath $builtXpi -PathType Leaf)) {
    throw "Expected build artifact was not created: $builtXpi"
  }

  $releaseDirectory = Join-Path $projectRoot 'releases'
  New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
  $archivedXpi = Join-Path $releaseDirectory $xpiName
  Copy-Item -LiteralPath $builtXpi -Destination $archivedXpi -Force

  Write-Host "Archived versioned XPI: $archivedXpi"
}
finally {
  Pop-Location
}
