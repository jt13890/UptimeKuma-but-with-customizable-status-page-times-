const { describe, test } = require("node:test");
const assert = require("node:assert");
const { validateEdit, categoriesOf, bucketKey, planHistoryEdit } = require("../../server/history-edit");
const { UP, DOWN, PENDING, MAINTENANCE, DEGRADED } = require("../../src/util");

const NOW = Date.parse("2026-11-09T12:00:00Z");
const at = (iso) => Date.parse(iso);
const beat = (id, iso, status) => ({ id, time: at(iso), status });

describe("History edit: validateEdit", () => {
    const ok = { from: at("2026-11-09T08:00:00Z"), to: at("2026-11-09T09:00:00Z"), status: "down" };

    test("accepts a valid range and maps the status", () => {
        assert.strictEqual(validateEdit(ok, NOW).status, DOWN);
        assert.strictEqual(validateEdit({ ...ok, status: "up" }, NOW).status, UP);
    });

    test("rejects invalid input", () => {
        assert.throws(() => validateEdit({ ...ok, from: "x" }, NOW), /required/);
        assert.throws(() => validateEdit({ ...ok, status: "pending" }, NOW), /up or down/);
        assert.throws(() => validateEdit({ ...ok, to: ok.from }, NOW), /after the start/);
        assert.throws(() => validateEdit({ ...ok, to: NOW + 1000 }, NOW), /past/);
        assert.throws(() => validateEdit({ ...ok, from: NOW - 200 * 86400000, to: NOW - 199 * 86400000 }, NOW, 180), /last 180 days/);
        assert.throws(() => validateEdit({ ...ok, from: NOW - 100 * 86400000, to: NOW - 1000 }, NOW, 180), /too long/);
    });

    test("end may be exactly now", () => {
        assert.doesNotThrow(() => validateEdit({ ...ok, to: NOW }, NOW));
    });
});

describe("History edit: categoriesOf follows UptimeCalculator", () => {
    test("up, down, pending, maintenance", () => {
        assert.deepStrictEqual(categoriesOf(UP, "daily"), { up: 1, down: 0, maintenance: 0, degraded: 0 });
        assert.deepStrictEqual(categoriesOf(DOWN, "hourly"), { up: 0, down: 1, maintenance: 0, degraded: 0 });
        assert.deepStrictEqual(categoriesOf(PENDING, "minutely"), { up: 0, down: 1, maintenance: 0, degraded: 0 });
        assert.deepStrictEqual(categoriesOf(MAINTENANCE, "daily"), { up: 0, down: 0, maintenance: 1, degraded: 0 });
    });

    test("degraded is down in minutely data and up in hourly / daily data", () => {
        assert.deepStrictEqual(categoriesOf(DEGRADED, "minutely"), { up: 0, down: 1, maintenance: 0, degraded: 1 });
        assert.deepStrictEqual(categoriesOf(DEGRADED, "hourly"), { up: 1, down: 0, maintenance: 0, degraded: 0 });
        assert.deepStrictEqual(categoriesOf(DEGRADED, "daily"), { up: 1, down: 0, maintenance: 0, degraded: 0 });
    });
});

