const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("High availability lease", () => {
    const testDbPath = path.join(__dirname, "../../data/test-ha.db");
    let R;
    let HAManager;

    /**
     * @param {object} extra Extra options
     * @returns {HAManager} A manager with short timings and recorded transitions
     */
    function makeNode(extra = {}) {
        const events = [];
        const node = new HAManager({
            enabled: true,
            name: extra.name || "node",
            ttlSec: 4,
            renewIntervalSec: 1,
            onPromote: async () => events.push("promote"),
            onDemote: async () => events.push("demote"),
            ...extra,
        });
        node.events = events;
        return node;
    }

    before(async () => {
        fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
        fs.rmSync(testDbPath, { force: true });

        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");
        const knex = require("knex")({
            client: Dialect,
            connection: { filename: testDbPath },
            useNullAsDefault: true,
        });

        ({ R } = require("redbean-node"));
        R.setup(knex);
        // Same as Database.connect(): SQLite only enforces foreign keys (cascade deletes) when asked to
        await R.exec("PRAGMA foreign_keys = ON");
        require("../../server/database").dbConfig = { type: "sqlite" };

        await require("../../db/knex_init_db.js").createTables();
        await R.knex.migrate.latest({ directory: path.join(__dirname, "../../db/knex_migrations") });
        ({ HAManager } = require("../../server/ha"));
    });

    after(async () => {
        await R.knex.destroy();
        fs.rmSync(testDbPath, { force: true });
    });

    test("disabled HA is inert and always leader", () => {
        const node = new HAManager({ enabled: false });
        assert.strictEqual(node.isLeader(), true);
        assert.strictEqual(node.getStatus().role, "standalone");
    });

    test("invalid lease settings fall back to safe defaults", () => {
        const node = new HAManager({ enabled: true, ttlSec: 3, renewIntervalSec: 5 });
        assert.strictEqual(node.ttlSec, 15);
        assert.strictEqual(node.renewIntervalSec, 5);
        assert.ok(node.fenceAfterMs < node.ttlSec * 1000);
    });

    test("only one of two nodes can hold the lease", async () => {
        const a = makeNode({ name: "a" });
        const b = makeNode({ name: "b" });

        assert.strictEqual(await a.campaign(), true);
        assert.strictEqual(await b.campaign(), false);
        // Renewal keeps it, and does not bump the epoch
        const epoch = a.epoch;
        assert.strictEqual(await a.campaign(), true);
        assert.strictEqual(a.epoch, epoch);
        assert.strictEqual(await b.campaign(), false);

        await a.release();
    });

    test("standby takes over after release, epoch increases", async () => {
        const a = makeNode({ name: "a" });
        const b = makeNode({ name: "b" });

        assert.strictEqual(await a.campaign(), true);
        const epochA = a.epoch;
        await a.release();

        assert.strictEqual(await b.campaign(), true);
        assert.ok(b.epoch > epochA, "epoch is a fencing token and must increase on a new holder");
        // Old holder can no longer renew
        assert.strictEqual(await a.campaign(), false);

        await b.release();
    });

    test("standby takes over after the lease expires without release (crash)", async () => {
        const a = makeNode({ name: "a", ttlSec: 2, renewIntervalSec: 1 });
        const b = makeNode({ name: "b", ttlSec: 2, renewIntervalSec: 1 });

        assert.strictEqual(await a.campaign(), true);
        assert.strictEqual(await b.campaign(), false);
        await sleep(3200);
        assert.strictEqual(await b.campaign(), true);

        await b.release();
    });

    test("full lifecycle: failover on graceful stop, no overlap", async () => {
        const a = makeNode({ name: "a" });
        const b = makeNode({ name: "b" });

        await a.start();
        await b.start();
        assert.deepStrictEqual(a.events, ["promote"]);
        assert.deepStrictEqual(b.events, []);
        assert.strictEqual(a.isLeader(), true);
        assert.strictEqual(b.isLeader(), false);
        assert.strictEqual(b.getStatus().role, "standby");

        await a.stop();
        await sleep(1600);

        assert.deepStrictEqual(b.events, ["promote"]);
        assert.strictEqual(b.isLeader(), true);
        assert.strictEqual(a.isLeader(), false);

        await b.stop();
    });

    test("leader that cannot reach the database fences itself before a standby can take over", async () => {
        const a = makeNode({ name: "a", ttlSec: 4, renewIntervalSec: 1 });
        await a.start();
        assert.strictEqual(a.isLeader(), true);

        // Simulate losing the database: renewals now fail
        a.campaign = async () => {
            throw new Error("db unreachable");
        };

        // fence = ttl - renew = 3s, a standby would need the full 4s
        await sleep(3600);
        assert.strictEqual(a.isLeader(), false);
        assert.deepStrictEqual(a.events, ["promote", "demote"]);

        await a.stop();
        await R.exec("UPDATE ha_lease SET holder = NULL, expires_at = '1970-01-01 00:00:00'");
    });

    test("up wins: a fresh UP observation from a peer is found, everything else is ignored", async () => {
        await R.exec("INSERT INTO monitor (name, type, interval, active) VALUES ('obs', 'http', 20, 1)");
        const monitor = await R.getRow("SELECT id, interval FROM monitor WHERE name = 'obs'");

        const active = makeNode({ name: "active" });
        const peer = makeNode({ name: "peer" });
        const other = makeNode({ name: "other" });

        // Nothing observed yet
        assert.strictEqual(await active.findPeerUp(monitor), null);

        // Peer says DOWN: down never wins
        await peer.recordObservation(monitor.id, 0, "connect ECONNREFUSED", null);
        assert.strictEqual(await active.findPeerUp(monitor), null);

        // Peer says UP: it overrules (one row per monitor and node, so this replaces the DOWN)
        await peer.recordObservation(monitor.id, 1, "200 - OK", 42);
        const found = await active.findPeerUp(monitor);
        assert.strictEqual(found.nodeName, "peer");
        assert.strictEqual(found.ping, 42);
        const rows = await R.getAll("SELECT * FROM ha_observation WHERE monitor_id = ?", [monitor.id]);
        assert.strictEqual(rows.length, 1);

        // A node never overrules itself with its own observation
        assert.strictEqual(await peer.findPeerUp(monitor), null);

        // Peer flips back to DOWN: the override ends immediately
        await peer.recordObservation(monitor.id, 0, "timeout", null);
        assert.strictEqual(await active.findPeerUp(monitor), null);

        // One UP among several peers is enough
        await peer.recordObservation(monitor.id, 0, "timeout", null);
        await other.recordObservation(monitor.id, 1, "OK", 10);
        assert.strictEqual((await active.findPeerUp(monitor)).nodeName, "other");

        await R.exec("DELETE FROM ha_observation");
    });

    test("up wins: stale observations expire (a dead or partitioned peer must not keep a service UP)", async () => {
        const monitor = await R.getRow("SELECT id, interval FROM monitor WHERE name = 'obs'");
        const active = makeNode({ name: "active", observationMaxAgeSec: 2 });
        const peer = makeNode({ name: "peer" });

        await peer.recordObservation(monitor.id, 1, "OK", 5);
        assert.ok(await active.findPeerUp(monitor));
        await sleep(3200);
        assert.strictEqual(await active.findPeerUp(monitor), null);

        // Default max age scales with the monitor interval: 1.5 x 20s + 5s
        const defaults = makeNode({ name: "defaults" });
        await peer.recordObservation(monitor.id, 1, "OK", 5);
        assert.ok(await defaults.findPeerUp(monitor));
        await R.exec("DELETE FROM ha_observation");
    });

    test("up wins is inert when observation is disabled, and never throws on database errors", async () => {
        const monitor = await R.getRow("SELECT id, interval FROM monitor WHERE name = 'obs'");
        const peer = makeNode({ name: "peer" });
        await peer.recordObservation(monitor.id, 1, "OK", 5);

        const off = makeNode({ name: "off", observe: false });
        assert.strictEqual(await off.findPeerUp(monitor), null);
        assert.strictEqual(off.canObserve(), false);

        const broken = makeNode({ name: "broken" });
        const original = R.getRow;
        R.getRow = async () => {
            throw new Error("db unreachable");
        };
        try {
            assert.strictEqual(await broken.findPeerUp(monitor), null);
        } finally {
            R.getRow = original;
        }
        await R.exec("DELETE FROM ha_observation");
    });

    test("only a standby observes; observations are removed with their monitor and old ones are pruned", async () => {
        const node = makeNode({ name: "n" });
        assert.strictEqual(node.canObserve(), false, "not started => stopped");
        await node.start();
        assert.strictEqual(node.canObserve(), false, "the active node runs the real monitors");
        const standby = makeNode({ name: "s" });
        await standby.start();
        assert.strictEqual(standby.canObserve(), true);
        await standby.stop();
        await node.stop();

        const monitor = await R.getRow("SELECT id FROM monitor WHERE name = 'obs'");
        await standby.recordObservation(monitor.id, 1, "OK", 1);
        await R.exec("UPDATE ha_observation SET observed_at = '2000-01-01 00:00:00'");
        await standby.recordObservation(monitor.id, 1, "OK", 1); // same node: row refreshed, not stale
        await makeNode({ name: "old" }).recordObservation(monitor.id, 1, "OK", 1);
        await R.exec("UPDATE ha_observation SET observed_at = '2000-01-01 00:00:00' WHERE node_id LIKE 'old:%'");
        await standby.pruneObservations();
        const left = await R.getAll("SELECT node_id FROM ha_observation");
        assert.strictEqual(left.length, 1);
        assert.ok(left[0].node_id.startsWith("s:"));

        await R.exec("DELETE FROM monitor WHERE id = ?", [monitor.id]);
        assert.strictEqual((await R.getAll("SELECT id FROM ha_observation")).length, 0, "cascade delete");
    });

    test("standby sync hook runs periodically while standby only", async () => {
        let syncs = 0;
        const a = makeNode({ name: "a" });
        const b = makeNode({ name: "b", standbySyncEvery: 2, onStandbySync: async () => syncs++ });

        await a.start();
        await b.start();
        await sleep(3300);
        assert.ok(syncs >= 1, "standby sync should have run");

        await a.stop();
        await sleep(1600);
        assert.strictEqual(b.isLeader(), true);

        // Once active, the node must no longer run the standby sync
        const syncsWhenPromoted = syncs;
        await sleep(2300);
        assert.strictEqual(syncs, syncsWhenPromoted);
        await b.stop();
    });
});
