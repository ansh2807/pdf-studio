# Deploying Local PDF Studio (the hosted version)

This is the public version for your family, friends, and anyone with the link.
It runs everything **server-side inside one Docker container** — LibreOffice for
Office → PDF, headless Chromium for HTML → PDF, and Python/PyMuPDF for
compression, conversions, and watermark removal — so every tool works for
visitors who don't have any of that installed.

You need: a small VPS (any provider), a domain name, and about 15 minutes.

---

## 1. Get a server and point your domain at it

1. Buy a VPS. **2 GB RAM** is comfortable (1 GB works for light use; LibreOffice
   + Chromium are the memory-hungry parts). Ubuntu 22.04/24.04 is a fine choice.
2. Note the server's public IP address.
3. In your domain registrar's DNS settings, add an **A record** pointing your
   chosen name (e.g. `pdf.yourdomain.com`) to that IP. DNS can take a few
   minutes to propagate.

## 2. Install Docker on the server

SSH in, then:

```bash
curl -fsSL https://get.docker.com | sh
```

That installs Docker Engine and the Compose plugin.

## 3. Upload this folder

Copy this `pdf-studio-hosted` folder to the server (via `scp`, `rsync`, git, or
your host's file manager). For example, from your PC:

```bash
scp -r "pdf-studio-hosted" user@YOUR_SERVER_IP:~/pdf-studio
```

## 4. Set your domain and start it

On the server, inside the uploaded folder:

```bash
cp .env.example .env
nano .env          # set SITE_ADDRESS=pdf.yourdomain.com
docker compose up -d --build
```

The first build takes a few minutes (it downloads LibreOffice and Chromium).
When it finishes, open **https://pdf.yourdomain.com** — Caddy fetches a free,
auto-renewing HTTPS certificate the first time it's hit.

That's it. It's live.

---

## Everyday commands

```bash
docker compose logs -f app      # watch the engine logs
docker compose ps               # see what's running
docker compose up -d --build    # rebuild after you change the code
docker compose down             # stop everything
docker compose pull caddy       # update the proxy
```

## Test without a domain first (optional)

Set `SITE_ADDRESS=:80` in `.env`, run `docker compose up -d --build`, and open
`http://YOUR_SERVER_IP`. Switch to your real domain when DNS is ready.

Or run just the app container on a port, no proxy:

```bash
docker build -t pdf-studio .
docker run -d -p 8080:8080 --name pdf-studio pdf-studio
# open http://YOUR_SERVER_IP:8080
```

## How it verifies itself

Open the app and check the **Professional Engine** panel in the right sidebar —
it should say "Professional engine connected" with PyMuPDF, pikepdf, LibreOffice,
and HTML all lit. Every tool in **All Tools** that shows a green **pro** stamp is
running on the server engine.

## Notes & tuning

- **Memory:** if conversions of large Office files fail, give the VPS more RAM or
  add swap. LibreOffice is the heaviest step.
- **Upload size:** change `MAX_UPLOAD_MB` in `.env` (and the `max_size` in
  `Caddyfile`) if you need larger files. Default is 100 MB.
- **Privacy:** uploaded files are processed in a temporary folder and deleted
  immediately after each request; nothing is stored on disk.
- **Updates:** edit the code locally, re-upload, and run
  `docker compose up -d --build`.
- **Managed hosts:** the same image works on Render, Railway, or Fly.io — point
  them at this `Dockerfile`, set `PORT` per their docs (they inject it), and use
  their built-in TLS instead of the Caddy service.
