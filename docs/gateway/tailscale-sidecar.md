---
summary: "Docker Tailscale sidecar container for Gateway dashboard access"
read_when:
  - Running Gateway in Docker with Tailscale
  - Tailscale sidecar container setup
  - Docker Compose tailnet access
title: "Tailscale Sidecar (Docker)"
---

# Tailscale Sidecar Container for Gateway (Docker)

When running the Gateway via Docker Compose, the built-in `--tailscale serve`
mode doesn't work because the `tailscale` CLI binary isn't available inside the
Gateway container. Instead, a dedicated Tailscale sidecar container runs
alongside the Gateway, sharing the same network namespace.

The sidecar runs Tailscale **Serve** (private tailnet-only access, NOT Funnel),
which proxies HTTPS on port 443 to the Gateway's HTTP port. The Gateway itself
runs with `--tailscale off` since the sidecar handles Tailscale integration.

## Architecture

```
                              Shared network namespace
                           +--------------------------+
                           |                          |
  Tailnet (HTTPS:443) ──> |  tailscale container     |
   (private, tailnet       |    tailscaled + serve    |
    devices only)          |      │ proxy to gateway  |
                           |      ▼                   |
  Host :18789 ──────────> |  openclaw-gateway        |
  Host :18790 ──────────> |    (bind lan)            |
                           +--------------------------+
```

- The `tailscale` container and `openclaw-gateway` share `localhost` via
  `network_mode: "service:tailscale"`.
- Tailscale Serve listens on port 443 on the Tailscale IP and proxies to
  `http://localhost:18789` (the gateway).
- Host port mappings (18789, 18790) are on the `tailscale` container since it
  owns the network namespace.
- Access is **private** — only devices connected to your Tailscale network can
  reach the dashboard via `https://<hostname>.ts.net/`.

## Prerequisites

1. A Tailscale account with **HTTPS certificates enabled**
   (Tailscale admin console > DNS > HTTPS Certificates)
2. A Tailscale auth key
   (generate at https://login.tailscale.com/admin/settings/keys)

## Setup

```bash
TS_AUTHKEY=tskey-auth-... ./docker-setup.sh
```

The setup script will:
- Export `TS_AUTHKEY` and `TS_USERSPACE` to the `.env` file
- Warn if `TS_AUTHKEY` is not set
- Start the Tailscale sidecar alongside the gateway

## Accessing the Dashboard

After startup, the dashboard is available via three methods:

| Method | URL | When to use |
|---|---|---|
| Tailscale Serve (HTTPS) | `https://<hostname>.ts.net/` | From any tailnet device |
| Tailscale IP | `http://<tailscale-ip>:18789` | Direct access from tailnet |
| Host port mapping | `http://localhost:18789` | From the Docker host machine |

To find your Tailscale hostname:

```bash
docker compose exec tailscale tailscale status
```

## Files

| File | Purpose |
|---|---|
| `tailscale-serve.json` | Tailscale Serve proxy config (HTTPS 443 -> localhost:18789) |
| `docker-compose.yml` | Defines the `tailscale` sidecar service and gateway networking |
| `docker-setup.sh` | Handles `TS_AUTHKEY` and `TS_USERSPACE` env vars |

### tailscale-serve.json

```json
{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "${TS_CERT_DOMAIN}:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://localhost:18789"
        }
      }
    }
  }
}
```

`${TS_CERT_DOMAIN}` is auto-expanded by the Tailscale container to the node's
MagicDNS hostname. No `AllowFunnel` key — this is Serve-only.

## Useful Commands

```bash
# Check container status
docker compose ps

# Gateway logs
docker compose logs -f openclaw-gateway

# Tailscale logs
docker compose logs -f tailscale

# Tailscale network status
docker compose exec tailscale tailscale status

# Tailscale serve status
docker compose exec tailscale tailscale serve status

# Health check
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

## Gotchas and Troubleshooting

### 1. "tailscale serve/funnel requires gateway bind=loopback"

This error occurs when the Gateway config file (`~/.openclaw/openclaw.json`)
has `gateway.tailscale.mode: "serve"` but the Gateway is started with
`--bind lan`. The validation requires `bind=loopback` when the *built-in*
Tailscale mode is active.

**Fix:** The sidecar approach passes `--tailscale off` to the gateway, which
disables the built-in Tailscale integration entirely. The sidecar handles
Tailscale instead.

### 2. HTTPS certificates must be enabled on your tailnet

Tailscale Serve requires HTTPS to be enabled for your tailnet. Without it, the
serve config is silently ignored and you'll see this in the logs:

```
serve proxy: this node is configured as a proxy that exposes an HTTPS
endpoint to tailnet, but it is not able to issue TLS certs
```

**Fix:** Enable HTTPS in the Tailscale admin console:
Tailscale admin > DNS > scroll to "HTTPS Certificates" > enable.
Then restart the tailscale container: `docker compose restart tailscale`.

### 3. Serve config shows "No serve config" despite file being mounted

This happens when HTTPS isn't enabled (see above). The Tailscale container
loads the config file but can't activate it without TLS cert capability.
After enabling HTTPS and restarting, you should see:

```
serve proxy: applying serve config
listening on <tailscale-ip>:443
```

### 4. Port mappings must be on the tailscale container, not the gateway

When using `network_mode: "service:tailscale"`, the gateway shares the
tailscale container's network namespace. Docker requires port mappings to be
declared on the container that owns the network namespace (tailscale), not on
containers that join it (gateway).

### 5. Old `.env` values override new defaults

If you previously ran `docker-setup.sh`, the `.env` file may contain stale
values (e.g., `OPENCLAW_GATEWAY_BIND=loopback`). Docker Compose reads `.env`
and its values take precedence over defaults in `docker-compose.yml`.

**Fix:** Re-run `docker-setup.sh` to update `.env`, or edit `.env` manually.

### 6. Containers must be recreated after compose file changes

Running `docker compose up -d` only starts new/stopped containers. To pick up
changes to the compose file (new services, updated commands), use:

```bash
docker compose down && docker compose up -d openclaw-gateway
```

## Relation to Built-in Tailscale Support

The Gateway has built-in Tailscale Serve/Funnel support via `--tailscale serve`
and `--tailscale funnel` (see [tailscale.md](tailscale.md)). That approach
requires the `tailscale` CLI to be installed inside the container.

The sidecar approach is preferred for Docker deployments because:
- No need to install `tailscale` in the Gateway image
- Tailscale state persists in a named volume (`ts-state`)
- Separation of concerns — Gateway handles the app, sidecar handles networking
- Standard Docker pattern for sidecar services
