#!/bin/sh
set -e

# JIT-load GEMINI_API_KEY from 1Password if not already set.
# OpenClaw resolves provider "google" → env var GEMINI_API_KEY (not GOOGLE_API_KEY).
if [ -z "$GEMINI_API_KEY" ] && [ -n "$OP_SERVICE_ACCOUNT_TOKEN" ]; then
  GEMINI_API_KEY="$(op read "op://NileTheBot/GEMINI_API_KEY/credential" 2>/dev/null)" || true
  if [ -n "$GEMINI_API_KEY" ]; then
    export GEMINI_API_KEY
  fi
fi

exec "$@"
