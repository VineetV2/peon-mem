#!/usr/bin/env bash
# Peon one-line installer:  curl -fsSL https://raw.githubusercontent.com/VineetV2/peon-mem/main/install.sh | bash
set -euo pipefail

APP_DIR="${PEON_INSTALL_DIR:-$HOME/.peon-mem}"
echo "🧠 Installing Peon → $APP_DIR"

command -v node >/dev/null || { echo "node >= 20 required (https://nodejs.org)"; exit 1; }
command -v git  >/dev/null || { echo "git required"; exit 1; }

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 https://github.com/VineetV2/peon-mem "$APP_DIR"
fi

cd "$APP_DIR"
npm install --omit=dev --silent      # runtime dep only; dist/ ships prebuilt

# expose the CLI if a writable bin dir exists (best-effort)
BIN_TARGET="$APP_DIR/bin/peon-mem.mjs"
for B in "$(npm prefix -g 2>/dev/null)/bin" /usr/local/bin "$HOME/.local/bin"; do
  if [ -d "$B" ] && [ -w "$B" ]; then ln -sf "$BIN_TARGET" "$B/peon-mem" && echo "✔ CLI linked: $B/peon-mem" && break; fi
done

echo
exec node "$BIN_TARGET" install "$@"
