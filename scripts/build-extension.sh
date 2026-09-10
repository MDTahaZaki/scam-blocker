#!/usr/bin/env bash
# Zips extension/ into dist/safelink-ai-v<version>.zip for manual loading or
# a future Chrome Web Store upload. Version is read from
# extension/manifest.json so the two never drift apart.
#
# NOTE: firebase-config.js is intentionally included in the zip. Its values
# are a public, domain-restricted Firebase Web SDK config (safe to ship in
# a client bundle by design), not a secret — see README "Security notes".
#
# NOTE: this ships the Firebase SDK loaded from Google's CDN via
# importScripts() (see manifest.json's content_security_policy). That is
# fine for side-loading/testing but Chrome Web Store review requires all
# code to be bundled locally — vendor the SDK under extension/vendor/
# before submitting there. See README "Limitations".
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./extension/manifest.json').version")
OUT_DIR="dist"
OUT_FILE="$OUT_DIR/safelink-ai-v${VERSION}.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

cd extension
zip -r "../$OUT_FILE" . -x "*.DS_Store"
cd ..

echo "Built $OUT_FILE"
