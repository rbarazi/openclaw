---
summary: "Docker Chromium sidecar container for browser agent features"
read_when:
  - Running Gateway in Docker with browser agent
  - Chromium sidecar container setup
  - Docker Compose CDP browser access
title: "Browser Sidecar (Docker)"
---

# Browser Sidecar Container for Gateway (Docker)

When running the Gateway via Docker Compose, the agent's browser features
(web scraping, page interaction, screenshots) require a Chromium-based browser.
Rather than installing Chrome inside the Gateway image, a dedicated Chromium
container runs alongside the Gateway as a sidecar, sharing the same network
namespace.

The sidecar runs **full Chromium** (not headless-shell) with `--headless=new`,
which behaves identically to a real desktop Chrome session — same rendering,
same `navigator.userAgent`, same JavaScript APIs. A persistent user-data-dir
volume preserves cookies, sessions, and local storage across restarts.

The Gateway connects to the sidecar's
[Chrome DevTools Protocol (CDP)](https://chromedevtools.github.io/devtools-protocol/)
endpoint via Playwright Core. The sidecar handles Chrome lifecycle; the Gateway
only attaches.

## Architecture

```
                           Shared network namespace
                        +--------------------------+
                        |                          |
  Tailnet (HTTPS:443) ──> |  tailscale container     |
                        |    tailscaled + serve    |
                        |                          |
  Host :18789 ─────────> |  openclaw-gateway        |
                        |    (bind lan)            |
                        |      │                   |
                        |      │ CDP over loopback |
                        |      ▼                   |
                        |  chrome                  |
                        |    chromium :9222        |
                        |    user-data: volume     |
                        |                          |
                        |  openclaw-cli            |
                        |    (loopback)            |
                        +--------------------------+
```

- The `chrome` container joins the shared network namespace via
  `network_mode: "service:tailscale"`, just like the gateway and CLI.
- Chrome's CDP endpoint listens on port 9222 inside the shared namespace.
- The Gateway reaches it at `http://127.0.0.1:9222` (loopback, no
  cross-container networking required).
- The Gateway uses `browser.attachOnly: true` so it never tries to launch
  a local Chrome binary — it only connects to the existing CDP endpoint.

## Why Full Chromium (Not headless-shell)?

The `chromedp/headless-shell` image is a stripped-down binary that:

- Exposes `HeadlessChrome` in its User-Agent (trivially fingerprinted)
- Lacks many browser APIs that sites test for
- Doesn't support a persistent user-data-dir
- Gets blocked by bot-detection on sites like X/Twitter

Full Chromium with `--headless=new` (Chrome 112+):

- Uses the **real Chrome UA** in page context (`navigator.userAgent`)
- Supports all browser APIs (same as a desktop Chrome window)
- Persists cookies, sessions, and local storage in a volume-mounted user-data-dir
- Passes most bot-detection heuristics

## Prerequisites

1. The Docker Compose stack from
   [Tailscale Sidecar](tailscale-sidecar.md) already running
2. The `openclaw.json` config file accessible via `${OPENCLAW_CONFIG_DIR}`

## Setup

### 1. The Chrome Dockerfile (`chrome/Dockerfile`)

```dockerfile
FROM debian:bookworm-slim

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN groupadd -r chrome && useradd -r -g chrome -G audio,video chrome && \
    mkdir -p /home/chrome/data && chown -R chrome:chrome /home/chrome

USER chrome

EXPOSE 9222

ENTRYPOINT ["chromium", \
  "--headless=new", \
  "--no-sandbox", \
  "--disable-setuid-sandbox", \
  "--disable-gpu", \
  "--disable-dev-shm-usage", \
  "--remote-debugging-address=0.0.0.0", \
  "--remote-debugging-port=9222", \
  "--user-data-dir=/home/chrome/data", \
  "--no-first-run", \
  "--disable-background-networking", \
  "--disable-sync", \
  "--disable-default-apps", \
  "--password-store=basic", \
  "--disable-features=Translate,MediaRouter", \
  "about:blank"]
```

Key flags:

| Flag | Purpose |
|---|---|
| `--headless=new` | New headless mode — real Chrome behavior, not the legacy stripped mode |
| `--no-sandbox` | Required inside Docker (no user namespaces) |
| `--disable-dev-shm-usage` | Write shared memory to `/tmp` instead of `/dev/shm` |
| `--user-data-dir=/home/chrome/data` | Persistent profile directory (volume-mounted) |
| `--remote-debugging-address=0.0.0.0` | Accept CDP connections from shared namespace |
| `--remote-debugging-port=9222` | Standard CDP port |

Font packages (`fonts-liberation`, `fonts-noto-color-emoji`, `fonts-noto-cjk`)
ensure pages render text correctly instead of showing blank rectangles.

### 2. Add the Chrome service to `docker-compose.yml`

```yaml
chrome:
  build: ./chrome
  network_mode: "service:tailscale"
  depends_on:
    - tailscale
  volumes:
    - chrome-data:/home/chrome/data
  shm_size: "512m"
  init: true
  restart: unless-stopped
```

And add the named volume:

```yaml
volumes:
  ts-state:
  op-config:
  chrome-data:
```

### 3. Add browser config to `openclaw.json`

```json
{
  "browser": {
    "cdpUrl": "http://127.0.0.1:9222",
    "attachOnly": true
  }
}
```

### 4. Build and start

```bash
docker compose build chrome
docker compose up -d
docker compose restart openclaw-gateway
```

The gateway logs should show:

```
Browser control service ready (profiles=2)
```

## Configuration Reference

| Key | Type | Default | Purpose |
|---|---|---|---|
| `browser.cdpUrl` | string | (derived) | CDP endpoint URL. Points the default `openclaw` profile at the sidecar |
| `browser.attachOnly` | boolean | `false` | Never launch Chrome locally; only attach to the existing CDP endpoint |
| `browser.headless` | boolean | `false` | Not needed — the sidecar handles its own headless flag |
| `browser.noSandbox` | boolean | `false` | Not needed — the sidecar handles its own sandbox flag |

## Files

| File | Purpose |
|---|---|
| `chrome/Dockerfile` | Builds the full-Chromium sidecar image |
| `docker-compose.yml` | Defines the `chrome` service and `chrome-data` volume |
| `openclaw.json` | `browser.cdpUrl` + `browser.attachOnly` config |

## Data Persistence

| Path (container) | Mounted from | Persists across restarts? |
|---|---|---|
| `/home/chrome/data` | `chrome-data` (named volume) | Yes (unless `docker compose down -v`) |

The `chrome-data` volume stores the full Chrome user profile:

- `Default/Cookies` — session cookies (login state survives restarts)
- `Default/Local Storage/` — site-specific storage
- `Local State` — Chrome state and preferences
- `Default/Preferences` — profile preferences

To reset the browser to a clean state:

```bash
docker compose down chrome
docker volume rm openclaw_chrome-data
docker compose up -d chrome
```

## Useful Commands

```bash
# Check Chrome is responding (from gateway container)
docker compose exec openclaw-gateway \
  curl -s http://127.0.0.1:9222/json/version

# List open tabs
docker compose exec openclaw-gateway \
  curl -s http://127.0.0.1:9222/json/list

# Chrome container logs
docker compose logs -f chrome

# Rebuild after Dockerfile changes
docker compose build chrome && docker compose up -d chrome

# Restart just Chrome (preserves gateway; cookies persist in volume)
docker compose restart chrome

# Check all container status
docker compose ps
```

## Gotchas and Troubleshooting

### 1. "Browser attachOnly is enabled and profile is not running"

The gateway can't reach the CDP endpoint. Check that the `chrome` container is
running and healthy:

```bash
docker compose ps chrome
docker compose exec openclaw-gateway curl -s http://127.0.0.1:9222/json/version
```

**Fix:** Restart the chrome container:

```bash
docker compose restart chrome
```

### 2. Chrome crashes on large pages (OOM / SIGKILL)

Docker's default shared memory (`/dev/shm`) is 64 MB, which is too small for
Chrome rendering complex pages.

**Fix:** Set `shm_size: "512m"` (or higher) on the `chrome` service in
`docker-compose.yml`. This is already included in the setup above.

### 3. Gateway still tries to launch Chrome locally

The `browser.attachOnly` config isn't set, or the gateway hasn't been restarted
since the config change.

**Fix:** Verify `openclaw.json` has `"attachOnly": true` in the `browser`
section, then restart:

```bash
docker compose restart openclaw-gateway
```

### 4. Port 9222 conflicts

If another process on the shared network namespace is already using port 9222,
the chrome container will fail to start.

**Fix:** Check what's using the port:

```bash
docker compose exec tailscale ss -tlnp | grep 9222
```

### 5. "Remote CDP ... is not reachable"

The gateway treats the CDP URL as remote when the host isn't loopback. Since
all containers share the same network namespace, `127.0.0.1:9222` is loopback
and should work.

**Fix:** Ensure `browser.cdpUrl` uses `127.0.0.1`, not `localhost` (IPv6
resolution can break the connection — same issue as the
[Tailscale Serve proxy](tailscale-sidecar.md#7-ipv6-proxy-errors-dial-tcp-118789-connection-refused)).

### 6. Tabs and cookies persist across gateway restarts

The Chrome container keeps running (and keeps its tabs and cookies) when only
the gateway is restarted. This is normally desirable — login sessions survive
gateway updates. To get a clean slate:

```bash
docker compose restart chrome
```

To also wipe stored cookies/sessions:

```bash
docker compose down chrome && docker volume rm openclaw_chrome-data
docker compose up -d chrome
```

### 7. Site still detects headless mode

Some sites fingerprint beyond User-Agent. Additional mitigations:

- Ensure the `chrome-data` volume is persistent (sites track returning visitors)
- Log in via the agent normally (cookies accumulate over time)
- If a site uses reCAPTCHA or Cloudflare challenges, those typically require
  interaction on first visit, then subsequent visits are cookie-gated

## Why a Separate Container?

- **Image size** — avoids adding ~300 MB of Chromium + deps to the Gateway image
- **Isolation** — Chrome runs in its own process tree; a crash doesn't affect
  the Gateway
- **Upgradeable** — rebuild `chrome/Dockerfile` independently of the Gateway image
- **Persistent state** — the `chrome-data` volume keeps cookies/sessions across
  restarts and image rebuilds
- **Standard pattern** — same sidecar approach used for Tailscale

## Related

- [Tailscale Sidecar](tailscale-sidecar.md) — the networking sidecar that
  this container joins
- `chrome/Dockerfile` — the Chromium sidecar image definition
- `src/browser/config.ts` — browser config resolution
- `src/browser/chrome.ts` — Chrome launch and CDP connection logic
- `src/browser/pw-session.ts` — Playwright CDP session management
