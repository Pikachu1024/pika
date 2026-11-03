#!/usr/bin/env bash
set -euo pipefail

# Builds the standalone binary and installs it as `pika`.
# PIKA_INSTALL_DIR selects the destination (default: ~/.local/bin).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${PIKA_INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="pika"

if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
else
  echo "error: bun >= 1.4 is required to build $BINARY_NAME (https://bun.sh)" >&2
  exit 1
fi

echo "Building $BINARY_NAME..."
if ! (cd "$ROOT" && "$BUN" run build:binary); then
  echo "error: build failed; the existing install was not changed" >&2
  exit 1
fi

SOURCE="$ROOT/dist/bin/$BINARY_NAME"
if [ ! -f "$SOURCE" ]; then
  echo "error: expected build output at $SOURCE" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
install -m 0755 "$SOURCE" "$INSTALL_DIR/$BINARY_NAME"

echo "Installed $BINARY_NAME to $INSTALL_DIR/$BINARY_NAME"
echo "Run '$BINARY_NAME --help' to get started"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "note: $INSTALL_DIR is not on PATH; add it to run $BINARY_NAME from any shell"
    ;;
esac
