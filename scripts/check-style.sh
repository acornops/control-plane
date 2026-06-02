#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Checking Google-style constraints..."

search() {
  local rg_pattern="$1"
  local grep_pattern="$2"
  local path="$3"

  if command -v rg >/dev/null 2>&1; then
    rg -n -e "${rg_pattern}" "${path}"
  else
    grep -RInE "${grep_pattern}" "${path}"
  fi
}

if search '\bany\b' '(^|[^[:alnum:]_])any([^[:alnum:]_]|$)' "${ROOT_DIR}/src"; then
  echo "Style check failed: avoid explicit 'any' types."
  exit 1
fi

if search '\bpublic\s+' '(^|[^[:alnum:]_])public[[:space:]]+' "${ROOT_DIR}/src"; then
  echo "Style check failed: avoid 'public' visibility modifiers."
  exit 1
fi

# Routes should remain thin wiring and delegate behavior to controllers/services.
if search 'repo\.|dispatchRunToExecutionEngine|cancelRunInExecutionEngine|gatewayTokenService|agentGateway\.' 'repo\.|dispatchRunToExecutionEngine|cancelRunInExecutionEngine|gatewayTokenService|agentGateway\.' "${ROOT_DIR}/src/routes"; then
  echo "Style check failed: route files should not contain business logic."
  exit 1
fi

echo "Style checks passed."
