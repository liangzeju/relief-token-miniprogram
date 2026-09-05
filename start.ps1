param([int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js 18+ is required. Install Node.js and run this script again.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'backend\node_modules\ethers\package.json'))) { throw 'Install backend dependencies first: cd backend; pnpm install --prod --ignore-scripts' }
$selectedPort = $Port
while ($selectedPort -lt $Port + 20) {
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $selectedPort)
    try { $probe.Start(); break } catch { $selectedPort++ } finally { $probe.Stop() }
}
if ($selectedPort -ge $Port + 20) { throw 'No free development port found.' }
$env:PORT = [string]$selectedPort
if (-not $env:PUBLIC_BASE_URL) { $env:PUBLIC_BASE_URL = "http://localhost:$selectedPort" }
Write-Host "Frontend: http://localhost:$selectedPort/mobile/"
Write-Host "Marketplace: http://localhost:$selectedPort/mobile/#market"
Write-Host "Admin: http://localhost:$selectedPort/admin/"
Write-Host 'Keep this window open. Press Ctrl+C to stop the service.'
& $nodePath (Join-Path $PSScriptRoot 'backend\server.js')
