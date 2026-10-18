# Frugal Shopper

A shared shopping list for two people in two shops at the same time. Both phones show the same list with
each shop's price side by side. Whoever's shop is cheaper buys it and ticks it off with the price paid, and the
other phone sees the tick straight away.

Built for Cody at Aldi and Jess at M&S, but the shops and people are settings.

## How it works in the shop

1. Open the site on both phones, enter the passcode once, pick who you are and which shop you're in.
2. Either of you adds items to the list.
3. Tap your shop's box on an item to enter the price and pack size (e.g. `7.59` and `750g`). The other phone
   sees it instantly, so you don't need to send prices to each other in a chat.
4. The cheaper shop is highlighted. With pack sizes filled in, it compares per kg, litre or item, so a 500g
   pack and a 1kg pack are compared fairly. If only one side has a size you get a warning instead of a
   misleading answer.
5. Whoever is in the cheaper shop taps the tick box, confirms the price paid (it's pre-filled from the price
   they entered) and it moves to **In the basket** on both phones, with a pop-up on the other phone saying
   who bought what and where.
6. The bar at the bottom shows what's been spent in each shop, the total, how much you saved compared with
   the other shop, and how many items are left.
7. When you're done, **Clear ticked items** empties the basket for the next shop.

Filters at the top show **Cheapest here** (what you should pick up in your shop) and **Needs my price** (what
you still need to look up).

If a phone loses signal, changes are kept on the phone and sent when it reconnects (the badge in the top
right shows `Offline · 2 unsent`). The last list seen is also kept on the phone, so it still shows with no
signal.

## Deploying with Portainer

The image runs as a non-root user, keeps its SQLite database in the `/data` volume, has a Docker health check
and listens on port 3000 inside the container (published on **8085** by default).

### Option A: build from this repository (recommended)

1. Portainer > **Stacks** > **Add stack**, name it `frugal-shopper`.
2. Build method: **Repository**.
   - Repository URL: `https://github.com/codylovelace/frugal-shopper`
   - Repository reference: `refs/heads/main`
   - Compose path: `docker-compose.yml`
   - If the repository is private, turn on **Authentication** and use your GitHub username with a
     fine-grained personal access token that has read-only **Contents** access to this repository.
3. Under **Environment variables** add at least `APP_PASSCODE` (see the table below).
4. Optional: turn on **GitOps updates** (polling) so Portainer rebuilds the stack when `main` changes.
5. **Deploy the stack**, then open `http://<docker-host-ip>:8085` on both phones.

### Option B: pull the pre-built image

GitHub Actions publishes `ghcr.io/codylovelace/frugal-shopper:latest` (amd64 and arm64) on every push to
`main`. Paste `docker-compose.ghcr.yml` into Portainer's **Web editor** instead. If the repository is private
the image is too, so first add `ghcr.io` under Portainer > **Registries** (username: your GitHub login,
password: a classic token with `read:packages`).

### Settings

| Variable         | Default              | What it does                                                                                                                                                             |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_PASSCODE`   | _(empty)_            | Shared passcode each phone enters once (kept signed in for `SESSION_DAYS`). Empty means no passcode: only do that on a LAN you trust. Changing it signs every phone out. |
| `STORES`         | `Aldi,M&S`           | The shops shown side by side, 2 to 4, comma separated.                                                                                                                   |
| `PEOPLE`         | `Cody:Aldi,Jess:M&S` | Who uses it, as `Name` or `Name:Usual shop`. The usual shop is pre-selected when that person picks their name.                                                           |
| `HOST_PORT`      | `8085`               | Port published on the Docker host (compose files only).                                                                                                                  |
| `TRUST_PROXY`    | `false`              | Set to `true` behind a reverse proxy, so the sign-in cookie is marked Secure on HTTPS and lock-outs use the real client IP.                                              |
| `SESSION_DAYS`   | `90`                 | How long a phone stays signed in.                                                                                                                                        |
| `SESSION_SECRET` | _(generated)_        | Key that signs the sign-in cookie. Generated and stored in the database if not set.                                                                                      |
| `APP_TITLE`      | `Frugal Shopper`     | Name shown at the top of the page.                                                                                                                                       |

A bad setting stops the container with a message naming the variable; check the container logs in Portainer.

### Using it away from home

On the home Wi-Fi `http://<docker-host-ip>:8085` is enough. In the shops your phones are on mobile data, so the
site has to be reachable from outside. Rather than forwarding the port on your router, put it behind a reverse
proxy with HTTPS (Nginx Proxy Manager, Traefik, Caddy) or a Cloudflare Tunnel, set `TRUST_PROXY=true`, and
keep `APP_PASSCODE` set. The proxy must allow WebSockets (in Nginx Proxy Manager tick **Websockets Support**).
Tailscale on both phones is another good option that keeps it off the public internet entirely.

Over HTTPS you can also use "Add to Home Screen" on iPhone or "Install app" on Android to open it like an app.

### Backups and updates

Everything lives in the `frugal-shopper-data` volume (`/data/frugal-shopper.db`). To take a consistent copy
while it's running:

```sh
docker exec frugal-shopper node -e "new (require('better-sqlite3'))('/data/frugal-shopper.db').backup('/data/backup.db').then(()=>console.log('ok'))"
```

then copy `backup.db` out of the volume (or include the volume in your Proxmox / Synology backups).
Database upgrades between versions run automatically on start-up.

If you swap the named volume for a bind mount, the folder must be writable by uid 1000
(`chown -R 1000:1000 <folder>`); the container prints that instruction if it can't write.

## Development

Needs Node.js 22 or newer.

```sh
npm install
npm run dev     # http://localhost:3000, restarts on changes
npm test        # unit and integration tests (node:test)
```

The code is small and has no build step:

- `server/` HTTP + WebSocket server. `ops.js` validates every change, `db.js` stores it in SQLite,
  `auth.js` handles the passcode cookie.
- `public/` the phone UI in plain JavaScript. `js/compare.js` (prices, pack sizes, cheapest shop, savings)
  is shared with the server tests.

Every change a phone makes carries an id. The server applies each id once and confirms it, and the phone
resends anything unconfirmed after a reconnect, so a flaky signal can't lose or double a tick.
