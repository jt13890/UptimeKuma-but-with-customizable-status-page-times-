const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Configuration of the SQLite peer high availability (see HA-SQLITE.md).
 *
 * It is stored in `<data dir>/ha.json` and NOT in the database on purpose: the database is replaced by
 * the other node's snapshot during sync, a node's identity (name, preferred, peers, secret) must survive that.
 */

const FILE_NAME = "ha.json";

const DEFAULTS = {
    enabled: false,
    // Name shown in logs / UI / "Up according to node <name>"
    nodeName: "",
    // The "main" node. It takes the active role back once it is healthy again (if autoFailback is on).
    preferred: false,
    // Shared secret that authenticates the nodes against each other
    secret: "",
    // How the OTHER node can reach this one, and how this node reaches the others
    selfUrl: "",
    peers: [],
    // True on the node that already holds the real data. A joining node must sync once before it may become active.
    bootstrap: false,

    // ---- Shared tunables (pushed to the peer when saved in the UI) ----
    // Seconds without any reachable active node before a standby takes over
    failoverAfterSec: 15,
    // Extra seconds the non-preferred node waits, so the main node wins a tie
    staggerSec: 10,
    // Max age of the snapshot a standby pulls from the active node
    snapshotIntervalSec: 60,
    // Hand the active role back to the preferred node once it has caught up
    autoFailback: true,
    // The preferred node must see the other one as active for this long before taking over again
    failbackAfterSec: 30,
    // Standby nodes also run the checks and report what they see ("up wins")
    observe: true,
    // false: a standby answers HTTP 503 on every path (except the node-to-node API), so a load balancer such as
    // HAProxy marks it down whatever it checks. true: it keeps serving public status pages, only the dashboard is refused.
    standbyStatusPages: false,
    // An active node without connectivity for this long stands down instead of recording false DOWNs
    isolationGraceSec: 20,
    // host:port list used to decide "do I have connectivity". Empty = never consider this node isolated.
    connectivityTargets: ["1.1.1.1:443", "8.8.8.8:443"],

    // ---- Local only ----
    renewIntervalSec: 5,
    keepBackups: 3,
};

const SHARED_KEYS = [
    "failoverAfterSec",
    "staggerSec",
    "snapshotIntervalSec",
    "autoFailback",
    "failbackAfterSec",
    "observe",
    "standbyStatusPages",
    "isolationGraceSec",
    "connectivityTargets",
];

/**
 * @param {string} dataDir Data directory
 * @returns {string} Path of ha.json
 */
function filePath(dataDir) {
    return path.join(dataDir, FILE_NAME);
}

/**
 * @returns {string} A new random shared secret
 */
function generateSecret() {
    return crypto.randomBytes(24).toString("base64url");
}

/**
 * @param {string} url URL typed by the user
 * @returns {string} Normalized base URL without trailing slash
 * @throws {Error} Not a http(s) URL
 */
