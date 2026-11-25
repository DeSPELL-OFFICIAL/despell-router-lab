#!/usr/bin/env bash
# Fetches the Solidity dependencies into xlayer/contracts/lib at pinned commits.
# The repository root has no git submodules (other folders share it), so the pins live here.
# Same forge-std commit as reactive/scripts/install-deps.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p lib

fetch() {
  local name="$1" url="$2" rev="$3"
  if [ -d "lib/$name/.git" ] && [ "$(git -C "lib/$name" rev-parse HEAD)" = "$rev" ]; then
    echo "lib/$name already at $rev"
    return
  fi
  if [ ! -d "lib/$name/.git" ]; then
    git clone --quiet "$url" "lib/$name"
  fi
  git -C "lib/$name" fetch --quiet origin
  git -C "lib/$name" -c advice.detachedHead=false checkout --quiet "$rev"
  echo "lib/$name at $rev"
}

fetch forge-std https://github.com/foundry-rs/forge-std 8bbcf6e3f8f62f419e5429a0bd89331c85c37824
