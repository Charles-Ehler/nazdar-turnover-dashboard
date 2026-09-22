#!/bin/sh
# Stamp asset URLs in index.html with the current commit so browsers never serve a stale app.js or styles.css.
# Run before committing a change to app.js, styles.css or data: sh tools/bump.sh
# Writes through a temp file because `sed -i` takes different arguments on macOS and GNU (Git Bash, Linux).
cd "$(dirname "$0")/.." || exit 1
V=$(git rev-parse --short HEAD)
sed -E "s#(styles\.css|app\.js|data/data\.js)(\?v=[a-z0-9]+)?\"#\1?v=$V\"#g" index.html > index.html.tmp && mv index.html.tmp index.html
echo "assets stamped with $V"
