<div align="center" width="100%">
    <img src="./public/icon.svg" width="128" alt="Uptime Kuma Logo" />
</div>

# Uptime Kuma

Uptime Kuma is an easy-to-use self-hosted monitoring tool.

<a target="_blank" href="https://github.com/louislam/uptime-kuma"><img src="https://img.shields.io/github/stars/louislam/uptime-kuma?style=flat" /></a> <a target="_blank" href="https://hub.docker.com/r/louislam/uptime-kuma"><img src="https://img.shields.io/docker/pulls/louislam/uptime-kuma" /></a> <a target="_blank" href="https://hub.docker.com/r/louislam/uptime-kuma"><img src="https://img.shields.io/docker/v/louislam/uptime-kuma/2?label=docker%20image%20ver." /></a> <a target="_blank" href="https://github.com/louislam/uptime-kuma"><img src="https://img.shields.io/github/last-commit/louislam/uptime-kuma" /></a> <a target="_blank" href="https://opencollective.com/uptime-kuma"><img src="https://opencollective.com/uptime-kuma/total/badge.svg?label=Open%20Collective%20Backers&color=brightgreen" /></a>
[![GitHub Sponsors](https://img.shields.io/github/sponsors/louislam?label=GitHub%20Sponsors)](https://github.com/sponsors/louislam) <a href="https://weblate.kuma.pet/projects/uptime-kuma/uptime-kuma/">
<img src="https://weblate.kuma.pet/widgets/uptime-kuma/-/svg-badge.svg" alt="Translation status" />
</a>

<img src="https://user-images.githubusercontent.com/1336778/212262296-e6205815-ad62-488c-83ec-a5b0d0689f7c.jpg" width="700" alt="Uptime Kuma Dashboard Screenshot" />

## 🥔 Live Demo

Try it!

Demo Server (Location: Frankfurt - Germany): <https://demo.kuma.pet/start-demo>

It is a temporary live demo, all data will be deleted after 10 minutes. Sponsored by [Uptime Kuma Sponsors](https://github.com/louislam/uptime-kuma#%EF%B8%8F-sponsors).

## ⭐ Features

- Monitoring uptime for HTTP(s) / TCP / HTTP(s) Keyword / HTTP(s) Json Query / Websocket / Ping / DNS Record / Push / Steam Game Server / Docker Containers
- Fancy, Reactive, Fast UI/UX
- Notifications via Telegram, Discord, Gotify, Slack, Pushover, Email (SMTP), and [90+ notification services, click here for the full list](https://github.com/louislam/uptime-kuma/tree/master/src/components/notifications)
- 20-second intervals
- [Multi Languages](https://github.com/louislam/uptime-kuma/tree/master/src/lang)
- Multiple status pages
- Map status pages to specific domains
- Ping chart
- Certificate info
- Proxy support
- 2FA support

## ✨ Fork additions

This fork adds the following on top of Uptime Kuma 2.2.x.

### 🕰️ Edit history (set past time slots to UP / DOWN)

On a monitor's page, **Edit history** lets you pick a time range in the past and set it to UP or DOWN, for example to correct a false outage or to record a real one the monitor missed. A preview shows how many heartbeats will change before you confirm.

- **Existing heartbeats** in the range get the new status and the note `Manually set to UP (history edit)` / `DOWN`. The events list is updated, so the change shows as a status change at the start and end of the range.
- **Gaps** (the monitor was paused or the server was off) are filled with one heartbeat per check interval, so the change is visible in the heartbeat bar.
- **Uptime percentages** are updated: the minute, hour and day statistics move one count per changed heartbeat, so the 24 hour, 30 day and 1 year uptime and the status page agree with the new history.
- Notifications are not sent for edits.
- Only time in the past can be changed, at most 90 days at once, and only inside the heartbeat retention period (*Settings > Monitor History*, 180 days by default).
- Latency statistics are not changed. Filled UP time uses the usual average latency of the monitor.
- It cannot be undone. Take a backup of `kuma.db` first if you are unsure.

### ⚖️ HAProxy monitor

The **HAProxy** monitor type reads the state of a frontend, backend or server from a small Python agent that runs on the HAProxy node. Uptime Kuma pulls from the agent.

1. Enable a stats socket in the `global` section of `haproxy.cfg` (read-only access is enough):

   ```
   stats socket /run/haproxy/admin.sock mode 660 level operator
   ```

2. Copy [`extra/haproxy-agent/haproxy_agent.py`](extra/haproxy-agent/haproxy_agent.py) to the node and run it (Python 3.8+, no packages needed). Bind it to an address Uptime Kuma can reach, for example your Tailscale IP:

   ```bash
   HAPROXY_AGENT_TOKEN=use-a-long-random-secret \
     python3 haproxy_agent.py --socket /run/haproxy/admin.sock --listen 100.64.0.10:8404
   ```

   Use `--tls-cert` and `--tls-key` for HTTPS. The agent refuses to start without a token (at least 16 characters). It only sends `show stat` and `show info` to HAProxy, never anything from a request.

3. Add a monitor of type **HAProxy** with the agent URL, the token and the name of the frontend / backend (and optionally one server).

| What is monitored | Result |
| --- | --- |
| Backend, all servers up | UP |
| Backend, some servers down (at least the minimum are up) | Degraded, the message names the servers |
| Backend, fewer servers up than the minimum, or backend DOWN | DOWN |
| Single server UP / DOWN | UP / DOWN |
| Single server in `MAINT` | Maintenance |
| Single server `DRAIN` or `NOLB` | Degraded |

A systemd unit for the agent:

```ini
[Unit]
Description=Uptime Kuma HAProxy agent
After=haproxy.service

[Service]
Environment=HAPROXY_AGENT_TOKEN=use-a-long-random-secret
ExecStart=/usr/bin/python3 /opt/haproxy-agent/haproxy_agent.py --socket /run/haproxy/admin.sock --listen 100.64.0.10:8404
Restart=on-failure
DynamicUser=yes
SupplementaryGroups=haproxy

[Install]
WantedBy=multi-user.target
```

### 🔒 Login-only groups on status pages

In the status page editor, the lock button next to a group name makes that group visible to logged-in viewers only. Other visitors do not get the group, its monitors, its heartbeats, its RSS entries or its badges, and a banner tells them that groups are hidden.

A viewer counts as logged in when:

- they have an Uptime Kuma login (the token is sent as `Authorization: Bearer`), or
- **forward / proxy auth**: the request carries the header you set under *Forward auth header* (for example `X-authentik-username` or `Remote-User`) **and** comes straight from an address in *Trusted proxies*.

Notes for forward auth:

- Your proxy must remove this header from every incoming request that is not authenticated, otherwise visitors can send it themselves.
- Only the address of the TCP connection is checked, never `X-Forwarded-For`. The header is ignored while *Trusted proxies* is empty.
- *Login link* sets where the banner's "Log in" button goes, for example a proxy-protected URL. Leave it empty to use the Uptime Kuma login.
- The global "disable auth" setting is deliberately ignored here, because it is used behind such proxies and would make every visitor count as logged in.
- Responses for logged-in viewers are never cached and are sent with `Cache-Control: private, no-store`.

## 🔧 How to Install

### 🐳 Docker Compose

```bash
mkdir uptime-kuma
cd uptime-kuma
curl -o compose.yaml https://raw.githubusercontent.com/louislam/uptime-kuma/master/compose.yaml
docker compose up -d
```

Uptime Kuma is now running on all network interfaces (e.g. http://localhost:3001 or http://your-ip:3001).

> [!WARNING]
> File Systems like **NFS** (Network File System) are **NOT** supported. Please map to a local directory or volume.

### 🐳 Docker Command

```bash
docker run -d --restart=always -p 3001:3001 -v uptime-kuma:/app/data --name uptime-kuma louislam/uptime-kuma:2
```

Uptime Kuma is now running on all network interfaces (e.g. http://localhost:3001 or http://your-ip:3001).

If you want to limit exposure to localhost only:

```bash
docker run ... -p 127.0.0.1:3001:3001 ...
```

### 💪🏻 Non-Docker

Requirements:

- Platform
  - ✅ Major Linux distros such as Debian, Ubuntu, Fedora and ArchLinux etc.
  - ✅ postmarketOS / Alpine Linux (musl, OpenRC), including old kernels down to 3.10: see [below](#-postmarketos--alpine-linux-openrc)
  - ✅ Windows 10 (x64), Windows Server 2012 R2 (x64) or higher
  - ❌ FreeBSD / OpenBSD / NetBSD
  - ❌ Replit / Heroku
- [Node.js](https://nodejs.org/en/download/) >= 20.4
- [Git](https://git-scm.com/downloads)
- [pm2](https://pm2.keymetrics.io/) - For running Uptime Kuma in the background

```bash
git clone https://github.com/jt13890/UptimeKuma-but-with-customizable-status-page-times-.git uptime-kuma
cd uptime-kuma
# Installs the dependencies and builds the web interface
npm run setup

# Option 1. Try it
node server/server.js

# (Recommended) Option 2. Run in the background using PM2
# Install PM2 if you don't have it:
npm install pm2 -g && pm2 install pm2-logrotate

# Start Server
pm2 start server/server.js --name uptime-kuma
```

Uptime Kuma is now running on all network interfaces (e.g. http://localhost:3001 or http://your-ip:3001).

More useful PM2 Commands

```bash
# If you want to see the current console output
pm2 monit

# If you want to add it to startup
pm2 startup && pm2 save
```

### 📱 postmarketOS / Alpine Linux (OpenRC)

An install script sets Uptime Kuma up as an OpenRC service, running as its own user:

```sh
doas apk add git
git clone https://github.com/jt13890/UptimeKuma-but-with-customizable-status-page-times-.git uptime-kuma
cd uptime-kuma
doas sh extra/native/install.sh
```

It can also move over the data of an existing Uptime Kuma (Docker or not) with `--import-data`. See [extra/native/README.md](extra/native/README.md) for the details, updating, and devices with little RAM.

### Advanced Installation

If you need more options or need to browse via a reverse proxy, please read:

<https://github.com/louislam/uptime-kuma/wiki/%F0%9F%94%A7-How-to-Install>

## 🆙 How to Update

Please read:

<https://github.com/louislam/uptime-kuma/wiki/%F0%9F%86%99-How-to-Update>

## 🆕 What's Next?

I will assign requests/issues to the next milestone.

<https://github.com/louislam/uptime-kuma/milestones>

## ❤️ Sponsors

Thank you so much! (GitHub Sponsors will be updated manually. OpenCollective sponsors will be updated automatically, the list will be cached by GitHub though. It may need some time to be updated)

<img src="https://uptime.kuma.pet/sponsors?v=6" alt="Uptime Kuma Sponsors" />

## 🖼 More Screenshots

Light Mode:

<img src="https://uptime.kuma.pet/img/light.jpg" width="512" alt="Uptime Kuma Light Mode Screenshot of how the Dashboard looks" />

Status Page:

<img src="https://user-images.githubusercontent.com/1336778/134628766-a3fe0981-0926-4285-ab46-891a21c3e4cb.png" width="512" alt="Uptime Kuma Status Page Screenshot" />

Settings Page:

<img src="https://louislam.net/uptimekuma/2.jpg" width="400" alt="Uptime Kuma Settings Page Screenshot" />

Telegram Notification Sample:

<img src="https://louislam.net/uptimekuma/3.jpg" width="400" alt="Uptime Kuma Telegram Notification Sample Screenshot" />

## Motivation

- I was looking for a self-hosted monitoring tool like "Uptime Robot", but it is hard to find a suitable one. One of the closest ones is statping. Unfortunately, it is not stable and no longer maintained.
- Wanted to build a fancy UI.
- Learn Vue 3 and vite.js.
- Show the power of Bootstrap 5.
- Try to use WebSocket with SPA instead of a REST API.
- Deploy my first Docker image to Docker Hub.

If you love this project, please consider giving it a ⭐.

## 🗣️ Discussion / Ask for Help

⚠️ For any general or technical questions, please don't send me an email, as I am unable to provide support in that manner. I will not respond if you ask questions there.

I recommend using Google, GitHub Issues, or Uptime Kuma's subreddit for finding answers to your question. If you cannot find the information you need, feel free to ask:

- [GitHub Issues](https://github.com/louislam/uptime-kuma/issues)
- [Subreddit (r/UptimeKuma)](https://www.reddit.com/r/UptimeKuma/)

My Reddit account: [u/louislamlam](https://reddit.com/u/louislamlam)
You can mention me if you ask a question on the subreddit.

## Contributions

### Create Pull Requests

Pull requests are awesome.
To keep reviews fast and effective, please make sure you’ve [read our pull request guidelines](https://github.com/louislam/uptime-kuma/blob/master/CONTRIBUTING.md#can-i-create-a-pull-request-for-uptime-kuma).

### Test Pull Requests

There are a lot of pull requests right now, but I don't have time to test them all.

If you want to help, you can check this:
<https://github.com/louislam/uptime-kuma/wiki/Test-Pull-Requests>

### Test Beta Version

Check out the latest beta release here: <https://github.com/louislam/uptime-kuma/releases>

### Bug Reports / Feature Requests

If you want to report a bug or request a new feature, feel free to open a [new issue](https://github.com/louislam/uptime-kuma/issues).

### Translations

If you want to translate Uptime Kuma into your language, please visit [Weblate Readme](https://github.com/louislam/uptime-kuma/blob/master/src/lang/README.md).

### Spelling & Grammar

Feel free to correct the grammar in the documentation or code.
My mother language is not English and my grammar is not that great.
