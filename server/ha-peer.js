const fs = require("fs");
const path = require("path");
const net = require("net");
const { HAManager } = require("./ha");
const haConfig = require("./ha-config");
const { log, UP } = require("../src/util");

const STATE_FILE = "ha-state.json";
const YIELD_MS = 45000;

/**
 * Active/passive high availability for SQLite installs: every node has its OWN kuma.db, the nodes talk to each other
 * over HTTP. See HA-SQLITE.md for the full design.
 *
 * Design goal: if one node goes offline, the other keeps going. This is deliberately "available" rather than
 * "consistent": a node that cannot see any active node promotes itself after `failoverAfterSec`. To keep that safe:
 *
 * - A node without connectivity (none of the connectivity targets reachable) never promotes, and an active node that
 *   loses connectivity stands down. A node that lost its wifi therefore never records false DOWNs.
 * - When two active nodes see each other again the higher epoch wins (then the preferred node, then the node id),
 *   the loser demotes and takes over the winner's data. Its own database is kept in data/ha/backups.
 * - The preferred ("main") node takes the active role back through a handover: the other node stops its monitors,
 *   makes a final snapshot, the main node applies it (so everything recorded in the meantime is not lost) and only
 *   then becomes active.
 * - "Up wins" still applies: standby nodes run the checks and send what they see to the active node.
 */
class PeerHAManager extends HAManager {
    /**
     * @param {object} options Options
     * @param {object} options.config Normalized config (see ha-config.js)
     * @param {string} options.dataDir Data directory
     * @param {Function} options.onPromote Called when this node becomes active
     * @param {Function} options.onDemote Called when this node stops being active
     * @param {Function} options.onStandbySync Called periodically while standby
     * @param {Function} options.fetch fetch implementation (tests)
     * @param {Function} options.connectivityCheck async (targets) => boolean (tests)
     * @param {string} options.version Application version, nodes of different versions never sync
     */
    constructor(options) {
        const config = options.config;
        super({
            enabled: true,
            name: config.nodeName || undefined,
            ttlSec: Math.max(30, config.renewIntervalSec * 6),
            renewIntervalSec: config.renewIntervalSec,
            observe: config.observe,
            standbySyncEvery: Math.max(1, Math.ceil(config.snapshotIntervalSec / config.renewIntervalSec)),
            onPromote: options.onPromote,
            onDemote: options.onDemote,
            onStandbySync: options.onStandbySync,
        });

        this.peerMode = true;
        this.config = config;
        this.dataDir = options.dataDir;
        this.fetch = options.fetch || globalThis.fetch;
        this.connectivityCheckFn = options.connectivityCheck || checkTargets;
        this.version = options.version || require("../package.json").version;
        this.replicator = null;

        this.state = { epoch: 0, hasReplica: false, appliedId: null, appliedAt: 0 };
        this.peerStates = new Map();
        this.peerObs = new Map();

        this.internetOk = true;
        this.connectivityCache = { at: 0, value: true };
        this.blindSince = null;
        this.noLeaderSince = null;
        this.leaderSeen = null;
        this.forceLead = false;
        this.yielding = false;
        this.yieldingUntil = 0;
        this.finalSnapshot = null;
        this.pendingFinal = null;
        this.handoverBusy = false;
        this.demoteReason = null;
        this.lastSyncError = null;
        this.lastSyncAt = 0;
    }

    /**
     * @param {Replicator} replicator Snapshot replicator
     * @returns {void}
     */
    attachReplicator(replicator) {
        this.replicator = replicator;
        replicator.getEpoch = () => this.epoch;
    }

    // ------------------------------------------------------------------ persistence

    /**
     * @returns {string} Path of the state file
     */
    stateFile() {
        return path.join(this.dataDir, STATE_FILE);
    }

