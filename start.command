#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display dialog "Z-DVT Workbench needs Node.js. Install it from https://nodejs.org or, with Homebrew, run: brew install node" buttons {"OK"} default button 1 with title "Z-DVT Workbench"' >/dev/null 2>&1
  echo "Node.js is not installed. Install it from https://nodejs.org or run: brew install node"
  exit 1
fi
exec node src/server.js
