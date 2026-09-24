default:
  @just --list

check:
  #!/bin/sh
  set -eu
  python3 -c "import json; json.load(open('manifest.json')); print('manifest ok')"
  node --check format.js && echo "format.js ok"
  node --check content.js && echo "content.js ok"
  node --check background.js && echo "background.js ok"
  node --check popup.js && echo "popup.js ok"
  python3 -m py_compile build-stamp.py && echo "build-stamp.py ok"
  node --check store.js && echo "store.js ok"
  node --check mcp-server.js && echo "mcp-server.js ok"
  node test/brief.test.js
  node test/store.test.js
  node test/mcp-http.test.js

mcp:
  node mcp-server.js

install-daemon:
  #!/bin/sh
  set -eu
  mkdir -p ~/Library/LaunchAgents
  ln -sf "$PWD/com.annotate-export.bridge.plist" ~/Library/LaunchAgents/com.annotate-export.bridge.plist
  launchctl bootout "gui/$(id -u)/com.annotate-export.bridge" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.annotate-export.bridge.plist
  echo "daemon installed"

dev:
  @echo "Load unpacked via chrome://extensions -> Developer mode -> select dist/."

pack:
  #!/bin/sh
  set -eu
  mkdir -p dist
  cp manifest.json background.js format.js content.js styles.css popup.html popup.js dist/
  python3 build-stamp.py
  echo "dist/ packed (stamp auto-baked, no manual bump needed)"
