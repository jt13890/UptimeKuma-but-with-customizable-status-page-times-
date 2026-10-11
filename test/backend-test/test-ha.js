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
