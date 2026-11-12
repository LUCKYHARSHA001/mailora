#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Bootstrap a Let's Encrypt certificate for ONE VM.
#
# Run it from inside a VM folder (it targets that folder's docker-compose.yml):
#
#   cd deploy/vm2-server
#   DOMAIN=server.mail-or-a.dev EMAIL=you@example.com ../common/init-letsencrypt.sh
#
# Prerequisites:
#   - DNS A record for $DOMAIN already points at this VM.
#   - Ports 80 and 443 are open to the internet on this VM.
#   - Docker + Docker Compose v2 are installed.
#
# Set STAGING=1 while testing to use Let's Encrypt's staging CA (avoids hitting
# the strict rate limits with a bad config), then re-run with STAGING=0.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${DOMAIN:?set DOMAIN, e.g. DOMAIN=server.mail-or-a.dev}"
: "${EMAIL:?set EMAIL, e.g. EMAIL=you@example.com}"
STAGING="${STAGING:-0}"

data_path="./certbot"
rsa_key_size=4096

if ! docker compose config >/dev/null 2>&1; then
  echo "ERROR: run this from inside a VM folder that has a docker-compose.yml" >&2
  exit 1
fi

if [ -d "$data_path/conf/live/$DOMAIN" ]; then
  read -r -p "Existing certificate for $DOMAIN found. Replace it? (y/N) " decision
  case "$decision" in
    y|Y) : ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

# 1. Recommended TLS parameters (referenced by the nginx server block).
if [ ! -e "$data_path/conf/options-ssl-nginx.conf" ] || [ ! -e "$data_path/conf/ssl-dhparams.pem" ]; then
  echo "### Downloading recommended TLS parameters ..."
  mkdir -p "$data_path/conf"
  curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf \
    > "$data_path/conf/options-ssl-nginx.conf"
  curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot/certbot/ssl-dhparams.pem \
    > "$data_path/conf/ssl-dhparams.pem"
fi

# 2. Dummy self-signed cert so nginx can start on :443 before the real one exists.
echo "### Creating dummy certificate for $DOMAIN ..."
live_path="/etc/letsencrypt/live/$DOMAIN"
mkdir -p "$data_path/conf/live/$DOMAIN"
docker compose run --rm --entrypoint "\
  openssl req -x509 -nodes -newkey rsa:$rsa_key_size -days 1 \
    -keyout '$live_path/privkey.pem' \
    -out '$live_path/fullchain.pem' \
    -subj '/CN=localhost'" certbot

# 3. Start nginx (and its app dependency) with the dummy cert.
echo "### Starting nginx ..."
docker compose up --force-recreate -d nginx

# 4. Remove the dummy cert so certbot can write the real one.
echo "### Deleting dummy certificate for $DOMAIN ..."
docker compose run --rm --entrypoint "\
  sh -c 'rm -Rf /etc/letsencrypt/live/$DOMAIN \
                /etc/letsencrypt/archive/$DOMAIN \
                /etc/letsencrypt/renewal/$DOMAIN.conf'" certbot

# 5. Request the real certificate via the HTTP-01 webroot challenge.
echo "### Requesting Let's Encrypt certificate for $DOMAIN ..."
staging_arg=""
[ "$STAGING" != "0" ] && staging_arg="--staging"
docker compose run --rm --entrypoint "\
  certbot certonly --webroot -w /var/www/certbot \
    $staging_arg \
    --email $EMAIL \
    -d $DOMAIN \
    --rsa-key-size $rsa_key_size \
    --agree-tos \
    --no-eff-email \
    --force-renewal" certbot

# 6. Reload nginx with the real certificate.
echo "### Reloading nginx ..."
docker compose exec nginx nginx -s reload

echo "### Done. https://$DOMAIN should now serve a valid certificate."
echo "### Bring the whole stack up with:  docker compose up -d --build"
