#!/bin/sh
# Install (or update) Uptime Kuma without Docker, as an OpenRC service.
#
# Made for postmarketOS and Alpine Linux (musl, OpenRC, BusyBox), including old
# kernels down to 3.10. Other Linux systems work too if Node.js >= 20.4 is installed;
# without OpenRC it only installs the app and tells you how to start it.
#
# Usage, as root, from a checkout of this repository:
#   doas sh extra/native/install.sh [--prefix DIR] [--rebuild] [--no-service] [--import-data DIR]
#
#   --prefix DIR       Where to install the app (default: /opt/uptime-kuma)
#   --rebuild          Rebuild the web interface even if dist/ already exists
#   --no-service       Don't install or (re)start the OpenRC service
#   --import-data DIR  Copy the data folder of an existing Uptime Kuma (e.g. a Docker
#                      volume or ./data) into the new install. Stop the old one first.
#
# Data is kept in /var/lib/uptime-kuma (see /etc/conf.d/uptime-kuma) and is not
# touched when updating. The previous version is kept in <prefix>.old.

set -eu

PREFIX=/opt/uptime-kuma
REBUILD=0
SERVICE=1
IMPORT_DATA=""
SERVICE_USER=uptime-kuma
DATA_DIR=/var/lib/uptime-kuma
MIN_NODE=20.4.0
SRC=$(cd "$(dirname "$0")/../.." && pwd)

info() {
    printf '==> %s\n' "$*"
}

warn() {
    printf 'warning: %s\n' "$*" >&2
}

die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        --prefix)
            [ $# -ge 2 ] || die "--prefix needs a directory"
            PREFIX=$2
            shift
            ;;
        --prefix=*) PREFIX=${1#--prefix=} ;;
        --rebuild) REBUILD=1 ;;
        --import-data)
            [ $# -ge 2 ] || die "--import-data needs a directory"
            IMPORT_DATA=$2
            shift
            ;;
        --import-data=*) IMPORT_DATA=${1#--import-data=} ;;
        --no-service) SERVICE=0 ;;
        -h|--help)
            sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
done

case "$PREFIX" in
    /*) PREFIX=${PREFIX%/} ;;
    *) die "--prefix must be an absolute path" ;;
esac
[ "$PREFIX" != "$SRC" ] || die "--prefix can't be the source checkout itself"

[ "$(id -u)" = 0 ] || die "please run as root, e.g.: doas sh $0"

# The service reads the data folder from its conf.d file, so use the same one
if [ -f /etc/conf.d/uptime-kuma ]; then
    DATA_DIR=$(
        # shellcheck disable=SC1091
        . /etc/conf.d/uptime-kuma
        echo "${UPTIME_KUMA_DATA_DIR:-$DATA_DIR}"
    )
fi

if [ -n "$IMPORT_DATA" ]; then
    [ -d "$IMPORT_DATA" ] || die "--import-data: $IMPORT_DATA is not a directory"
    IMPORT_DATA=$(cd "$IMPORT_DATA" && pwd)
    if [ -e "$DATA_DIR/kuma.db" ] || [ -e "$DATA_DIR/db-config.json" ]; then
        die "$DATA_DIR already contains data, move it away first if you want to import $IMPORT_DATA"
    fi
fi
[ -f "$SRC/server/server.js" ] || die "run this script from a checkout of the repository ($SRC doesn't look like one)"

# --- System packages -------------------------------------------------------

if command -v apk >/dev/null 2>&1; then
    info "Installing packages with apk"
    # iputils: the ping monitor needs iputils ping, BusyBox ping lacks the options it uses
    # libcap-setcap: lets the service user ping without root
    apk add --no-cache nodejs npm iputils tzdata libcap-setcap
else
    warn "apk not found, skipping package installation (you need Node.js >= $MIN_NODE, npm and iputils ping)"
fi

command -v node >/dev/null 2>&1 || die "Node.js is not installed"
command -v npm >/dev/null 2>&1 || die "npm is not installed"

NODE_VERSION=$(node -p "process.versions.node")
node -e '
    const [ a, b ] = process.argv.slice(1).map(v => v.split(".").map(Number));
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1);
    }
' "$NODE_VERSION" "$MIN_NODE" || die "Node.js $NODE_VERSION is too old, $MIN_NODE or newer is needed"
info "Using Node.js $NODE_VERSION"

# Node.js (libuv) needs Linux 3.10 or newer
KERNEL=$(uname -r)
KERNEL_MAJOR=$(echo "$KERNEL" | cut -d. -f1)
KERNEL_MINOR=$(echo "$KERNEL" | cut -d. -f2 | sed 's/[^0-9].*//')
if [ "$KERNEL_MAJOR" -lt 3 ] || { [ "$KERNEL_MAJOR" -eq 3 ] && [ "${KERNEL_MINOR:-0}" -lt 10 ]; }; then
    warn "kernel $KERNEL is older than 3.10, Node.js will probably not run"
fi

# --- Web interface ---------------------------------------------------------

if [ "$REBUILD" = 1 ] || [ ! -f "$SRC/dist/index.html" ]; then
    MEM_KB=$(awk '/^(MemTotal|SwapTotal):/ { sum += $2 } END { print sum + 0 }' /proc/meminfo)
    if [ "$MEM_KB" -lt 1500000 ]; then
        warn "building the web interface needs about 1.5 GB of RAM + swap, this device has $((MEM_KB / 1024)) MB."
        warn "If the build fails, run 'npm ci && npm run build' on another computer and copy the dist/ folder into $SRC"
    fi

    info "Building the web interface (this can take a long time on small devices)"
    (
        cd "$SRC"
        npm ci --no-audit --no-fund
        npm run build
    )
