# MailOra — 4-VM Deployment

Each service runs on its own VM behind its own subdomain, with an Nginx TLS
reverse proxy + Let's Encrypt (certbot) in front. A single `docker-compose.yml`
can't span hosts, so there's one compose file per VM under `deploy/`. Each
compose file reuses that service's existing `.env`, so secrets aren't duplicated.

```
VM1  mail-or-a.dev          → nginx(TLS) → client (React SPA)
VM2  server.mail-or-a.dev   → nginx(TLS) → server  + Kafka + Zookeeper + Redis
VM3  whatsapp.mail-or-a.dev → nginx(TLS) → whatsapp-service (whatsapp-web.js)
VM4  jobs.mail-or-a.dev     → nginx(TLS) → serpapiservice (job-feed cron)
```

**MongoDB is MongoDB Atlas** (shared by server + serpapi via `MONGO_URI`) — not
self-hosted. Only **Kafka + Zookeeper + Redis** are self-hosted, on VM2.

## Layout

```
deploy/
  common/init-letsencrypt.sh    # one-time cert bootstrap, run per VM
  vm1-client/
    docker-compose.yml          # client + nginx + certbot
    nginx/conf.d/app.conf       # mail-or-a.dev → client:80
  vm2-server/
    docker-compose.yml          # server + kafka + zookeeper + redis + nginx + certbot
    nginx/conf.d/app.conf       # server.mail-or-a.dev → server:5000
  vm3-whatsapp/  (…)            # whatsapp.mail-or-a.dev → whatsapp-service:5002
  vm4-serpapi/   (…)            # jobs.mail-or-a.dev → serpapiservice:5001
```

Env each VM reads: VM1 `client/.env` (build-time), VM2 `server/.env`,
VM3 `whatsapp-service/.env`, VM4 `serpapiservice/.env`.

## Prerequisites (per VM)

1. Docker + Docker Compose v2, and the repo cloned.
2. **DNS A record** for the VM's subdomain points at that VM (see table below).
3. Ports **80 and 443 open** to the internet (for the ACME challenge + HTTPS).
4. That service's `.env` present (all exist except whatsapp, which is provided).
5. **Atlas IP allowlist** includes each VM's egress IP (VM2 + VM4 use Atlas).

| Record                     | → VM  |
|----------------------------|-------|
| `mail-or-a.dev`            | VM1   |
| `server.mail-or-a.dev`     | VM2   |
| `whatsapp.mail-or-a.dev`   | VM3   |
| `jobs.mail-or-a.dev`       | VM4   |

## Deploy a VM (same 3 steps each)

Bring **VM2 up first** — Kafka must exist before the whatsapp consumer connects.

```bash
cd deploy/vm2-server

# 1. Issue the TLS cert (needs DNS + ports 80/443 live). Test with STAGING=1 first
#    to avoid Let's Encrypt rate limits, then re-run with STAGING=0.
DOMAIN=server.mail-or-a.dev EMAIL=nrokzzzz@gmail.com ../common/init-letsencrypt.sh

# 2. Bring the whole stack up
docker compose up -d --build

# 3. Verify
curl -I https://server.mail-or-a.dev/health
```

Repeat per VM, swapping the folder + `DOMAIN`:

| VM  | Folder                | DOMAIN                    | After up |
|-----|-----------------------|---------------------------|----------|
| VM1 | `deploy/vm1-client`   | `mail-or-a.dev`           | —        |
| VM2 | `deploy/vm2-server`   | `server.mail-or-a.dev`    | —        |
| VM3 | `deploy/vm3-whatsapp` | `whatsapp.mail-or-a.dev`  | `docker compose logs -f whatsapp-service` → **scan the QR once** |
| VM4 | `deploy/vm4-serpapi`  | `jobs.mail-or-a.dev`      | —        |

Certs auto-renew: the `certbot` container runs `certbot renew` every 12h and the
`nginx` container reloads every 6h to pick up new certs.

## Cross-VM firewall

| On   | Port  | From        | Why                          |
|------|-------|-------------|------------------------------|
| all  | 80,443| internet    | ACME challenge + HTTPS        |
| VM2  | 9092  | VM3 only    | whatsapp consumer → Kafka    |

> Kafka :9092 is PLAINTEXT with no auth — restrict it to the whatsapp VM's IP.
> Prefer the **private IP** between VM2↔VM3: set `KAFKA_EXTERNAL_HOST=<VM2-priv-ip>`
> in VM2's environment **and** `KAFKA_BROKERS=<VM2-priv-ip>:9092` in
> `whatsapp-service/.env` (both must match).

## Gotchas baked into these files

- **Client is build-time configured.** Vite bakes `VITE_*` from `client/.env`
  into the static bundle — always `--build` after editing it.
- **WhatsApp needs Chromium.** Its Dockerfile ships system Chromium for Puppeteer
  and persists the login in the `wa_session` volume; `/health` only responds
  after the QR is scanned (expect `unhealthy` until then). `PORT` is pinned 5002.
- **serpapi health** is checked at `/` (there is no `/health` route).
- **Recommended app tweak:** add `app.set('trust proxy', 1)` in the server so
  `express-rate-limit` keys on the real client IP (X-Forwarded-For) rather than
  the nginx container IP. Not required for auth/cookies to work.
- **certbot/nginx dirs** (`*/certbot/conf`, `*/certbot/www`) are created at
  deploy time and gitignored.
```
