# Deployment

The app ships as a container. `docker compose up` is the whole deployment, with two
volumes: the forms folder mounted **read-only**, and a named volume for the database.

## Local

```bash
cp .env.example .env
# edit .env: FORMS_HOST_DIR -> absolute path to the forms folder
#            SESSION_SECRET -> openssl rand -hex 32
docker compose up -d
curl -fsS localhost:30000/api/me   # -> null (signed out)
```

## Behind a reverse proxy

On a host already running other services behind nginx, two things matter.

### 1. Bind to loopback, not 0.0.0.0

`compose.yaml` publishes `${PORT:-30000}:3000`, which binds **all interfaces**. On a
shared host that exposes the app directly, bypassing the proxy and any access control in
front of it. Add a `compose.override.yaml` beside it:

```yaml
services:
  app:
    ports: !override
      - "127.0.0.1:30000:3000"
```

The proxy then becomes the only route in. Verify after starting:

```bash
docker ps --filter name=app --format '{{.Ports}}'   # expect 127.0.0.1:30000->3000/tcp
curl --max-time 6 http://<public-ip>:30000/api/me   # expect: connection refused
```

That second check is the one that matters. A container you *believe* is internal but
which answers on the public interface is worse than one you know is public.

### 2. nginx server block

```nginx
server {
    server_name eform.example.com;

    # Signature PNGs arrive as data URLs inside JSON; the app caps its own
    # body at 4mb. Size above that.
    client_max_body_size 8M;

    location /.well-known/acme-challenge/ { root /var/www/eform.example.com; }

    location / {
        proxy_pass http://127.0.0.1:30000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Generating an archival PDF parses a workbook and renders it; allow
        # more than the 60s default so a large form does not 504.
        proxy_read_timeout 120s;
    }

    listen 80;
}
```

Then:

```bash
mkdir -p /var/www/eform.example.com
ln -s /etc/nginx/sites-available/eform.example.com.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d eform.example.com --redirect
```

Certbot inserts the TLS directives and the `:80 -> :443` redirect.

**Check DNS resolves to the target host before running certbot.** The HTTP-01 challenge
is served by this host, so an A record pointing elsewhere fails issuance — and the failure
message describes a challenge error rather than a DNS mismatch, which sends you looking in
the wrong place. `dig +short @1.1.1.1 <host>` bypasses a stale local cache.

## Before exposing it publicly

The app seeds four demo accounts on first run — `admin`, `tech`, `lead`, `eng`, each with
its username as the password. They exist so the sign-off chain can be walked immediately.

**They must be replaced before the app is reachable from the internet.** Anyone who finds
the URL is otherwise an administrator. Sign in as admin, create real accounts, then
deactivate all four demos from the admin screen.

While an instance is staged with demo accounts still live, keep it out of search results:

```nginx
add_header X-Robots-Tag "noindex, nofollow" always;
```

Remove that line once real credentials are in place. It slows discovery; it is not
access control, and should never be relied on as such.

## Data

- The database lives on the `pm-data` named volume. `docker compose down` preserves it;
  **`docker compose down -v` destroys it**, including every signed record.
- The forms folder is mounted `:ro`. The app cannot modify a source form even if it tried —
  the guarantee is enforced by the kernel rather than by convention.
- Form files are not in this repository and never should be. Copy them to the host
  separately and point `FORMS_HOST_DIR` at them.

## Updating

```bash
git pull
docker compose build
docker compose up -d
```

The database volume survives. Forms are re-scanned at boot when `FORMS_DIR` is set and no
folder has been configured yet; otherwise an admin can rescan from the admin screen.
