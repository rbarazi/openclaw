#!/bin/bash
set -e

HEADLESS="${HEADLESS:-true}"

CHROME_FLAGS=(
  "--no-sandbox"
  "--disable-setuid-sandbox"
  "--disable-gpu"
  "--disable-dev-shm-usage"
  "--remote-debugging-address=0.0.0.0"
  "--remote-debugging-port=9222"
  "--user-data-dir=/home/chrome/data"
  "--no-first-run"
  "--disable-background-networking"
  "--disable-sync"
  "--disable-default-apps"
  "--password-store=basic"
  "--disable-features=Translate,MediaRouter,UserAgentClientHint"
  "--disable-blink-features=AutomationControlled"
  "--lang=en-US"
  "--window-size=1280,720"
)

# Clean up stale lock files from previous runs
rm -f /home/chrome/data/SingletonLock \
      /home/chrome/data/SingletonCookie \
      /home/chrome/data/SingletonSocket
rm -f /tmp/.X99-lock

if [ "$HEADLESS" = "true" ]; then
  CHROME_FLAGS+=("--headless=new")
  exec chromium "${CHROME_FLAGS[@]}" "about:blank"
fi

# --- Headful mode: Xvfb + x11vnc + noVNC ---
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 -ac &
sleep 1

chromium "${CHROME_FLAGS[@]}" "about:blank" &
CHROME_PID=$!
sleep 2

x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -q &
websockify --web=/usr/share/novnc 6080 localhost:5900 &

wait $CHROME_PID
