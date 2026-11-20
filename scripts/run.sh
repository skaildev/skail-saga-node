#!/bin/sh
# Runs the demo on Linux or macOS with what this machine has: Docker, then Podman, then Node.js.
# Usage: scripts/run.sh [arguments of the app]
set -e
cd "$(dirname "$0")/.."

IMAGE=skail-saga-node
# ports the container publishes (the demos with a page use 8080)
PUBLISH="-p 127.0.0.1:8080:8080"

if [ ! -f .env ]; then
  echo "Missing .env: copy .env.example to .env and fill in the values of your skail environment." >&2
  exit 1
fi

# the skail bundle is built for SKAIL_WORKLOAD, so the image build needs it (and only it) from .env
WORKLOAD=$(sed -n 's/^SKAIL_WORKLOAD=//p' .env | tail -n 1 | tr -d '\r"'"'")
if [ -z "$WORKLOAD" ]; then
  echo "SKAIL_WORKLOAD is empty in .env." >&2
  exit 1
fi

# -t only when there is a terminal, so the script also works in a pipe or in CI
TTY=-i
if [ -t 0 ] && [ -t 1 ]; then TTY=-it; fi

# Builds the image and runs it. Returns when the engine is not usable or the build fails, so the next option is tried.
try_container() {
  engine=$1; volume_flag=$2; user_flag=$3; shift 3
  command -v "$engine" >/dev/null 2>&1 || return 0
  "$engine" info >/dev/null 2>&1 || return 0
  echo "Building the image with $engine (the first time takes a few minutes)..."
  if ! "$engine" build -q --build-arg "SKAIL_WORKLOAD=$WORKLOAD" -t "$IMAGE" . >/dev/null; then
    echo "The $engine build failed; trying the next option." >&2
    return 0
  fi
  echo "Running with $engine."
  # the repository folder is the working directory of the app: it reads .env from there
  exec "$engine" run --rm $TTY --init $user_flag $PUBLISH -v "$PWD:/data$volume_flag" "$IMAGE" "$@"
}

# docker runs as the current user, so files the app writes in the folder stay yours; rootless podman already does
try_container docker "" "--user $(id -u):$(id -g)" "$@"
try_container podman ":Z" "" "$@"

# Node.js 20.12 or newer (process.loadEnvFile)
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 12) ? 0 : 1)'; then
  echo "Running with Node.js $(node --version)."
  if [ ! -d node_modules ]; then npm ci --no-audit --no-fund; fi
  npm run build --silent
  exec node --enable-source-maps dist/main.js "$@"
fi

if command -v node >/dev/null 2>&1; then
  echo "Node.js $(node --version) is too old for this demo: it needs 20.12 or newer." >&2
fi
cat >&2 <<'MSG'
Nothing to run the demo with. Install one of these and run the script again:
  - Docker:              https://docs.docker.com/get-docker/  (the Docker service must be running)
  - Podman:              https://podman.io/docs/installation
  - Node.js 20.12 or 22: https://nodejs.org
MSG
exit 1
