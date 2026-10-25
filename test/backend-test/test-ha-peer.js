const { describe, test, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

let DatabaseSync = null;
try {
    ({ DatabaseSync } = require("node:sqlite"));
} catch (e) {
    // Node.js < 22.5: the cluster tests are skipped, the config tests still run
}

const haConfig = require("../../server/ha-config");
const { PeerHAManager, dispatchPeerRequest, createStandbyGuard } = require("../../server/ha-peer");
const { Replicator } = require("../../server/ha-replication");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UP = 1;
const DOWN = 0;

describe("HA config", () => {
    test("normalize validates values", () => {
        assert.throws(() => haConfig.normalize({ enabled: true, peers: [], secret: "x".repeat(20) }), /peer URL/);
        assert.throws(() => haConfig.normalize({ enabled: true, peers: ["https://a.example"], secret: "short" }), /16 characters/);
        assert.throws(() => haConfig.normalize({ failoverAfterSec: 1 }), /failoverAfterSec/);
        assert.throws(() => haConfig.normalize({ peers: ["ftp://a.example"] }), /http/);
        assert.throws(() => haConfig.normalize({ connectivityTargets: ["nonsense"] }), /host:port/);
        const ok = haConfig.normalize({ enabled: true, peers: ["https://a.example/"], secret: "x".repeat(20) });
        assert.deepStrictEqual(ok.peers, ["https://a.example"]);
    });

    test("join token creates the secondary, and never leaks through the UI view", () => {
        const main = haConfig.normalize({
            enabled: true,
            preferred: true,
            bootstrap: true,
            nodeName: "home",
            selfUrl: "https://home.example",
            peers: ["https://vps.example"],
            secret: haConfig.generateSecret(),
            failoverAfterSec: 20,
        });
        const joined = haConfig.fromJoinToken(haConfig.makeJoinToken(main), "vps", "https://vps.example");
        assert.strictEqual(joined.preferred, false);
        assert.strictEqual(joined.bootstrap, false, "a joining node must sync before it may become active");
        assert.strictEqual(joined.secret, main.secret);
        assert.deepStrictEqual(joined.peers, ["https://home.example"]);
        assert.strictEqual(joined.failoverAfterSec, 20, "shared tunables travel with the token");
        assert.strictEqual(haConfig.forUI(main).secret, undefined);
        assert.strictEqual(haConfig.forUI(main).hasSecret, true);
        assert.throws(() => haConfig.fromJoinToken("garbage", "x"), /not valid/);
    });

    test("server.js sets up peer HA on the startup path, not inside a callback", () => {
        // Regression: the block once ended up inside haHooks.onStandbySync and silently never ran at boot
        const source = fs.readFileSync(path.join(__dirname, "../../server/server.js"), "utf8");
        const ready = source.indexOf("await server.initAfterDatabaseReady();");
        const setup = source.indexOf("UPTIME_KUMA_HA_JOIN");
        const create = source.indexOf("new PeerHAManager(");
        const prometheus = source.indexOf('"Initializing Prometheus"');
        assert.ok(ready > 0 && setup > ready && create > setup && prometheus > create, "HA setup must run right after the database is ready");
        const hooksStart = source.indexOf("const haHooks = {");
        const hooksEnd = source.indexOf("let ha = (server.ha = new HAManager(haHooks));");
        assert.ok(hooksStart > 0 && hooksEnd > hooksStart);
        assert.ok(!source.slice(hooksStart, hooksEnd).includes("new PeerHAManager("), "must not be nested in the hooks");
    });

    test("save writes a private file and load reads it back", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-cfg-"));
        const saved = haConfig.save(dir, { enabled: true, peers: ["https://a.example"], secret: "s".repeat(24) });
        assert.deepStrictEqual(haConfig.load(dir), saved);
        if (process.platform !== "win32") {
            assert.strictEqual(fs.statSync(haConfig.filePath(dir)).mode & 0o077, 0);
        }
        assert.strictEqual(haConfig.load(fs.mkdtempSync(path.join(os.tmpdir(), "ha-none-"))), null);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe("HA standby guard (what a load balancer sees)", () => {
    /**
     * @param {object} overrides Config overrides
     * @param {boolean} active Is the node active?
     * @returns {PeerHAManager} Manager (no database needed)
     */
    function makeHa(overrides = {}, active = false) {
        const ha = new PeerHAManager({
            config: haConfig.normalize({
                enabled: true,
                nodeName: "X",
                secret: "s".repeat(24),
                selfUrl: "http://10.1.2.3:3001",
                peers: ["http://10.1.2.4:3001"],
                ...overrides,
            }),
            dataDir: os.tmpdir(),
        });
        ha.leader = active;
        ha.lastRenewOk = Date.now();
        return ha;
    }

    /**
     * Run the guard with a fake request
     * @param {PeerHAManager} ha Manager
     * @param {string} method Method
     * @param {string} reqPath Path
     * @param {string} accept Accept header
     * @returns {object} {passed, status, headers, body}
     */
    function ask(ha, method, reqPath, accept = "") {
        const out = { passed: false, status: 200, headers: {}, body: null };
        const res = {
            status(code) {
                out.status = code;
                return this;
            },
            set(headers) {
                Object.assign(out.headers, headers);
                return this;
            },
            send(body) {
                out.body = body;
            },
            json(body) {
                out.body = body;
            },
        };
        createStandbyGuard(() => ha)({ method, path: reqPath, headers: { accept } }, res, () => (out.passed = true));
        return out;
    }

    test("the active node is never touched", () => {
        const ha = makeHa({}, true);
        for (const [method, p] of [["GET", "/"], ["OPTIONS", "/"], ["GET", "/dashboard"], ["GET", "/status/default"]]) {
            assert.strictEqual(ask(ha, method, p, "text/html").passed, true, `${method} ${p}`);
        }
    });

    test("a standby answers 503 on every path and method, so any health check marks it down", () => {
        const ha = makeHa();
        for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
            for (const p of ["/", "/dashboard", "/status/default", "/api/badge/1/status", "/metrics", "/api/push/abc", "/socket.io/"]) {
                const out = ask(ha, method, p);
                assert.strictEqual(out.passed, false, `${method} ${p} must not pass`);
                assert.strictEqual(out.status, 503, `${method} ${p}`);
            }
        }
        const out = ask(ha, "OPTIONS", "/");
        assert.strictEqual(out.headers["X-HA-Role"], "standby");
        assert.ok(out.headers["Retry-After"]);
        assert.strictEqual(out.body.role, "standby");
    });

    test("the node-to-node API and the health endpoint stay reachable on a standby", () => {
        const ha = makeHa();
        for (const name of ["status", "snapshot", "observe", "handover", "leader-gone", "config", "health"]) {
            assert.strictEqual(ask(ha, "GET", `/api/ha/${name}`).passed, true, name);
        }
        assert.strictEqual(ask(ha, "GET", "/api/ha/unknown").status, 503);
        assert.strictEqual(ask(ha, "GET", "/api/ha/status/../../x").status, 503);
    });

    test("browsers get a page that does not reveal where the active node is", () => {
        const out = ask(makeHa(), "GET", "/", "text/html,application/xhtml+xml");
        assert.strictEqual(out.status, 503);
        assert.match(out.body, /standby/i);
        assert.ok(!out.body.includes("10.1.2.4") && !out.body.includes("10.1.2.3"), "no internal addresses on a public page");
    });

    test("standbyStatusPages: serves public pages, still refuses the dashboard", () => {
        const ha = makeHa({ standbyStatusPages: true });
        assert.strictEqual(ask(ha, "GET", "/status/default", "text/html").passed, true);
        assert.strictEqual(ask(ha, "GET", "/api/badge/1/status").passed, true);
        assert.strictEqual(ask(ha, "GET", "/dashboard", "text/html").status, 503);
        // Live change from the settings page
        ha.applyConfig({ ...ha.config, standbyStatusPages: false });
        assert.strictEqual(ask(ha, "GET", "/status/default", "text/html").status, 503);
    });

    test("nothing happens when peer HA is not running", () => {
        const plain = { peerMode: false, isLeader: () => false };
        assert.strictEqual(ask(plain, "GET", "/").passed, true);
        assert.strictEqual(ask(null, "GET", "/").passed, true);
    });

    test("standbyStatusPages is a shared setting that defaults to the strict behaviour", () => {
        assert.strictEqual(haConfig.normalize({}).standbyStatusPages, false);
        assert.ok(haConfig.SHARED_KEYS.includes("standbyStatusPages"));
    });
});

describe("HA peers (two nodes, real HTTP, real SQLite files)", { skip: !DatabaseSync }, () => {
    const SECRET = "test-secret-test-secret";
    let nodes = [];

    /**
     * Create the database of a node
     * @param {string} file Path
     * @param {boolean} withData Add a monitor and a heartbeat
     * @returns {void}
     */
    function createDb(file, withData) {
        const db = new DatabaseSync(file);
        db.exec(`
            CREATE TABLE monitor (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE user (id INTEGER PRIMARY KEY, username TEXT);
            CREATE TABLE heartbeat (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER, status INTEGER, note TEXT);
        `);
        if (withData) {
            db.exec("INSERT INTO monitor VALUES (1, 'Website'); INSERT INTO user VALUES (1, 'admin');");
            db.exec("INSERT INTO setting VALUES ('title', 'My Kuma')");
        }
        db.close();
    }

    /**
     * Create a node (own data dir, own database, own HTTP server)
     * @param {string} name Name
     * @param {object} options Options
     * @returns {Promise<object>} Test node
     */
    async function createNode(name, options = {}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ha-${name}-`));
        const node = {
            name,
            dir,
            live: path.join(dir, "kuma.db"),
            events: [],
            online: true,
            options,
            version: options.version || "2.2.0",
        };
        createDb(node.live, !!options.bootstrap);
        node.config = (peers) =>
            haConfig.normalize({
                enabled: true,
                nodeName: name,
                preferred: !!options.preferred,
                bootstrap: !!options.bootstrap,
                secret: options.secret || SECRET,
                selfUrl: node.url || "",
                peers,
            });
        await startServer(node);
        nodes.push(node);
        return node;
    }

    /**
     * (Re)start the HTTP server of a node, on the same port as before
     * @param {object} node Test node
     * @returns {Promise<void>}
     */
    async function startServer(node) {
        node.server = http.createServer(async (req, res) => {
            const url = new URL(req.url, "http://x");
            let body = "";
            for await (const chunk of req) {
                body += chunk;
            }
            const result = await dispatchPeerRequest(node.ha, {
                method: req.method,
                name: url.pathname.replace("/api/ha/", ""),
                query: Object.fromEntries(url.searchParams),
                authorization: req.headers.authorization,
                have: req.headers["x-ha-have"],
                body: body ? JSON.parse(body) : undefined,
            });
            if (result.snapshot) {
                res.writeHead(200, {
                    "Content-Type": "application/gzip",
                    "x-ha-snapshot-id": result.snapshot.id,
                    "x-ha-sha256": result.snapshot.sha256,
                    "x-ha-epoch": String(result.snapshot.epoch),
                });
                node.ha.replicator.openStream(result.snapshot).pipe(res);
                return;
            }
            res.writeHead(result.status, { "Content-Type": "application/json" });
            res.end(result.json ? JSON.stringify(result.json) : "");
        });
        await new Promise((resolve) => node.server.listen(node.port || 0, "127.0.0.1", resolve));
        node.port = node.server.address().port;
        node.url = `http://127.0.0.1:${node.port}`;
    }

    /**
     * Simulate "the process (re)starts": a new manager that reads the persisted state of the data dir
     * @param {object} node Test node
     * @param {string[]} peers Peer URLs
     * @returns {void}
     */
    function boot(node, peers) {
        node.events = [];
        const config = { ...node.config(peers), ...(node.options.config || {}) };
        const ha = new PeerHAManager({
            config,
            dataDir: node.dir,
            version: node.version,
            connectivityCheck: async () => node.online,
            onPromote: async () => node.events.push("promote"),
            onDemote: async () => node.events.push("demote"),
            onStandbySync: async () => {
                await ha.syncFromLeader().catch((e) => (node.lastSyncError = e.message));
            },
        });
        ha.standbySyncEvery = 1;
        ha.loadState();

        const replicator = new Replicator({
            dataDir: node.dir,
            snapshotIntervalSec: 0,
            quickCheck: async (file) => {
                const db = new DatabaseSync(file, { readOnly: true });
                try {
                    return db.prepare("PRAGMA quick_check").get().quick_check === "ok";
                } catch (e) {
                    return false;
                } finally {
                    db.close();
                }
            },
            createSnapshot: async (dest) => {
                const db = new DatabaseSync(node.live);
                db.exec(`VACUUM INTO '${dest}'`);
                db.close();
            },
            // Stand-in for Database.swapSqliteFile(): keep the old file, put the new one in place
            applyFile: async (file) => {
                const backups = path.join(node.dir, "ha", "backups");
                fs.mkdirSync(backups, { recursive: true });
                fs.renameSync(node.live, path.join(backups, `kuma-${Date.now()}.db`));
                fs.renameSync(file, node.live);
            },
        });
        ha.attachReplicator(replicator);
        node.ha = ha;
    }

    /**
     * One election round of a node
     * @param {object} node Test node
     * @returns {Promise<void>}
     */
    async function tick(node) {
        node.ha.stopped = false;
        await node.ha.tick();
        clearTimeout(node.ha.timer);
        await sleep(5); // distinct snapshot ids
    }

    /**
     * @param {object} node Test node
     * @param {number} monitorId Monitor
     * @param {number} status Status
     * @returns {void}
     */
    function beat(node, monitorId, status) {
        const db = new DatabaseSync(node.live);
        db.prepare("INSERT INTO heartbeat (monitor_id, status, note) VALUES (?, ?, ?)").run(monitorId, status, node.name);
        db.close();
    }

    /**
     * @param {object} node Test node
     * @returns {object[]} All heartbeats in the node's database
     */
    function beats(node) {
        const db = new DatabaseSync(node.live, { readOnly: true });
        const rows = db.prepare("SELECT monitor_id, status, note FROM heartbeat ORDER BY id").all();
        db.close();
        return rows;
    }

    /**
     * Kill the HTTP server of a node (the machine "goes offline")
     * @param {object} node Test node
     * @returns {Promise<void>}
     */
    async function powerOff(node) {
        node.server.closeAllConnections();
        await new Promise((resolve) => node.server.close(resolve));
    }

    /**
     * A main node A and a secondary B, A active and B in sync
     * @param {object} extra Extra config for both
     * @returns {Promise<{a: object, b: object}>} Nodes
     */
    async function cluster(extra = {}) {
        const timing = { failoverAfterSec: 1, staggerSec: 1, failbackAfterSec: 0, isolationGraceSec: 0, snapshotIntervalSec: 5, ...extra };
        const a = await createNode("A", { preferred: true, bootstrap: true, config: timing });
        const b = await createNode("B", { config: timing });
        // The checks use real intervals below the allowed minimum: skip validation by assigning directly
        boot(a, [b.url]);
        boot(b, [a.url]);
        Object.assign(a.ha.config, timing);
        Object.assign(b.ha.config, timing);

        await tick(b); // B is not eligible and sees no leader
        await tick(a);
        await sleep(1100);
        await tick(a); // main node: no active node for 1s -> active
        assert.strictEqual(a.ha.isLeader(), true);
        await tick(b); // B follows and copies the data
        assert.strictEqual(b.ha.isLeader(), false);
        assert.strictEqual(b.ha.state.hasReplica, true);
        return { a, b };
    }

    afterEach(async () => {
        for (const node of nodes) {
            clearTimeout(node.ha?.timer);
            node.server.closeAllConnections?.();
            node.server.close();
            fs.rmSync(node.dir, { recursive: true, force: true });
        }
        nodes = [];
    });

    test("standby copies the data of the active node and refuses to take over before it has", async () => {
        const a = await createNode("A", { preferred: true, bootstrap: true });
        const b = await createNode("B");
        boot(a, [b.url]);
        boot(b, [a.url]);
        Object.assign(b.ha.config, { failoverAfterSec: 1, staggerSec: 0 });

        // B was never synced and A is unreachable: it must NOT start with its empty database
        await powerOff(a);
        await tick(b);
        await sleep(1200);
        await tick(b);
        assert.strictEqual(b.ha.isLeader(), false, "a joining node without data must not become active");
        assert.strictEqual(b.ha.eligible(), false);
    });

    test("failover: the survivor keeps going when the main node goes offline", async () => {
        const { a, b } = await cluster();
        beat(a, 1, UP);
        beat(a, 1, UP);
        await tick(b);
        assert.strictEqual(beats(b).length, 2, "standby has the heartbeats of the active node");

        await powerOff(a);
        await tick(b);
        assert.strictEqual(b.ha.isLeader(), false, "not immediately, only after failoverAfterSec");
        await sleep(2200); // failoverAfterSec + stagger of the secondary
        await tick(b);
        assert.strictEqual(b.ha.isLeader(), true);
        assert.ok(b.events.includes("promote"));
        assert.strictEqual(b.ha.epoch, 2);
        assert.strictEqual(beats(b).length, 2, "nothing lost");
    });

    test("failback: the main node gets back everything the secondary recorded, then continues", async () => {
        const { a, b } = await cluster();
        beat(a, 1, UP);
        await tick(b);

        await powerOff(a);
        await tick(b); // B notices that there is no active node (starts the timer)
        await sleep(2200);
        await tick(b);
        assert.strictEqual(b.ha.isLeader(), true);

        // The secondary is active now and records data the main node has never seen
        beat(b, 1, DOWN);
        beat(b, 1, UP);
        assert.strictEqual(beats(a).length, 1);

        // The main node comes back (new process, old database)
        await startServer(a);
        boot(a, [b.url]);
        Object.assign(a.ha.config, { failoverAfterSec: 1, staggerSec: 1, failbackAfterSec: 0 });
        await tick(a);

        assert.strictEqual(a.ha.isLeader(), true, "main node is active again");
        assert.ok(a.ha.epoch > 2, "higher epoch than the secondary had");
        assert.deepStrictEqual(
            beats(a).map((r) => r.note),
            ["A", "B", "B"],
            "the data recorded by the secondary is on the main node now"
        );
        assert.ok(b.events.includes("demote"), "the secondary stopped its monitors for the handover");
        assert.ok(fs.readdirSync(path.join(a.dir, "ha", "backups")).length >= 1, "old database kept as backup");

        // The secondary follows and copies it all back
        await tick(b);
        assert.strictEqual(b.ha.isLeader(), false);
        assert.strictEqual(beats(b).length, 3);
    });

    test("failback can be turned off", async () => {
        const { a, b } = await cluster();
        await powerOff(a);
        await tick(b);
        await sleep(2200);
        await tick(b);
        await startServer(a);
        boot(a, [b.url]);
        Object.assign(a.ha.config, { failoverAfterSec: 1, autoFailback: false });
        await tick(a);
        assert.strictEqual(a.ha.isLeader(), false);
        assert.strictEqual(b.ha.isLeader(), true);
    });

    test("up wins: a peer that sees the service UP overrules the active node's DOWN, a DOWN never overrules UP", async () => {
        const { a, b } = await cluster();
        await b.ha.recordObservation(1, UP, "ok", 42);
        await b.ha.recordObservation(2, DOWN, "timeout", null);
        await sleep(100);

        const up = await a.ha.findPeerUp({ id: 1, interval: 60 });
        assert.strictEqual(up.nodeName, "B");
        assert.strictEqual(up.ping, 42);
        assert.strictEqual(await a.ha.findPeerUp({ id: 2, interval: 60 }), null);
        assert.strictEqual(await a.ha.findPeerUp({ id: 3, interval: 60 }), null);

        // A stale observation expires on its own
        a.ha.peerObs.get(1).forEach((obs) => (obs.at -= 200000));
        assert.strictEqual(await a.ha.findPeerUp({ id: 1, interval: 60 }), null);
    });

    test("a main node that lost its wifi stands down, keeps clean data and takes over the secondary's data later", async () => {
        const { a, b } = await cluster();
        beat(a, 1, UP);
        await tick(b);

        // Wifi of the main node is gone: it must not record DOWN for everything
        a.online = false;
        a.ha.connectivityCache.at = 0;
        await tick(a);
        assert.strictEqual(a.ha.isLeader(), false, "blind node stands down");
        assert.ok(a.events.includes("demote"));

        // The secondary has connectivity and takes over
        await tick(b);
        await sleep(2200);
        await tick(b);
        assert.strictEqual(b.ha.isLeader(), true);
        beat(b, 1, UP);

        // The main node must not promote itself while blind
        a.ha.connectivityCache.at = 0;
        await tick(a);
        assert.strictEqual(a.ha.isLeader(), false);
        assert.strictEqual(beats(a).filter((r) => r.status === DOWN).length, 0, "no false DOWN on the main node");

        // Wifi is back: the main node gets the secondary's data and becomes active again
        a.online = true;
        a.ha.connectivityCache.at = 0;
        await tick(a);
        assert.strictEqual(a.ha.isLeader(), true);
        assert.deepStrictEqual(
            beats(a).map((r) => r.note),
            ["A", "B"]
        );
    });

    test("an isolated standby never promotes itself (it cannot know if the other node is dead)", async () => {
        const { a, b } = await cluster();
        await powerOff(a);
        b.online = false;
        b.ha.connectivityCache.at = 0;
        await sleep(2200);
        await tick(b);
        await tick(b);
        assert.strictEqual(b.ha.isLeader(), false);
    });

    test("two active nodes: the higher epoch wins, the loser demotes", async () => {
        const { a, b } = await cluster();
        // Split brain (both think they are active), B has the higher epoch
        b.ha.leader = true;
        b.ha.epoch = 5;
        b.ha.lastRenewOk = Date.now();
        a.ha.epoch = 3;

        await tick(a);
        assert.strictEqual(a.ha.isLeader(), false, "lower epoch gives way");
        await tick(b);
        assert.strictEqual(b.ha.isLeader(), true);
    });

    test("graceful shutdown: the other node takes over at once", async () => {
        const { a, b } = await cluster();
        await a.ha.stop();
        await tick(b);
        assert.strictEqual(b.ha.isLeader(), true, "no waiting for failoverAfterSec");
    });

    test("wrong shared secret is rejected and shown", async () => {
        const a = await createNode("A", { preferred: true, bootstrap: true });
        const b = await createNode("B", { secret: "another-secret-another-secret" });
        boot(a, [b.url]);
        boot(b, [a.url]);
        await tick(a);
        const peer = a.ha.getDetail().peers[0];
        assert.strictEqual(peer.reachable, false);
        assert.match(peer.lastError, /shared secret/);
    });

    test("nodes of different versions never sync", async () => {
        const a = await createNode("A", { preferred: true, bootstrap: true, version: "2.2.0" });
        const b = await createNode("B", { version: "2.3.0" });
        boot(a, [b.url]);
        boot(b, [a.url]);
        Object.assign(a.ha.config, { failoverAfterSec: 1 });
        await tick(a);
        await sleep(1100);
        await tick(a);
        assert.strictEqual(a.ha.isLeader(), true);
        await tick(b);
        assert.match(b.lastSyncError, /version/);
        assert.strictEqual(b.ha.state.hasReplica, false);
    });

    test("a corrupted snapshot is discarded and the live database stays untouched", async () => {
        const { a, b } = await cluster();
        beat(a, 1, UP);
        const before = beats(b).length;

        const snapshot = await a.ha.replicator.getSnapshot({ fresh: true });
        snapshot.sha256 = "0".repeat(64); // what the peer announces does not match the bytes
        a.ha.replicator.cache = snapshot;
        a.ha.replicator.snapshotIntervalSec = 3600; // keep serving this one

        await assert.rejects(() => b.ha.pullFrom(a.url), /checksum/);
        assert.strictEqual(beats(b).length, before);
    });

    test("only a non-preferred active node hands over, and only on request of an authenticated peer", async () => {
        const { a, b } = await cluster();
        const unauth = await dispatchPeerRequest(a.ha, { method: "POST", name: "handover", authorization: "Bearer nope", body: {} });
        assert.strictEqual(unauth.status, 401);
        const refused = await dispatchPeerRequest(a.ha, {
            method: "POST",
            name: "handover",
            authorization: `Bearer ${SECRET}`,
            body: { from: "B:1" },
        });
        assert.strictEqual(refused.status, 409, "the preferred node does not hand over");
        const standbyRefuses = await dispatchPeerRequest(b.ha, {
            method: "GET",
            name: "snapshot",
            query: {},
            authorization: `Bearer ${SECRET}`,
        });
        assert.strictEqual(standbyRefuses.status, 409, "a standby serves no snapshots");
    });

    test("shared tunables pushed from the other node are applied, the secret and name stay local", async () => {
        const { a, b } = await cluster();
        const dir = b.dir;
        b.ha.dataDir = dir;
        const result = await dispatchPeerRequest(b.ha, {
            method: "POST",
            name: "config",
            authorization: `Bearer ${SECRET}`,
            body: { shared: { failoverAfterSec: 40, nodeName: "hacked", secret: "hacked" }, preferred: false },
        });
        assert.strictEqual(result.status, 200);
        assert.strictEqual(b.ha.config.failoverAfterSec, 40);
        assert.strictEqual(b.ha.config.secret, SECRET);
        assert.notStrictEqual(b.ha.config.nodeName, "hacked");
        assert.strictEqual(haConfig.load(dir).failoverAfterSec, 40);
        assert.ok(a);
    });
});
