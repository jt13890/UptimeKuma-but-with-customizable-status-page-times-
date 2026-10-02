const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { UP, DOWN, MAINTENANCE, DEGRADED } = require("../../src/util");

describe("Degraded status (database)", () => {
    const testDbPath = path.join(__dirname, "../../data/test-degraded.db");
    let R;
    let settleRecentDegraded;
    let settleAllDegraded;

    before(async () => {
        fs.mkdirSync(path.dirname(testDbPath), { recursive: true });
        fs.rmSync(testDbPath, { force: true });

        // Use the same SQLite driver as the project
        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");
        const knex = require("knex")({
            client: Dialect,
            connection: { filename: testDbPath },
            useNullAsDefault: true,
        });

        ({ R } = require("redbean-node"));
        R.setup(knex);
        // The jobs build their SQL for the configured database type
        require("../../server/database").dbConfig = { type: "sqlite" };

        await require("../../db/knex_init_db.js").createTables();
        await R.knex.migrate.latest({ directory: path.join(__dirname, "../../db/knex_migrations") });
        await R.exec("INSERT INTO user (username, password) VALUES ('test', 'test')");

        // Only load the models after R is set up
        R.autoloadModels("./server/model");
        ({ settleRecentDegraded, settleAllDegraded } = require("../../server/jobs/settle-degraded"));
    });

    after(async () => {
        await R.knex.destroy();
        fs.rmSync(testDbPath, { force: true });
    });

    const addMonitor = async (name, fields = {}) => {
        const bean = R.dispense("monitor");
        Object.assign(bean, { name, type: "push", user_id: 1, interval: 60, active: 1, ...fields });
        return await R.store(bean);
    };

    let lastBeatTime = dayjs.utc().subtract(10, "day");
    const addBeat = async (monitorID, status, hoursAgo = 0, important = 0) => {
        const bean = R.dispense("heartbeat");
        bean.monitor_id = monitorID;
        bean.status = status;
        bean.important = important;
        bean.msg = "";
        // Newer beats must have a later time, even if they are inserted in the same millisecond
        lastBeatTime = lastBeatTime.add(1, "millisecond");
        bean.time = R.isoDateTimeMillis(hoursAgo > 0 ? dayjs.utc().subtract(hoursAgo, "hour") : lastBeatTime);
        return await R.store(bean);
    };

    const statusOf = async (id) => await R.getRow("SELECT status, important FROM heartbeat WHERE id = ?", [id]);

    test("isAnyOtherDown() looks at the latest beat of the watched monitors", async () => {
        const a = await addMonitor("a", { degradedByOthers: true });
        const b = await addMonitor("b");
        const c = await addMonitor("c");
        const paused = await addMonitor("paused", { active: 0 });
        const group = await addMonitor("group", { type: "group" });
        const load = async (id) => await R.findOne("monitor", " id = ? ", [id]);

        assert.strictEqual(await (await load(a)).isAnyOtherDown(), false, "no heartbeats yet");

        await addBeat(b, UP);
        await addBeat(c, UP);
        assert.strictEqual(await (await load(a)).isAnyOtherDown(), false, "all others are up");

        await addBeat(c, DOWN);
        assert.strictEqual(await (await load(a)).isAnyOtherDown(), true, "one other is down");

        await addBeat(c, UP);
        assert.strictEqual(await (await load(a)).isAnyOtherDown(), false, "only the latest beat counts");

        await addBeat(paused, DOWN);
        await addBeat(group, DOWN);
        assert.strictEqual(await (await load(a)).isAnyOtherDown(), false, "paused monitors and groups are ignored");

        await addBeat(b, MAINTENANCE);
        assert.strictEqual(await (await load(a)).isAnyOtherDown(), false, "maintenance is not down");

        // Watch a list
        const bean = await load(a);
        bean.degradedDependsOn = JSON.stringify([b]);
        await R.store(bean);
        await addBeat(c, DOWN);
        assert.strictEqual(await (await load(a)).isAnyOtherDown(), false, "c is down, but only b is watched");
        await addBeat(b, DOWN);
        assert.strictEqual(await (await load(a)).isAnyOtherDown(), true, "b is watched and down");

        // The option is off
        bean.degradedByOthers = false;
        await R.store(bean);
        assert.strictEqual(await (await load(a)).isAnyOtherDown(), false, "option is off");
    });

    test("degraded heartbeats older than 24 hours are stored as up", async () => {
        const id = await addMonitor("settle");
        const old = await addBeat(id, DEGRADED, 30, 1);
        const oldOther = await addBeat(id, DOWN, 30, 1);
        const fresh = await addBeat(id, DEGRADED, 2, 1);

        await settleRecentDegraded();

        assert.deepStrictEqual(await statusOf(old), { status: UP, important: 0 });
        assert.deepStrictEqual(await statusOf(oldOther), { status: DOWN, important: 1 });
        assert.deepStrictEqual(await statusOf(fresh), { status: DEGRADED, important: 1 });
    });

    test("the hourly job only looks 72 hours back, the daily sweep gets everything", async () => {
        const id = await addMonitor("sweep");
        const veryOld = await addBeat(id, DEGRADED, 24 * 20, 1);

        await settleRecentDegraded();
        assert.strictEqual((await statusOf(veryOld)).status, DEGRADED);

        await settleAllDegraded();
        assert.deepStrictEqual(await statusOf(veryOld), { status: UP, important: 0 });
    });
});
