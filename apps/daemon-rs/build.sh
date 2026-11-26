#!/bin/sh
# Builds ekatva-rs (`pnpm build` runs this after the daemon's TypeScript).
# The `ekatva` launcher uses the binary only when it is newer than the
# daemon's dist/cli.js, so it is touched after every build: an unchanged
# binary is still the one for this dist. Without cargo: a warning, and the
# launcher runs the TypeScript CLI for everything.
set -eu
cd "$(dirname "$0")"
if ! command -v cargo >/dev/null 2>&1; then
  echo "ekatva-rs: cargo isn't installed; skipping it (ekatva runs the TypeScript CLI for everything)" >&2
  exit 0
fi
cargo build --release --quiet
touch target/release/ekatva-rs