fi

# --- App -------------------------------------------------------------------

NEW="$PREFIX.new"
info "Copying the app to $NEW"
rm -rf "$NEW"
mkdir -p "$NEW"

FILES=""
for f in "$SRC"/* "$SRC"/.[!.]*; do
    [ -e "$f" ] || continue
    name=${f##*/}
    case "$name" in
        node_modules|data|private|test|tmp|.git|.github|.idea|.vscode) continue ;;
    esac
    FILES="$FILES $name"
done
# shellcheck disable=SC2086 # FILES is a list of top-level names without spaces
tar -C "$SRC" -cf - $FILES | tar -C "$NEW" -xf -

info "Installing dependencies (production only)"
(
    cd "$NEW"
    npm ci --omit=dev --no-audit --no-fund
)

# The SQLite module gets its native binary from its install script. npm 12+ only runs
# install scripts listed in "allowScripts" in package.json, so make sure it really worked.
if ! (cd "$NEW" && node -e 'require("@louislam/sqlite3")') >/dev/null 2>&1; then
    (cd "$NEW" && node -e 'require("@louislam/sqlite3")') || true
    die "the SQLite module did not install its native binary (see the error above). With npm 12 or newer, check that package.json has \"@louislam/sqlite3\": true under \"allowScripts\" (npm install-scripts ls)"
fi

if [ -n "$IMPORT_DATA" ]; then
    info "Checking the data to import ($IMPORT_DATA)"
    (cd "$NEW" && node extra/native/check-data-dir.js "$IMPORT_DATA") || die "not importing $IMPORT_DATA"
fi

# --- User and permissions --------------------------------------------------

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    info "Creating system user $SERVICE_USER"
    if command -v useradd >/dev/null 2>&1; then
        useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /sbin/nologin "$SERVICE_USER"
    else
        addgroup -S "$SERVICE_USER"
        adduser -S -D -H -h "$DATA_DIR" -s /sbin/nologin -G "$SERVICE_USER" "$SERVICE_USER"
    fi
fi

# Ping needs a raw socket; give iputils ping the capability, so the service can run without root.
# (Never do this to BusyBox, it would apply to every applet.)
if command -v ping >/dev/null 2>&1 && command -v setcap >/dev/null 2>&1; then
    PING_BIN=$(readlink -f "$(command -v ping)")
    case "$PING_BIN" in
        *busybox*) warn "ping is BusyBox ping, the ping monitor needs iputils (apk add iputils)" ;;
        *) setcap cap_net_raw+p "$PING_BIN" || warn "could not set cap_net_raw on $PING_BIN, ping monitors may fail" ;;
    esac
fi

# --- Swap in the new version -----------------------------------------------

HAS_OPENRC=0
if command -v openrc-run >/dev/null 2>&1 || [ -x /sbin/openrc-run ]; then
    HAS_OPENRC=1
fi

if [ "$SERVICE" = 1 ] && [ "$HAS_OPENRC" = 1 ] && [ -f /etc/init.d/uptime-kuma ]; then
    info "Stopping the running service"
    rc-service --ifstarted uptime-kuma stop || true
fi

if [ -d "$PREFIX" ]; then
    rm -rf "$PREFIX.old"
    mv "$PREFIX" "$PREFIX.old"
fi
mv "$NEW" "$PREFIX"
info "Installed to $PREFIX"

if [ -n "$IMPORT_DATA" ]; then
    info "Importing $IMPORT_DATA into $DATA_DIR"
    mkdir -p "$DATA_DIR"
    cp -a "$IMPORT_DATA/." "$DATA_DIR/"
    chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
    chmod 750 "$DATA_DIR"
fi

# --- Service ---------------------------------------------------------------

if [ "$SERVICE" = 0 ]; then
    info "Done (service not installed, --no-service)"
    exit 0
fi

if [ "$HAS_OPENRC" = 0 ]; then
    info "Done. OpenRC was not found, so no service was installed. Start it with:"
    echo "    cd $PREFIX && su -s /bin/sh $SERVICE_USER -c 'node server/server.js --data-dir=$DATA_DIR'"
    exit 0
fi

info "Installing the OpenRC service"
install -m 755 "$SRC/extra/native/openrc/uptime-kuma" /etc/init.d/uptime-kuma
if [ ! -f /etc/conf.d/uptime-kuma ]; then
    install -m 644 "$SRC/extra/native/openrc/uptime-kuma.confd" /etc/conf.d/uptime-kuma
fi
if [ "$PREFIX" != /opt/uptime-kuma ] && ! grep -q '^UPTIME_KUMA_DIR=' /etc/conf.d/uptime-kuma; then
    echo "UPTIME_KUMA_DIR=$PREFIX" >> /etc/conf.d/uptime-kuma
fi

rc-update add uptime-kuma default >/dev/null
rc-service uptime-kuma start

# Read the port the same way the service does
PORT=$(
    # shellcheck disable=SC1091
    . /etc/conf.d/uptime-kuma
    echo "${UPTIME_KUMA_PORT:-3001}"
)

info "Waiting for Uptime Kuma to answer on port $PORT (the first start can take a minute)"
i=0
while [ $i -lt 120 ]; do
    if wget -q -O /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        info "Uptime Kuma is running: http://$(hostname):$PORT/"
        exit 0
    fi
    i=$((i + 1))
    sleep 2
done

warn "Uptime Kuma did not answer yet. Check: rc-service uptime-kuma status, and the log in /var/log/uptime-kuma/"
exit 1
