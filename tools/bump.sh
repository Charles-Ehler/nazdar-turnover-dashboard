#!/bin/sh
# Stamp asset URLs in index.html with the current commit so browsers never serve a stale app.js or styles.css.
# Run before committing a change to app.js, styles.css or data: sh tools/bump.sh
cd "$(dirname "$0")/.." || exit 1
V=$(git rev-parse --short HEAD)
sed -i '' -E "s#(styles\.css|app\.js|data/data\.js)(\?v=[a-z0-9]+)?\"#\1?v=$V\"#g" index.html
echo "assets stamped with $V"
