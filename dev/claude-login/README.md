# Claude GM login gate

This lets an automated browser (Claude Code, for live testing) log into Foundry as one dedicated GM user. That user
keeps a strong password, and no password or token ever passes through Claude.

```
Claude's browser ──(proxy adds "Authorization: Bearer <token>")──▶ https://<host>/claude-login
        Caddy ──▶ gate (127.0.0.1:30001) checks the token, logs into Foundry as the Claude GM user
        ◀── 302 /game + Foundry session cookie ── browser is now logged in
Every other path ──▶ Foundry as before (Caddy strips the Authorization header first)
```

- **The password** is stored only on the server, in `secrets.json` (mode 600).
- **The token** is stored on the server only as a SHA-256 hash. The real token lives only as a *network secret* on
  the Claude Code cloud environment, where the proxy injects it and nothing in the session can read it.
- **To revoke access,** change the hash in `secrets.json` (it's re-read on every request) or stop the gate.
  Changing the Claude GM user's password in Foundry also cuts access until `secrets.json` is updated.
- **What the token can do:** log in as that one user in the running world. It can't reach the setup/admin screen
  or other users.
- **After 5 bad tokens in 15 minutes,** the gate refuses everyone for 15 minutes.

These steps assume the layout from the wiki's *Always Free Oracle* guide: Ubuntu, Foundry on port 30000 run by
pm2, Caddy in front with `/etc/caddy/Caddyfile`. Check with `pm2 ls` and `cat /etc/caddy/Caddyfile`. If yours
differs, adapt the paths.

## 1. Create the Foundry user

In Foundry: **User Management** → add a user named `Claude GM` with role **Gamemaster** and a long random
password. To generate one on the server, run `openssl rand -base64 24`. Then get the user's id by running this in
the browser console (F12) while logged in as yourself:

```js
game.users.getName("Claude GM").id
```

## 2. Install the gate (on the server)

```bash
mkdir -p ~/claude-login && cd ~/claude-login
curl -fsSLO https://raw.githubusercontent.com/evanwapowell/ep-cosmere-automations/main/dev/claude-login/gate.mjs
```

(Until this is merged, replace `main` with the branch name.)

Make the token, and keep it on screen. You'll paste it into the Claude Code form in step 5, and nowhere else.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
```

Write `secrets.json`. It contains the token's hash, not the token:

```bash
umask 077
cat > secrets.json <<EOF
{
  "tokenSha256": "$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)",
  "userId": "PASTE_USER_ID_FROM_STEP_1",
  "password": "PASTE_CLAUDE_GM_PASSWORD"
}
EOF
unset TOKEN
nano secrets.json   # fill in userId and password
```

Start it under pm2, next to Foundry, so it survives reboots:

```bash
pm2 start ~/claude-login/gate.mjs --name claude-login
pm2 save
```

## 3. Route `/claude-login` in Caddy

Edit `/etc/caddy/Caddyfile`. Keep your existing lines, and wrap the Foundry proxy so `/claude-login` goes to the
gate and the injected header never reaches Foundry:

```caddy
your.domain {
    handle /claude-login {
        reverse_proxy 127.0.0.1:30001
    }
    handle {
        reverse_proxy localhost:30000 {
            header_up -Authorization
        }
    }
    encode zstd gzip
}
```

Then reload Caddy:

```bash
sudo systemctl reload caddy
```

## 4. Test it from the server

This needs a world launched. It should print `302` and a `session=` cookie:

```bash
curl -si -H "Authorization: Bearer <the token>" https://your.domain/claude-login | grep -iE '^HTTP|^location|^set-cookie'
```

Without the header it should print `403`. Watch attempts with `pm2 logs claude-login`.

## 5. Give Claude the token

In the Claude Code session, Claude asks for a network secret for your Foundry host. Paste the token into that
form (never into chat). Claude then logs in with `node dev/foundry-login.mjs` (set `FOUNDRY_URL`).

## Errors

| Status | Meaning |
| --- | --- |
| 403 | Token missing or wrong |
| 429 | Locked after bad tokens; wait 15 min or `pm2 restart claude-login` |
| 503 | No world launched (Foundry is on the setup screen) |
| 502 | Foundry refused the login: wrong `userId` or `password` in `secrets.json` |
| 500 | `secrets.json` missing or malformed (see `pm2 logs claude-login`) |
