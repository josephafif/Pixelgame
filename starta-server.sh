#!/usr/bin/env bash
# Pixelgame: starts the server manager (a control panel in your browser).
# Mac: double-click Starta-server.command. Linux: run ./starta-server.sh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

pause() { if [ -t 0 ]; then read -r -p "  Tryck Enter för att stänga. " _; fi; }

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js behövs för att köra servern, men finns inte på datorn."
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    echo "  Installerar Node.js med Homebrew…"
    brew install node || { pause; exit 1; }
  else
    echo "  Installera Node.js 22 eller nyare (LTS) från https://nodejs.org och starta sedan igen."
    if [ "$(uname)" = "Darwin" ]; then open "https://nodejs.org/"; fi
    pause
    exit 1
  fi
fi
if [ ! -f node_modules/ws/package.json ]; then
  echo "  Förbereder servern första gången…"
  if ! npm install --omit=dev --no-audit --no-fund; then
    echo "  Det gick inte. Kontrollera internetanslutningen och försök igen."
    pause
    exit 1
  fi
fi
node scripts/host.mjs "$@"
status=$?
pause
exit $status
