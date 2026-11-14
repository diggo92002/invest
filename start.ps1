$ErrorActionPreference = 'Stop'
$serverFile = Join-Path $PSScriptRoot 'server.mjs'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    & $nodeCommand.Source $serverFile
} else {
    $codeRuntime = Join-Path $env:LOCALAPPDATA 'Programs/Microsoft VS Code/Code.exe'
    if (-not (Test-Path -LiteralPath $codeRuntime)) { throw 'Install Node.js 20 or newer, then run: node server.mjs' }
    $previousElectronMode = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        & $codeRuntime $serverFile
    } finally {
        $env:ELECTRON_RUN_AS_NODE = $previousElectronMode
    }
}
