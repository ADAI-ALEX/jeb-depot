#!/bin/sh
# Build "JEB Depot.app" (and a .dmg) from a fresh checkout: one command, no manual steps.
#   ./scripts/build-app.sh            app bundle + dmg
#   ./scripts/build-app.sh app        app bundle only
# Needs: Node 20+, Rust (rustup), Xcode Command Line Tools. The model is NOT bundled: the app downloads it on
# first launch (4.6 GB, pinned and verified).
set -eu
cd "$(dirname "$0")/.."

# If the full Xcode is selected but its license was never accepted, fall back to the Command Line Tools.
if ! xcrun --find clang >/dev/null 2>&1 && [ -d /Library/Developer/CommandLineTools ]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi
[ -d "$HOME/.cargo/bin" ] && export PATH="$HOME/.cargo/bin:$PATH"

command -v cargo >/dev/null || { echo "Rust is required: https://rustup.rs" >&2; exit 1; }
command -v npm >/dev/null || { echo "Node.js is required: https://nodejs.org" >&2; exit 1; }

./scripts/fetch-llama.sh
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

BUNDLES="${1:-app,dmg}"
npx tauri build --bundles "$BUNDLES"

APP="target/release/bundle/macos/JEB Depot.app"
echo
echo "built: $APP ($(du -sh "$APP" | cut -f1))"
codesign -dv "$APP" 2>&1 | grep -E "Signature|Identifier" || true
ls target/release/bundle/dmg/*.dmg 2>/dev/null || true
