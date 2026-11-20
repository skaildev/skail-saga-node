# Runs the demo on Windows with what this machine has: Docker, then Podman, then Node.js.
# Works on Windows PowerShell 5.1 (built into Windows) and on PowerShell 7.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\run.ps1 [arguments of the app]

# No $ErrorActionPreference = 'Stop': on Windows PowerShell 5.1 it turns any stderr output of docker, podman,
# dotnet or node into a fatal error, and the script would stop before trying the next option.
Set-Location (Split-Path -Parent $PSScriptRoot)

$image = 'skail-saga-node'
# ports the container publishes (the demos with a page use 8080)
$publish = @()

if (-not (Test-Path '.env')) {
    Write-Host 'Missing .env: copy .env.example to .env and fill in the values of your skail environment.' -ForegroundColor Red
    exit 1
}

# the skail bundle is built for SKAIL_WORKLOAD, so the image build needs it (and only it) from .env
$workload = ''
foreach ($line in Get-Content '.env') {
    if ($line -match '^SKAIL_WORKLOAD=(.*)$') { $workload = $Matches[1].Trim().Trim('"', "'") }
}
if (-not $workload) {
    Write-Host 'SKAIL_WORKLOAD is empty in .env.' -ForegroundColor Red
    exit 1
}

# Builds the image and runs it. Returns when the engine is not usable or the build fails, so the next option is tried.
function Invoke-Container([string] $engine, [string[]] $appArgs) {
    if (-not (Get-Command $engine -ErrorAction SilentlyContinue)) { return }
    & $engine info *> $null
    if ($LASTEXITCODE -ne 0) { return }
    Write-Host "Building the image with $engine (the first time takes a few minutes)..."
    & $engine build -q --build-arg "SKAIL_WORKLOAD=$workload" -t $image . | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "The $engine build failed; trying the next option." -ForegroundColor Yellow
        return
    }
    Write-Host "Running with $engine."
    # the repository folder is the working directory of the app: it reads .env from there
    $folder = (Get-Location).Path
    & $engine run --rm -it --init @publish -v "${folder}:/data" $image @appArgs
    exit $LASTEXITCODE
}

# Node.js 20.12 or newer (process.loadEnvFile)
function Test-Node {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { return $false }
    $version = $null
    if (-not [version]::TryParse(([string](& node --version)).Trim().TrimStart('v'), [ref]$version)) { return $false }
    return ($version -ge [version]'20.12.0')
}

Invoke-Container 'docker' $args
Invoke-Container 'podman' $args

if (Test-Node) {
    Write-Host "Running with Node.js $(& node --version)."
    if (-not (Test-Path 'node_modules')) {
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    & npm run build --silent
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node --enable-source-maps dist/main.js @args
    exit $LASTEXITCODE
}

if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "Node.js $(& node --version) is too old for this demo: it needs 20.12 or newer." -ForegroundColor Yellow
}
Write-Host 'Nothing to run the demo with. Install one of these and run the script again:' -ForegroundColor Red
Write-Host '  - Docker Desktop:      https://docs.docker.com/desktop/setup/install/windows-install/  (it must be running)'
Write-Host '  - Podman:              https://podman.io/docs/installation'
Write-Host '  - Node.js 20.12 or 22: https://nodejs.org'
exit 1