describe("History edit: planHistoryEdit", () => {
    const base = {
        from: at("2026-11-09T08:00:00Z"),
        to: at("2026-11-09T08:05:00Z"),
        intervalSeconds: 60,
        now: NOW,
    };

    test("moves counts of changed heartbeats between categories in every table", () => {
        const beats = [
            beat(1, "2026-11-09T08:00:10Z", UP),
            beat(2, "2026-11-09T08:01:10Z", UP),
            beat(3, "2026-11-09T08:02:10Z", DOWN),
            beat(4, "2026-11-09T08:03:10Z", UP),
            beat(5, "2026-11-09T08:04:10Z", UP),
        ];
        const plan = planHistoryEdit({ ...base, beats, status: DOWN });
        assert.deepStrictEqual(plan.updates.map((u) => u.id), [1, 2, 4, 5]);
        assert.strictEqual(plan.summary.unchanged, 1);
        assert.strictEqual(plan.summary.inserted, 0);

        // One minute bucket per beat: up -1, down +1
        const minute = plan.deltas.minutely.get(bucketKey("minutely", beats[0].time));
        assert.strictEqual(minute.up, -1);
        assert.strictEqual(minute.down, 1);
        // All five beats are in the same hour and day: 4 changed
        const hour = plan.deltas.hourly.get(bucketKey("hourly", beats[0].time));
        assert.strictEqual(hour.up, -4);
        assert.strictEqual(hour.down, 4);
        const day = plan.deltas.daily.get(bucketKey("daily", beats[0].time));
        assert.strictEqual(day.up, -4);
        assert.strictEqual(day.down, 4);
        // The counts of the table stay balanced: total does not change when nothing is inserted
        for (const table of ["minutely", "hourly", "daily"]) {
            for (const d of plan.deltas[table].values()) {
                assert.strictEqual(d.up + d.down + d.maintenance, 0);
            }
        }
    });

    test("a heartbeat that already has the status is left alone", () => {
        const beats = [beat(1, "2026-11-09T08:00:10Z", UP)];
        const plan = planHistoryEdit({ ...base, to: at("2026-11-09T08:01:00Z"), beats, status: UP });
        assert.strictEqual(plan.updates.length, 0);
        assert.strictEqual(plan.inserts.length, 0);
    });

    test("slots without a heartbeat are filled", () => {
        const beats = [beat(1, "2026-11-09T08:00:10Z", UP), beat(2, "2026-11-09T08:04:10Z", UP)];
        const plan = planHistoryEdit({ ...base, beats, status: DOWN });
        assert.strictEqual(plan.summary.inserted, 3);
        assert.deepStrictEqual(
            plan.inserts.map((i) => new Date(i.time).toISOString().slice(11, 19)),
            ["08:01:00", "08:02:00", "08:03:00"]
        );
        // Inserted beats create missing rows, the total of the day grows by 3
        const day = plan.deltas.daily.get(bucketKey("daily", base.from));
        assert.strictEqual(day.create, true);
        assert.strictEqual(day.up + day.down, 3);
    });

    test("an empty range is filled completely", () => {
        const plan = planHistoryEdit({ ...base, beats: [], status: UP });
        assert.strictEqual(plan.summary.inserted, 5);
    });

    test("maintenance and degraded heartbeats are reclassified with the table rules", () => {
        const beats = [beat(1, "2026-11-09T08:00:10Z", MAINTENANCE), beat(2, "2026-11-09T08:01:10Z", DEGRADED)];
        const plan = planHistoryEdit({ ...base, to: at("2026-11-09T08:02:00Z"), beats, status: UP });
        const m0 = plan.deltas.minutely.get(bucketKey("minutely", beats[0].time));
        assert.deepStrictEqual([m0.maintenance, m0.up], [-1, 1]);
        const m1 = plan.deltas.minutely.get(bucketKey("minutely", beats[1].time));
        assert.deepStrictEqual([m1.down, m1.degraded, m1.up], [-1, -1, 1]);
        // In the hourly data degraded was already up: only the maintenance beat moves
        const hour = plan.deltas.hourly.get(bucketKey("hourly", beats[0].time));
        assert.deepStrictEqual([hour.maintenance, hour.up], [-1, 1]);
    });

    test("rows are only created while the table would still keep them", () => {
        const old = { from: NOW - 3 * 86400000, to: NOW - 3 * 86400000 + 60000, intervalSeconds: 60, now: NOW };
        const plan = planHistoryEdit({ ...old, beats: [], status: DOWN });
        assert.strictEqual(plan.deltas.minutely.get(bucketKey("minutely", old.from)).create, false); // older than 24h
        assert.strictEqual(plan.deltas.hourly.get(bucketKey("hourly", old.from)).create, true);
        assert.strictEqual(plan.deltas.daily.get(bucketKey("daily", old.from)).create, true);
    });

    test("too many gaps are refused", () => {
        assert.throws(
            () => planHistoryEdit({ from: NOW - 30 * 86400000, to: NOW, intervalSeconds: 20, beats: [], status: UP, now: NOW }),
            /too many gaps/
        );
    });
});
