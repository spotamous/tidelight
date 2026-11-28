#!/usr/bin/env bash
# Bump Tidelight to a new version everywhere phones look for it, then rebuild the alerts function.
# Usage (from the project folder):  tools/bump.sh 7.5.3
# Afterwards: add the What's new entry at the top of WHATS_NEW in js/welcome.js (same version number).
set -euo pipefail
V="${1:?Usage: tools/bump.sh <version>, e.g. tools/bump.sh 7.5.3}"
[[ "$V" =~ ^[0-9]+(\.[0-9]+)+$ ]] || { echo "Version must look like 7.5.3"; exit 1; }
cd "$(dirname "$0")/.."
sed -i -E "s#\.js\?v=[0-9.]+'#.js?v=$V'#g" js/*.js
sed -i -E "s#(\.js|\.css)\?v=[0-9.]+#\1?v=$V#g" index.html
sed -i "s/APP_VERSION = '[0-9.]*'/APP_VERSION = '$V'/" js/version.js
sed -i "s/const VERSION = '[0-9.]*'/const VERSION = '$V'/" sw.js
sed -i -E "s/\(\`\?v=[0-9.]+\`\)/(\`?v=$V\`)/" README.md
node tools/build-alerts.mjs
grep -q "v: '$V'" js/welcome.js || echo "Reminder: add a What's new entry for $V at the top of WHATS_NEW in js/welcome.js"
echo "Bumped to $V"
