# Deploying to a VPS

Production checklist + step-by-step for an Ubuntu/Debian VPS. The app is
**Next.js (Node server) + MySQL + LiveKit Cloud**.

> ⚠️ **HTTPS is mandatory.** Two things break without it:
> 1. The login cookie is `secure` in production — over plain HTTP the browser
>    drops it and **nobody can stay logged in**.
> 2. Camera / mic / screen-share (`getUserMedia` / `getDisplayMedia`) only work
>    on **HTTPS** (or `localhost`).
> So you must put it behind Nginx + a Let's Encrypt certificate (steps below).

---

## 0. Before you start
- A VPS with **Ubuntu 22.04+** and a **domain name** pointed at its IP (an `A` record).
- **Node.js 18+** and **MySQL 8** installed on the VPS.
- Your **LiveKit Cloud** key/secret/URL.

🔐 **Rotate your secrets** before going live: the LiveKit API secret, MySQL
password, and `AUTH_SECRET` were shared during development. Generate a fresh
`AUTH_SECRET` with:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 1. Install prerequisites on the VPS
```bash
sudo apt update && sudo apt install -y nginx mysql-server
# Node 20 via nodesource:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 2. Create the database
```bash
sudo mysql
```
```sql
CREATE DATABASE video_call_tool CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'raceapp'@'localhost' IDENTIFIED BY 'a-strong-password';
GRANT ALL PRIVILEGES ON video_call_tool.* TO 'raceapp'@'localhost';
-- the app auto-creates tables on first boot, so no manual schema needed
FLUSH PRIVILEGES;
EXIT;
```

## 3. Get the code onto the VPS
Either `git clone` (push it to GitHub first) or copy with `scp`/`rsync`:
```bash
sudo mkdir -p /var/www/race-innovations
sudo chown -R $USER:$USER /var/www/race-innovations
# from your PC:  rsync -av --exclude node_modules --exclude .next ./ user@SERVER:/var/www/race-innovations/
cd /var/www/race-innovations
```

## 4. Configure environment
**Copy `.env.production.example` to `.env.local` and fill it in** — it is the
single source of truth and covers every feature:

```bash
cp .env.production.example .env.local
nano .env.local
```

It contains: MySQL, `AUTH_SECRET`, LiveKit, S3 recording (`AWS_S3_*`),
SES password-reset email (`SES_FROM`, `AWS_SES_REGION`), the public app URL,
and Google Sign-In + Calendar (`GOOGLE_*`). Anything you leave blank simply
disables that feature — except MySQL/`AUTH_SECRET`/LiveKit, which are required.

> ❗ **Build-time vars.** Every `NEXT_PUBLIC_*` value is baked into the client
> bundle when you build — `NEXT_PUBLIC_LIVEKIT_URL`, `NEXT_PUBLIC_APP_URL` and
> `NEXT_PUBLIC_S3_BUCKET_URL` must all be set **before** `npm run build`
> (next step). If you change one later, rebuild.

> ❗ **Google OAuth.** Register both redirect URIs on the OAuth client for your
> real domain, or Sign-In/Calendar fail with `redirect_uri_mismatch`:
> `https://YOUR-DOMAIN/api/auth/google/callback` and
> `https://YOUR-DOMAIN/api/calendar/google/callback`.

> ❗ **SES.** `SES_FROM` must be an identity verified in SES, and the account
> must be out of the SES sandbox to email arbitrary recipients — otherwise the
> reset code silently never arrives.

## 5. Install, build, run
```bash
npm ci
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # run the command it prints, to start on reboot
```
The app is now running on `127.0.0.1:3009` (the port set in `ecosystem.config.cjs`).

## 6. Nginx reverse proxy
```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/race-innovations
sudo nano /etc/nginx/sites-available/race-innovations   # set your server_name
sudo ln -s /etc/nginx/sites-available/race-innovations /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
The config already sets `client_max_body_size 1024M` so 1 GB uploads work.

## 7. HTTPS (Let's Encrypt)
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```
Certbot adds the 443 block + auto-renewal. Done — open `https://your-domain.com`.

---

## Updating after changes
```bash
cd /var/www/race-innovations
git pull            # or rsync again
npm ci
npm run build
pm2 restart meetings-app
```

## Operating notes
- **Logs:** `pm2 logs meetings-app`
- **Uploads** live in `public/uploads/` on the server's disk. Back this folder
  up; it is **not** in git. For multiple servers or durability, move uploads to
  S3-compatible storage later.
- **Keep `instances: 1`** in PM2 — typing indicators and presence heartbeats use
  in-process memory, so multiple instances would desync them.
- **Firewall:** allow 80/443 (`sudo ufw allow 'Nginx Full'`); keep 3009 internal.
- **DB backups:** `mysqldump video_call_tool > backup.sql` on a cron.
