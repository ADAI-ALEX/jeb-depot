#!/bin/sh
# Fetch the pinned official llama.cpp macOS arm64 release, verify it, and copy exactly what llama-server needs
# into src-tauri/resources/llama/ (bundled inside JEB Depot.app).
set -eu

BUILD=b11149
ASSET="llama-${BUILD}-bin-macos-arm64.tar.gz"
SHA256="791eb0200a7c846ca925b6274fc21f0f21f537fda2924cc5a47402655816f56e"
URL="https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}/${ASSET}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.cache"
DEST="$ROOT/src-tauri/resources/llama"
mkdir -p "$CACHE"

if [ -x "$DEST/llama-server" ] && [ -f "$DEST/BUILD" ] && [ "$(cat "$DEST/BUILD")" = "$BUILD" ]; then
  echo "llama.cpp $BUILD already in $DEST"
  exit 0
fi

if [ ! -f "$CACHE/$ASSET" ]; then
  echo "downloading $URL"
  curl -fL --retry 3 -o "$CACHE/$ASSET.part" "$URL"
  mv "$CACHE/$ASSET.part" "$CACHE/$ASSET"
fi

GOT="$(shasum -a 256 "$CACHE/$ASSET" | cut -d' ' -f1)"
if [ "$GOT" != "$SHA256" ]; then
  echo "SHA-256 mismatch for $ASSET: got $GOT, want $SHA256" >&2
  rm -f "$CACHE/$ASSET"
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$CACHE/$ASSET" -C "$TMP"
SRC="$TMP/llama-$BUILD"

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC/llama-server" "$DEST/"
# The libraries llama-server links through @rpath (= @loader_path), copied as real files under their install names.
for lib in libllama-server-impl.dylib libllama-common.0.dylib libmtmd.0.dylib libllama.0.dylib libggml.0.dylib \
           libggml-base.0.dylib libggml-cpu.0.dylib libggml-blas.0.dylib libggml-metal.0.dylib libggml-rpc.0.dylib; do
  cp -L "$SRC/$lib" "$DEST/$lib"
done
cp "$SRC/LICENSE" "$DEST/LICENSE-llama.cpp"
echo "$BUILD" > "$DEST/BUILD"

# Every library the copied binaries reference must be present.
missing=0
for f in "$DEST"/llama-server "$DEST"/*.dylib; do
  for dep in $(otool -L "$f" | awk 'NR>1 && $1 ~ /^@rpath\// {sub("@rpath/", "", $1); print $1}'); do
    if [ ! -f "$DEST/$dep" ]; then echo "missing dependency $dep (of $(basename "$f"))" >&2; missing=1; fi
  done
done
[ "$missing" = 0 ] || exit 1

"$DEST/llama-server" --version 2>&1 | grep -E "^version" || { echo "bundled llama-server does not run" >&2; exit 1; }
echo "llama.cpp $BUILD ready in $DEST ($(du -sh "$DEST" | cut -f1))"
