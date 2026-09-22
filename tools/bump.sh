#!/bin/sh
# Run before every commit and push: sh tools/bump.sh
# 1. Stamps asset URLs in index.html with the current commit so browsers never serve a stale app.js or styles.css.
# 2. Writes the version stamp shown under the section menu and in the footer: the version is the number of the
#    commit about to be made (commits so far + 1), and the time is now, so viewers can see which build is live.
# Writes through a temp file because `sed -i` takes different arguments on macOS and GNU (Git Bash, Linux).
cd "$(dirname "$0")/.." || exit 1
V=$(git rev-parse --short HEAD)
N=$(( $(git rev-list --count HEAD) + 1 ))
NOW=$(date +"%b %-d, %Y, %-I:%M %p")
sed -E -e "s#(styles\.css|app\.js|data/data\.js)(\?v=[a-z0-9]+)?\"#\1?v=$V\"#g" \
       -e "s#(<strong class=\"stamp-v\">)[^<]*(</strong>)#\1$N\2#g" \
       -e "s#(<span class=\"stamp-t\">)[^<]*(</span>)#\1$NOW\2#g" index.html > index.html.tmp && mv index.html.tmp index.html
echo "assets stamped with $V; version $N, published $NOW"