function normalizeUrl(url) {
    const trimmed = String(url).trim();
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (e) {
        throw new Error(`Invalid URL: ${trimmed}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`Only http(s) URLs are supported: ${trimmed}`);
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

/**
 * Validate and normalize a config object (from the UI, a file or a join token).
 * @param {object} input Raw config
 * @returns {object} Complete, normalized config
 * @throws {Error} Invalid value
 */
function normalize(input = {}) {
    const cfg = { ...DEFAULTS, ...input };

    cfg.enabled = !!cfg.enabled;
    cfg.preferred = !!cfg.preferred;
    cfg.bootstrap = !!cfg.bootstrap;
    cfg.autoFailback = !!cfg.autoFailback;
    cfg.observe = !!cfg.observe;
    cfg.standbyStatusPages = !!cfg.standbyStatusPages;
    cfg.nodeName = String(cfg.nodeName || "").trim().substring(0, 60);
    cfg.secret = String(cfg.secret || "");
    cfg.selfUrl = cfg.selfUrl ? normalizeUrl(cfg.selfUrl) : "";
    cfg.peers = [...new Set((cfg.peers || []).filter((p) => String(p).trim() !== "").map(normalizeUrl))];

    const int = (key, min, max) => {
        const value = Number(cfg[key]);
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new Error(`${key} must be a whole number between ${min} and ${max}`);
        }
        cfg[key] = value;
    };
    int("failoverAfterSec", 5, 3600);
    int("staggerSec", 0, 600);
    int("snapshotIntervalSec", 5, 3600);
    int("failbackAfterSec", 0, 86400);
    int("isolationGraceSec", 0, 3600);
    int("renewIntervalSec", 1, 60);
    int("keepBackups", 0, 50);

    cfg.connectivityTargets = (cfg.connectivityTargets || []).map((t) => String(t).trim()).filter((t) => t !== "");
    for (const target of cfg.connectivityTargets) {
        if (!/^[^\s:]+:\d{1,5}$/.test(target)) {
            throw new Error(`Connectivity target must look like host:port, got "${target}"`);
        }
    }

    if (cfg.enabled) {
        if (cfg.peers.length === 0) {
            throw new Error("At least one peer URL is required");
        }
        if (cfg.secret.length < 16) {
            throw new Error("The shared secret must be at least 16 characters");
        }
    }
    return cfg;
}

/**
 * @param {string} dataDir Data directory
 * @returns {object|null} The stored config, or null when this node has none
 */
function load(dataDir) {
    const file = filePath(dataDir);
    if (!fs.existsSync(file)) {
        return null;
    }
    return normalize(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * Save atomically, readable by the owner only (it contains the shared secret)
 * @param {string} dataDir Data directory
 * @param {object} cfg Config (will be normalized)
 * @returns {object} The normalized config that was written
 */
function save(dataDir, cfg) {
    const normalized = normalize(cfg);
    const file = filePath(dataDir);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return normalized;
}

/**
 * Join token: what a second node needs to find the first one. It contains the shared secret, treat it like a password.
 * @param {object} cfg Config of the node that creates the token
 * @returns {string} Token
 */
function makeJoinToken(cfg) {
    if (!cfg.selfUrl) {
        throw new Error("Set \"This node's URL\" first, the second node needs it to find this one");
    }
    const shared = {};
    for (const key of SHARED_KEYS) {
        shared[key] = cfg[key];
    }
    const payload = {
        v: 1,
        secret: cfg.secret,
        peers: [cfg.selfUrl],
        // The joining node is the secondary
        preferred: !cfg.preferred,
        shared,
    };
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Create the config of a joining node from a token.
 * @param {string} token Join token
 * @param {string} nodeName Name of this node
 * @param {string} selfUrl URL of this node as seen by the other node (optional)
 * @returns {object} Config (enabled, not bootstrap: it must sync before it may become active)
 */
function fromJoinToken(token, nodeName, selfUrl = "") {
    let payload;
    try {
        payload = JSON.parse(Buffer.from(String(token).trim(), "base64url").toString("utf8"));
    } catch (e) {
        throw new Error("The join token is not valid");
    }
    if (payload?.v !== 1 || !payload.secret || !Array.isArray(payload.peers)) {
        throw new Error("The join token is not valid");
    }
    return normalize({
        ...(payload.shared || {}),
        enabled: true,
        nodeName,
        selfUrl,
        secret: payload.secret,
        peers: payload.peers,
        preferred: !!payload.preferred,
        bootstrap: false,
    });
}

/**
 * Config for the UI: never send the secret back, only whether it is set.
 * @param {object} cfg Config
 * @returns {object} Safe copy
 */
function forUI(cfg) {
    const copy = { ...cfg, hasSecret: !!cfg.secret };
    delete copy.secret;
    return copy;
}

/**
 * Compare two secrets without leaking timing information
 * @param {string} a First
 * @param {string} b Second
 * @returns {boolean} Equal
 */
function secretsEqual(a, b) {
    const ha = crypto.createHash("sha256").update(String(a)).digest();
    const hb = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb) && String(a).length > 0;
}

module.exports = {
    DEFAULTS,
    SHARED_KEYS,
    filePath,
    generateSecret,
    normalizeUrl,
    normalize,
    load,
    save,
    makeJoinToken,
    fromJoinToken,
    forUI,
    secretsEqual,
};
