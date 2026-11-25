#!/usr/bin/env bash
# Fetches the Solidity dependencies at pinned commits:
#   reactive/lib         the test pool and its hook (Uniswap v4, solc 0.8.26)
#   reactive/reflex/lib  PoolGuard and PoolReflex (reactive-lib-omni, solc 0.8.30)
# The repository root has no git submodules (other folders share it), so the pins live here.
set -euo pipefail

cd "$(dirname "$0")/.."

fetch() {
  local dir="$1" url="$2" rev="$3"
  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD)" = "$rev" ]; then
    echo "$dir already at $rev"
    return
  fi
  mkdir -p "$(dirname "$dir")"
  if [ ! -d "$dir/.git" ]; then
    git clone --quiet "$url" "$dir"
  fi
  git -C "$dir" fetch --quiet origin
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "$rev"
  git -C "$dir" submodule update --quiet --init --recursive
  echo "$dir at $rev"
}

# Same pins as the Uniswap Foundation v4-template foundry.lock.
fetch lib/forge-std https://github.com/foundry-rs/forge-std 8bbcf6e3f8f62f419e5429a0bd89331c85c37824
fetch lib/uniswap-hooks https://github.com/OpenZeppelin/uniswap-hooks e59fe72c110c3862eec9b332530dce49ca506bbb

# reactive-lib-omni v0.1.0, and the forge-std release that library pins (v1.16.1).
fetch reflex/lib/reactive-lib-omni https://github.com/Reactive-Network/reactive-lib-omni 3ade0dcf1d27e67e5783ef807e73a1b9e0c0cce8
fetch reflex/lib/forge-std https://github.com/foundry-rs/forge-std 620536fa5277db4e3fd46772d5cbc1ea0696fb43
