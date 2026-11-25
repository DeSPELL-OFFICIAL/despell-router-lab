#!/usr/bin/env bash
# Fetches the Solidity dependencies into reactive/lib at pinned commits.
# The repository root has no git submodules (other folders share it), so the
# pins live here. Same pins as the Uniswap Foundation v4-template foundry.lock.
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
  git -C "lib/$name" submodule update --quiet --init --recursive
  echo "lib/$name at $rev"
}

fetch forge-std https://github.com/foundry-rs/forge-std 8bbcf6e3f8f62f419e5429a0bd89331c85c37824
fetch uniswap-hooks https://github.com/OpenZeppelin/uniswap-hooks e59fe72c110c3862eec9b332530dce49ca506bbb
