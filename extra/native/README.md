# Uptime Kuma without Docker (postmarketOS / Alpine / OpenRC)

`install.sh` installs Uptime Kuma as an OpenRC service, running as its own `uptime-kuma` user.
It is made for postmarketOS and Alpine Linux (musl only, no glibc needed) and works on old
kernels down to Linux 3.10 (e.g. 3.10.108).

| What          | Where                                                       |
| ------------- | ----------------------------------------------------------- |
| App           | `/opt/uptime-kuma` (previous version: `/opt/uptime-kuma.old`) |
| Data          | `/var/lib/uptime-kuma`                                      |
| Settings      | `/etc/conf.d/uptime-kuma` (port, data folder, Node options) |
| Log           | `/var/log/uptime-kuma/uptime-kuma.log`                      |
| Service       | `rc-service uptime-kuma start / stop / restart / status`    |

## Install

```sh
doas apk add git
git clone https://github.com/jt13890/UptimeKuma-but-with-customizable-status-page-times-.git uptime-kuma
cd uptime-kuma
doas sh extra/native/install.sh
```

The script installs `nodejs`, `npm`, `iputils` and `tzdata` with apk, builds the web interface if
needed, installs the app, enables the service at boot and starts it. Then open
`http://<device>:3001`.

### Devices with little RAM

Building the web interface needs about 1.5 GB of RAM + swap. On a phone or tablet it's easier to
build it on your computer (any OS, Node.js 20.4+) and copy the checkout over:

```sh
# on your computer
git clone https://github.com/jt13890/UptimeKuma-but-with-customizable-status-page-times-.git uptime-kuma
cd uptime-kuma
npm ci && npm run build
rm -rf node_modules
scp -r ../uptime-kuma user@device:
```

The script uses `dist/` if it's already there. Only the server's dependencies are installed on the
device, and none of them needs a compiler. The SQLite module comes prebuilt for musl on x86_64,
armv7 and aarch64.

To keep Node.js small on the device, set a heap limit in `/etc/conf.d/uptime-kuma`, e.g.
`NODE_OPTS="--max-old-space-size=256"`.

## Move over an existing Uptime Kuma

Stop the old one, then point the script at its data folder. For Docker that's the volume, e.g.
`/var/lib/docker/volumes/uptime-kuma/_data`. For a non-Docker install it's the `data` folder.

```sh
doas sh extra/native/install.sh --import-data /path/to/old/data
```

It first checks that the data can be used:

- Data from Uptime Kuma 1.x and 2.x works. It is upgraded on the first start, which can take a
  while for big 1.x databases.
- Data from an upstream version newer than this fork is refused, with the list of database
  changes this version doesn't know. Update this fork first.
- The Docker image's **embedded MariaDB** only exists in Docker, so that data is refused. SQLite
  and external MariaDB work.

The import only copies. The old folder is left as it is.

> Going back to upstream Uptime Kuma later: this fork adds a database change
> (`2026-01-08-0000-add-status-page-history-days.js`), and upstream refuses to start on a database
> with changes it doesn't know. Keep a copy of the old data folder if you might go back.

## Update

```sh
cd uptime-kuma
git pull
doas sh extra/native/install.sh --rebuild
```

Leave out `--rebuild` if you copied a freshly built `dist/` over. Your data and
`/etc/conf.d/uptime-kuma` are kept.

## Notes

- **Ping monitors** need iputils `ping`. BusyBox `ping` doesn't support the options they use.
  The script gives iputils ping the `cap_net_raw` capability, so it works without root. Run the
  script again after upgrading iputils, because apk resets the capability.
- **npm 12 and newer** only run the install scripts of packages listed under `allowScripts` in
  `package.json`. This repo approves the ones it needs, e.g. `@louislam/sqlite3` for its native
  binary. `npm install-scripts ls` shows anything that's still blocked.
- **System Service monitors** use `rc-service <name> status` on OpenRC, and `systemctl` on systemd.
- **Linux 3.10**: Node.js (libuv) supports 3.10 as its minimum. When features from newer kernels
  are missing (`getrandom`, `statx`, `io_uring`, ...), it falls back to older ones.
- Features that need extra programs aren't set up by the script: the **Real Browser** monitor
  needs Chromium, **Apprise** notifications need `apprise`, **Tailscale Ping** needs `tailscale`.

## Uninstall

```sh
doas rc-service uptime-kuma stop
doas rc-update del uptime-kuma default
doas rm -rf /opt/uptime-kuma /opt/uptime-kuma.old /etc/init.d/uptime-kuma /etc/conf.d/uptime-kuma /var/log/uptime-kuma
# and only if you don't want to keep the data:
doas rm -rf /var/lib/uptime-kuma
doas deluser uptime-kuma
```