    /**
     * @returns {void}
     */
    loadState() {
        try {
            this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.stateFile(), "utf8")) };
        } catch (e) {
            // First start
        }
        this.epoch = this.state.epoch || 0;
    }

    /**
     * @returns {void}
     */
    persist() {
        this.state.epoch = this.epoch;
        try {
            const tmp = this.stateFile() + ".tmp";
            fs.writeFileSync(tmp, JSON.stringify(this.state));
            fs.renameSync(tmp, this.stateFile());
        } catch (e) {
            log.warn("ha", "Could not store HA state: " + e.message);
        }
    }

    /**
     * Apply settings changed in the UI without a restart (enable/disable, node name, interval need one).
     * @param {object} config New normalized config
     * @returns {void}
     */
    applyConfig(config) {
        this.config = config;
        this.observe = config.observe;
        this.standbySyncEvery = Math.max(1, Math.ceil(config.snapshotIntervalSec / this.renewIntervalSec));
        if (this.replicator) {
            this.replicator.snapshotIntervalSec = config.snapshotIntervalSec;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async start() {
        this.loadState();
        return super.start();
    }

    // ------------------------------------------------------------------ talking to peers

    /**
     * @param {string} url Peer base URL
     * @param {string} method HTTP method
     * @param {string} apiPath Path
     * @param {object} body JSON body
     * @param {number} timeoutMs Timeout
     * @returns {Promise<object>} Parsed JSON answer
     * @throws {Error} Network error or non-2xx answer (error.status is set)
     */
    async peerRequest(url, method, apiPath, body = undefined, timeoutMs = 5000) {
        const res = await this.fetch(url + apiPath, {
            method,
            headers: {
                Authorization: `Bearer ${this.config.secret}`,
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
        let json = {};
        try {
            json = await res.json();
        } catch (e) {
            // No body
        }
        if (!res.ok) {
            const error = new Error(json.msg || `HTTP ${res.status}`);
            error.status = res.status;
            throw error;
        }
        return json;
    }

    /**
     * Ask every peer for its status
     * @returns {Promise<void>}
     */
    async pollPeers() {
        await Promise.all(
            this.config.peers.map(async (url) => {
                const previous = this.peerStates.get(url) || { url };
                try {
                    const status = await this.peerRequest(url, "GET", "/api/ha/status", undefined, 3000);
                    this.peerStates.set(url, {
                        url,
                        reachable: true,
                        lastSeen: Date.now(),
                        lastError: null,
                        ...status,
                        versionMismatch: status.version !== this.version,
                    });
                } catch (e) {
                    const lastError = e.status === 401 ? "The peer rejected the shared secret" : e.message;
                    this.peerStates.set(url, { ...previous, url, reachable: false, lastError });
                }
            })
        );
    }

    /**
     * @returns {object[]} Reachable peers that claim to be active, strongest claim first
     */
    activePeers() {
        return [...this.peerStates.values()]
            .filter((p) => p.reachable && p.role === "active")
            .sort(
                (a, b) =>
                    b.epoch - a.epoch || Number(b.preferred) - Number(a.preferred) || (a.nodeId < b.nodeId ? -1 : 1)
            );
    }

    /**
     * Does this node have connectivity? (cached for a few seconds)
     * @returns {Promise<boolean>} True if online, or if no targets are configured
     */
    async checkConnectivity() {
        const targets = this.config.connectivityTargets;
        if (targets.length === 0) {
            return true;
        }
        if (Date.now() - this.connectivityCache.at < 3000) {
            return this.connectivityCache.value;
        }
        const value = await this.connectivityCheckFn(targets);
        this.connectivityCache = { at: Date.now(), value };
        return value;
    }

    /**
     * Strength comparison of two active nodes
     * @param {object} rival Status of the other active node
     * @returns {boolean} True if this node must give way
     */
    loses(rival) {
        if (rival.epoch !== this.epoch) {
            return rival.epoch > this.epoch;
        }
        if (rival.preferred !== this.config.preferred) {
            return rival.preferred;
        }
        return rival.nodeId < this.nodeId;
    }

    /**
     * May this node become active? A joining node must have synced once, otherwise it would start with an empty database.
     * @returns {boolean} True if it may
     */
    eligible() {
        return this.config.bootstrap || this.state.hasReplica;
    }

    // ------------------------------------------------------------------ election

    /**
     * One election round (replaces the database lease of HAManager).
     * @returns {Promise<boolean>} True if this node is the active node afterwards
     */
    async campaign() {
        const now = Date.now();
        await this.pollPeers();
        this.internetOk = await this.checkConnectivity();
        const leaders = this.activePeers();

        if (this.yielding) {
            if (now > this.yieldingUntil || leaders.length > 0) {
                this.yielding = false;
            } else {
                return false;
            }
        }

        const held = this.leader ? this.campaignAsActive(now, leaders) : await this.campaignAsStandby(now, leaders);
        return held && !this.yielding;
    }

    /**
     * @param {number} now Now
     * @param {object[]} leaders Other active nodes
     * @returns {boolean} Stay active?
     */
    campaignAsActive(now, leaders) {
        const rival = leaders[0];
        if (rival && this.loses(rival)) {
            this.demoteReason = `another active node (${rival.name}, epoch ${rival.epoch}) takes precedence`;
            this.epoch = Math.max(this.epoch, rival.epoch);
            this.persist();
            return false;
        }

        if (!this.internetOk) {
            this.blindSince ??= now;
            if (now - this.blindSince >= this.config.isolationGraceSec * 1000) {
                this.demoteReason =
                    "this node lost connectivity, standing down so it does not record false DOWN results";
                this.noLeaderSince = null;
                this.blindSince = null;
                return false;
            }
        } else {
            this.blindSince = null;
        }
        return true;
    }

    /**
     * @param {number} now Now
     * @param {object[]} leaders Active peers
     * @returns {Promise<boolean>} Become active?
     */
    async campaignAsStandby(now, leaders) {
        const cfg = this.config;

        if (leaders.length > 0) {
            const leader = leaders[0];
            this.epoch = Math.max(this.epoch, leader.epoch);
            this.noLeaderSince = null;
            this.pendingFinal = null;
            if (this.leaderSeen?.nodeId !== leader.nodeId || this.leaderSeen.epoch !== leader.epoch) {
                this.leaderSeen = { nodeId: leader.nodeId, epoch: leader.epoch, since: now };
            }
            return await this.maybeFailback(leader, now);
        }

        this.leaderSeen = null;

        if (!this.internetOk) {
            // Without connectivity this node cannot tell whether the other one is dead or whether it is the one that is cut off
            this.noLeaderSince = null;
            return false;
        }
        this.noLeaderSince ??= now;

        if (this.pendingFinal) {
            // A handover is in progress: the other node stopped, its final snapshot must be applied before this node starts
            if (now < this.pendingFinal.until) {
                try {
                    await this.pullFrom(this.pendingFinal.url, { final: true });
                    this.pendingFinal = null;
                    return this.becomeActive("handover completed, data of the other node was taken over");
                } catch (e) {
                    log.warn("ha", `Final snapshot not applied yet: ${e.message}`);
                    return false;
                }
            }
            this.pendingFinal = null;
        }

        if (!this.eligible()) {
            return false;
        }

        const waitMs = (cfg.failoverAfterSec + (cfg.preferred ? 0 : cfg.staggerSec)) * 1000;
        if (this.forceLead || now - this.noLeaderSince >= waitMs) {
            const why = this.forceLead
                ? "the active node shut down"
                : `no active node for ${Math.round((now - this.noLeaderSince) / 1000)}s`;
            this.forceLead = false;
            return this.becomeActive(why);
        }
        return false;
    }

    /**
     * @param {string} why Reason for the log
     * @returns {boolean} Always true
     */
    becomeActive(why) {
        let highest = this.epoch;
        for (const peer of this.peerStates.values()) {
            highest = Math.max(highest, peer.epoch || 0);
        }
        this.epoch = highest + 1;
        this.noLeaderSince = null;
        this.persist();
        log.info("ha", `Taking the active role (${why}), epoch ${this.epoch}`);
        return true;
    }

    /**
     * The preferred node asks the active (secondary) node to hand the role back, once it was stable for a while.
     * @param {object} leader Status of the active peer
     * @param {number} now Now
     * @returns {Promise<boolean>} True if the role was taken over
     */
    async maybeFailback(leader, now) {
        const cfg = this.config;
        if (!cfg.autoFailback || !cfg.preferred || leader.preferred || this.handoverBusy || leader.versionMismatch) {
            return false;
        }
        if (!this.internetOk || now - this.leaderSeen.since < cfg.failbackAfterSec * 1000) {
            return false;
        }

        this.handoverBusy = true;
        try {
            log.info("ha", `Asking ${leader.name} to hand the active role back`);
            const answer = await this.peerRequest(leader.url, "POST", "/api/ha/handover", { from: this.nodeId }, 30000);
            this.pendingFinal = { url: leader.url, until: Date.now() + YIELD_MS - 5000 };
            this.epoch = Math.max(this.epoch, answer.epoch || 0);
            await this.pullFrom(leader.url, { final: true });
            this.pendingFinal = null;
            return this.becomeActive("handover completed, data of the other node was taken over");
        } catch (e) {
            log.warn("ha", `Handover did not complete: ${e.message}`);
            return false;
        } finally {
            this.handoverBusy = false;
        }
    }

    // ------------------------------------------------------------------ replication

    /**
     * Download + apply a snapshot from a peer
     * @param {string} url Peer base URL
     * @param {object} options Options
     * @param {boolean} options.final Final snapshot of a handover
     * @returns {Promise<{applied: boolean, id: string}>} Result
     */
    async pullFrom(url, { final = false } = {}) {
        if (!this.replicator) {
            throw new Error("Replication is not set up");
        }
        const peer = this.peerStates.get(url);
        if (peer?.versionMismatch) {
            throw new Error(
                `The other node runs version ${peer.version}, this node ${this.version}. Update both to the same version.`
            );
        }
        const result = await this.replicator.pull(url, this.config.secret, {
            have: final ? null : this.state.appliedId,
            final,
        });
        if (result.applied) {
            this.state.hasReplica = true;
            this.state.appliedId = result.id;
            this.state.appliedAt = Date.now();
            this.epoch = Math.max(this.epoch, result.epoch);
            this.persist();
            log.info("ha", `Applied snapshot ${result.id}`);
        }
        this.lastSyncAt = Date.now();
        this.lastSyncError = null;
        return result;
    }

    /**
     * Standby: bring this node's database up to date with the active node
     * @returns {Promise<{applied: boolean}>} Result
     */
    async syncFromLeader() {
        const leader = this.activePeers()[0];
        if (!leader || this.leader || this.pendingFinal) {
            return { applied: false };
        }
        try {
            return await this.pullFrom(leader.url);
        } catch (e) {
            this.lastSyncError = e.message;
            throw e;
        }
    }

    // ------------------------------------------------------------------ requests from peers

    /**
     * @returns {object} Answer of GET /api/ha/status
     */
    getPeerStatus() {
        return {
            nodeId: this.nodeId,
            name: this.nodeId.split(":")[0],
            role: this.isLeader() ? "active" : "standby",
            epoch: this.epoch,
            preferred: this.config.preferred,
            internetOk: this.internetOk,
            version: this.version,
            url: this.config.selfUrl,
            snapshotId: this.replicator?.cache?.id || this.state.appliedId,
        };
    }

    /**
     * The preferred node wants the active role back. This node stops, takes a final snapshot and yields.
     * @param {string} from Node id of the requester
     * @returns {Promise<{ok: boolean, snapshotId: string, epoch: number}>} Answer
     * @throws {Error} With .status when refused
     */
    async handleHandover(from) {
        const refuse = (status, msg) => Object.assign(new Error(msg), { status });
        if (!this.isLeader()) {
            throw refuse(409, "This node is not active");
        }
        if (this.config.preferred) {
            throw refuse(409, "The preferred node does not hand over");
        }
        if (this.yielding) {
            throw refuse(409, "A handover is already in progress");
        }

        log.info("ha", `Handing the active role over to ${String(from).split(":")[0]}`);
        this.yielding = true;
        this.yieldingUntil = Date.now() + YIELD_MS;
        try {
            await this.demote("handing the active role over to the preferred node");
            // Monitors are stopped, nothing records heartbeats anymore: this is the last state of this node
            this.finalSnapshot = await this.replicator.getSnapshot({ fresh: true });
        } catch (e) {
            this.yielding = false;
            throw e;
        }
        this.noLeaderSince = Date.now();
        return { ok: true, snapshotId: this.finalSnapshot.id, epoch: this.epoch };
    }

    /**
     * @param {boolean} final The requester asks for the final snapshot of a handover
     * @returns {Promise<object>} Snapshot to serve
     * @throws {Error} With .status when this node must not serve one
     */
    async snapshotForPeer(final) {
        if (this.isLeader()) {
            return this.replicator.getSnapshot();
        }
        if (final && this.finalSnapshot && this.yielding) {
            return this.finalSnapshot;
        }
        throw Object.assign(new Error("This node is not active"), { status: 409 });
    }

    /**
     * A peer announces that it shuts down on purpose: take over without waiting
     * @returns {void}
     */
    handleLeaderGone() {
        if (!this.isLeader()) {
            this.forceLead = true;
        }
    }

    /**
     * A standby reports what it saw ("up wins")
     * @param {object} body {monitorId, status, ping, nodeId}
     * @returns {void}
     */
    handleObserve(body) {
        const monitorId = Number(body?.monitorId);
        const status = Number(body?.status);
        if (!Number.isInteger(monitorId) || !Number.isInteger(status) || typeof body.nodeId !== "string") {
            throw Object.assign(new Error("Bad observation"), { status: 400 });
        }
        if (!this.peerObs.has(monitorId)) {
            this.peerObs.set(monitorId, new Map());
        }
        this.peerObs.get(monitorId).set(body.nodeId.substring(0, 190), {
            status,
            ping: Number.isFinite(Number(body.ping)) ? Math.round(Number(body.ping)) : null,
            at: Date.now(),
        });
    }

    /**
     * The shared tunables were changed on the other node
     * @param {object} shared Shared tunables
     * @param {boolean} preferred Whether this node is the preferred one now (optional)
     * @returns {object} The stored config
     */
    receiveConfig(shared, preferred) {
        const next = { ...this.config };
        for (const key of haConfig.SHARED_KEYS) {
            if (shared && key in shared) {
                next[key] = shared[key];
            }
        }
        if (typeof preferred === "boolean") {
            next.preferred = preferred;
        }
        const stored = haConfig.save(this.dataDir, next);
        this.applyConfig(stored);
        return stored;
    }

    // ------------------------------------------------------------------ observations ("up wins") over HTTP

    /**
     * Standby: send what this node saw to the active node. Never throws, never blocks the check loop.
     * @param {number} monitorId Monitor id
     * @param {number} status Status
     * @param {string} msg Message (not sent)
     * @param {number|null} ping Ping
     * @returns {Promise<void>}
     */
    async recordObservation(monitorId, status, msg, ping) {
        const leader = this.activePeers()[0];
        if (!leader) {
            return;
        }
        this.peerRequest(
            leader.url,
            "POST",
            "/api/ha/observe",
            { monitorId, status, ping, nodeId: this.nodeId },
            2000
        ).catch((e) => log.debug("ha", `Could not send observation: ${e.message}`));
    }

    /**
     * "Up wins": did the other node recently see this monitor UP?
     * @param {object} monitor Monitor bean
     * @returns {Promise<{nodeName: string, ping: number|null}|null>} The peer that saw it UP
     */
    async findPeerUp(monitor) {
        if (!this.observe) {
            return null;
        }
        const maxAgeMs = (this.observationMaxAgeSec ?? Math.ceil(Number(monitor.interval || 60) * 1.5 + 5)) * 1000;
        const seen = this.peerObs.get(monitor.id);
        if (!seen) {
            return null;
        }
        const now = Date.now();
        for (const [nodeId, obs] of seen) {
            if (nodeId !== this.nodeId && obs.status === UP && now - obs.at <= maxAgeMs) {
                return { nodeName: nodeId.split(":")[0], ping: obs.ping };
            }
        }
        return null;
    }

    /**
     * @returns {Promise<void>}
     */
    async pruneObservations() {
        const limit = Date.now() - 86400 * 1000;
        for (const [monitorId, seen] of this.peerObs) {
            for (const [nodeId, obs] of seen) {
                if (obs.at < limit) {
                    seen.delete(nodeId);
                }
            }
            if (seen.size === 0) {
                this.peerObs.delete(monitorId);
            }
        }
    }

    // ------------------------------------------------------------------ lifecycle

    /**
     * There is no lease to give back
     * @returns {Promise<void>}
     */
    async release() {}

    /**
     * @param {string} reason Default reason of the base class
     * @returns {Promise<void>}
     */
    async demote(reason) {
        const specific = this.demoteReason;
        this.demoteReason = null;
        return super.demote(specific || reason);
    }

    /**
     * Graceful shutdown: tell the peers, so they take over at once instead of after failoverAfterSec
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.stopped) {
            return;
        }
        if (this.leader) {
            await Promise.all(
                this.config.peers.map((url) =>
                    this.peerRequest(url, "POST", "/api/ha/leader-gone", { from: this.nodeId }, 2000).catch(() => {})
                )
            );
        }
        return super.stop();
    }

    /**
     * Everything the settings page shows
     * @returns {object} Detail
     */
    getDetail() {
        return {
            ...this.getStatus(),
            nodeId: this.nodeId,
            name: this.nodeId.split(":")[0],
            preferred: this.config.preferred,
            internetOk: this.internetOk,
            eligible: this.eligible(),
            hasReplica: this.state.hasReplica,
            appliedId: this.state.appliedId,
            appliedAt: this.state.appliedAt,
            lastSyncAt: this.lastSyncAt,
            lastSyncError: this.lastSyncError,
            yielding: this.yielding,
            version: this.version,
            peers: [...this.peerStates.values()].map((p) => ({
                url: p.url,
                reachable: !!p.reachable,
                name: p.name,
                role: p.reachable ? p.role : null,
                epoch: p.epoch,
                internetOk: p.internetOk,
                version: p.version,
                versionMismatch: !!p.versionMismatch,
                lastSeen: p.lastSeen,
                lastError: p.lastError,
            })),
        };
    }
}

/**
 * Default connectivity check: can a TCP connection be opened to any of the targets?
 * @param {string[]} targets host:port list
 * @returns {Promise<boolean>} True if at least one is reachable
 */
function checkTargets(targets) {
    const probe = (target) =>
        new Promise((resolve) => {
            const idx = target.lastIndexOf(":");
            const socket = net.connect({ host: target.substring(0, idx), port: Number(target.substring(idx + 1)) });
            const done = (ok) => {
                socket.destroy();
                resolve(ok);
            };
            socket.setTimeout(3000, () => done(false));
            socket.once("connect", () => done(true));
            socket.once("error", () => done(false));
        });
    return Promise.all(targets.map(probe)).then((results) => results.some(Boolean));
}

/**
 * Framework independent handler of the node-to-node API (used by routers/ha-router.js, testable without express).
 * Authentication: `Authorization: Bearer <shared secret>`. The snapshot contains the whole database (password hashes,
 * notification credentials), so the nodes must talk over HTTPS or a private network (VPN / Tailscale / WireGuard).
 * @param {PeerHAManager|HAManager} ha The HA manager of this node
 * @param {object} req Request
 * @param {string} req.method HTTP method
 * @param {string} req.name Endpoint name: status, snapshot, observe, handover, leader-gone, config
 * @param {object} req.query Query parameters
 * @param {string} req.authorization Authorization header
 * @param {string} req.have x-ha-have header
 * @param {object} req.body JSON body
 * @returns {Promise<{status: number, json?: object, snapshot?: object}>} Answer; `snapshot` means "stream this snapshot"
 */
async function dispatchPeerRequest(ha, req) {
    if (!ha?.peerMode) {
        return { status: 404, json: { ok: false, msg: "Not found" } };
    }
    const header = req.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!haConfig.secretsEqual(token, ha.config.secret)) {
        return { status: 401, json: { ok: false, msg: "Unauthorized" } };
    }

    try {
        switch (`${req.method} ${req.name}`) {
            case "GET status":
                return { status: 200, json: ha.getPeerStatus() };

            case "GET snapshot": {
                const final = req.query?.final === "1";
                const snapshot = await ha.snapshotForPeer(final);
                if (!final && req.have === snapshot.id) {
                    return { status: 304 };
                }
                return { status: 200, snapshot };
            }

            case "POST observe":
                ha.handleObserve(req.body);
                return { status: 200, json: { ok: true } };

            case "POST handover":
                return { status: 200, json: await ha.handleHandover(req.body?.from) };

            case "POST leader-gone":
                ha.handleLeaderGone();
                return { status: 200, json: { ok: true } };

            case "POST config":
                try {
                    ha.receiveConfig(req.body?.shared, req.body?.preferred);
                } catch (e) {
                    throw Object.assign(e, { status: 400 });
                }
                return { status: 200, json: { ok: true } };

            default:
                return { status: 404, json: { ok: false, msg: "Not found" } };
        }
    } catch (e) {
        if (!e.status || e.status >= 500) {
            log.error("ha", e);
        }
        return { status: e.status || 500, json: { ok: false, msg: e.message } };
    }
}

// Node-to-node API: must stay reachable on a standby (the nodes authenticate with the shared secret).
// /api/ha/health is answered by api-router.js (503 on a standby, with details), so it passes as well.
const PEER_API = /^\/api\/ha\/(status|snapshot|observe|handover|leader-gone|config|health)$/;
const PUBLIC_PATHS = /^\/(status|api|upload|metrics|assets|_e2e)(\/|$)/;

/**
 * Express middleware (first in the chain): what a standby node answers to everybody else.
 *
 * Default: HTTP 503 on EVERY path and method (also OPTIONS/HEAD and "/", the usual health checks of HAProxy, nginx,
 * Traefik, ...) so a load balancer marks the node down without any special configuration. Only the node-to-node API
 * stays reachable. With config.standbyStatusPages the standby keeps serving public pages and only refuses dashboard
 * navigations (then a load balancer must check /api/ha/health).
 * @param {Function} getHa Returns the HA manager of this node (it is replaced when HA is switched on at startup)
 * @returns {Function} Express middleware
 */
function createStandbyGuard(getHa) {
    return function standbyGuard(req, res, next) {
        const ha = getHa();
        if (!ha?.peerMode || ha.isLeader() || PEER_API.test(req.path)) {
            return next();
        }

        const accept = req.headers?.accept || "";
        if (ha.config.standbyStatusPages) {
            const publicRequest = req.method !== "GET" || PUBLIC_PATHS.test(req.path) || req.path.includes(".");
            if (publicRequest || !accept.includes("text/html")) {
                return next();
            }
        }

        res.status(503).set({ "Retry-After": "10", "X-HA-Role": "standby", "Cache-Control": "no-store" });
        if (accept.includes("text/html")) {
            // Deliberately without the address of the active node: this page can be seen by anybody
            return res.send(
                `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
                    `<title>Standby</title></head><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
                    `<h2>This node is on standby</h2><p>Another node is currently running Uptime Kuma. Please try again in a moment.</p></body></html>`
            );
        }
        return res.json({ ok: false, role: "standby", msg: "This node is on standby" });
    };
}

module.exports = { PeerHAManager, dispatchPeerRequest, createStandbyGuard };
