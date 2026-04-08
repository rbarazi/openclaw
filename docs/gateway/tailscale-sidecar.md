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
                           |                          |
                           |  openclaw-cli            |
                           |    (OPENCLAW_CLI_BIND=   |
                           |     loopback)            |
                           +--------------------------+
```

- The `tailscale`, `openclaw-gateway`, and `openclaw-cli` containers all share
  the same network namespace via `network_mode: "service:tailscale"`.
- Tailscale Serve listens on port 443 on the Tailscale IP and proxies to
  `http://127.0.0.1:18789` (the gateway).
- Host port mappings (18789, 18790) are on the `tailscale` container since it
  owns the network namespace.
- The CLI uses `OPENCLAW_CLI_BIND=loopback` to connect via `127.0.0.1`
  instead of the container's LAN IP. This is required for automatic device
  pairing (the gateway auto-approves loopback connections).
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
          "Proxy": "http://127.0.0.1:18789"
        }
      }
    }
  }
}
```

`${TS_CERT_DOMAIN}` is auto-expanded by the Tailscale container to the node's
MagicDNS hostname. No `AllowFunnel` key — this is Serve-only.

**Important:** Use `127.0.0.1` (not `localhost`) in the proxy URL. Inside the
container, `localhost` may resolve to the IPv6 loopback `[::1]` first, but the
Gateway only listens on IPv4. Using `localhost` causes intermittent
`dial tcp [::1]:18789: connect: connection refused` proxy errors.

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

## CLI Container Networking

The CLI container **must** share the gateway's network namespace and override
the bind mode to `loopback`. Without this, two things go wrong:

1. The CLI resolves the gateway URL using the config's `gateway.bind` setting
   (typically `lan`), which picks up the container's LAN IP instead of
   `127.0.0.1`.
2. The gateway requires **device pairing** for non-loopback connections.
   Loopback connections are auto-approved; LAN connections require manual
   approval.

The `OPENCLAW_CLI_BIND` environment variable overrides the config's bind mode
for the CLI's gateway URL resolution without affecting the gateway's listen
address.

```yaml
# docker-compose.yml (CLI service)
openclaw-cli:
  image: ${OPENCLAW_IMAGE:-openclaw:local}
  network_mode: "service:tailscale"
  depends_on:
    - tailscale
  environment:
    OPENCLAW_CLI_BIND: loopback   # connect to gateway via 127.0.0.1
    OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN}
    # ...
```

This ensures:
- CLI connects to `ws://127.0.0.1:18789` (loopback)
- Gateway auto-approves the device pairing (silent, no manual step)
- The gateway still listens on all interfaces via its own `--bind lan` flag

## Data Persistence

| Path (container) | Mounted from | Persists across restarts? |
|---|---|---|
| `/home/node/.openclaw/` | `${OPENCLAW_CONFIG_DIR}` (host bind mount) | Yes |
| `/home/node/.openclaw/workspace/` | `${OPENCLAW_WORKSPACE_DIR}` (host bind mount) | Yes |
| `/home/node/.config/op/` | `op-config` (named volume) | Yes (unless `docker compose down -v`) |
| `/var/lib/tailscale/` | `ts-state` (named volume) | Yes (unless `docker compose down -v`) |
| `/tmp/openclaw/` | Not mounted | No (lost on container restart) |

Key files in the config directory:

- `openclaw.json` — main config (auth, channels, agents, etc.)
- `devices/paired.json` — paired device registry
- `devices/pending.json` — pending pairing requests
- `identity/device.json` — device Ed25519 keypair (shared by all CLI runs)
- `agents/<agentId>/sessions/` — chat history and session data

The config and workspace directories are bind-mounted from the host, so they
survive image rebuilds, container recreation, and `docker compose down`.
Named volumes (`ts-state`, `op-config`) survive restarts but are deleted by
`docker compose down -v`.

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

### 7. IPv6 proxy errors: `dial tcp [::1]:18789: connection refused`

The Tailscale Serve proxy resolves `localhost` to `[::1]` (IPv6) first, but
the Gateway only listens on IPv4.

**Fix:** Use `127.0.0.1` instead of `localhost` in `tailscale-serve.json`:

```json
"Proxy": "http://127.0.0.1:18789"
```

### 8. CLI fails with "pairing required" (1008)

The CLI connects to the gateway but the connection is rejected because the
device isn't paired. Two common causes:

**a) CLI not using loopback.** If the CLI connects via a LAN IP, the gateway
treats it as a remote connection and requires manual pairing. Check the error
output for `Source: local lan` — it should say `Source: local loopback`.

**Fix:** Ensure the CLI service has `OPENCLAW_CLI_BIND: loopback` in its
environment and `network_mode: "service:tailscale"` in docker-compose.

**b) Stale pending pairing request.** If a previous connection attempt created
a pending request from a LAN IP (with `silent: false`), subsequent loopback
connections reuse the stale request and don't auto-approve.

**Fix:** Clear the pending requests and retry:

```bash
docker compose exec openclaw-gateway \
  sh -c 'echo "{}" > /home/node/.openclaw/devices/pending.json'
```

### 9. macOS Docker Desktop and TUN devices

On Docker Desktop for macOS, the `/dev/net/tun` device may not be available
in the Linux VM. If the Tailscale container fails to start in kernel mode:

**Fix:** Set `TS_USERSPACE=true` in your `.env` file to use userspace
networking instead of kernel TUN.

## Related Sidecars

- [Browser Sidecar](browser-sidecar.md) — headless Chrome container for the
  Gateway's browser agent features, using the same shared-network pattern

## Relation to Built-in Tailscale Support

The Gateway has built-in Tailscale Serve/Funnel support via `--tailscale serve`
and `--tailscale funnel` (see [tailscale.md](tailscale.md)). That approach
requires the `tailscale` CLI to be installed inside the container.

The sidecar approach is preferred for Docker deployments because:
- No need to install `tailscale` in the Gateway image
- Tailscale state persists in a named volume (`ts-state`)
- Separation of concerns — Gateway handles the app, sidecar handles networking
- Standard Docker pattern for sidecar services
