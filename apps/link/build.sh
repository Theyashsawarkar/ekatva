#!/bin/sh
# Builds ekatva-link and ekatva-greeter (`pnpm build`). `ekatva link install`
# copies them to /usr/local/lib/ekatva. Without cargo: a warning, and the
# daemon keeps working on its own, as before the link.
set -eu
cd "$(dirname "$0")"
if ! command -v cargo >/dev/null 2>&1; then
  echo "ekatva-link: cargo isn't installed; skipping it (the daemon works on its own)" >&2
  exit 0
fi
cargo build --release --quiet
