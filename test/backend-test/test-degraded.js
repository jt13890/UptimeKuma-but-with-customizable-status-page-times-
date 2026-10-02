const { describe, test } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
const { UptimeCalculator } = require("../../server/uptime-calculator");
const Monitor = require("../../server/model/monitor");
const { UP, DOWN, PENDING, MAINTENANCE, DEGRADED } = require("../../src/util");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../server/modules/dayjs/plugin/timezone"));
dayjs.extend(require("dayjs/plugin/customParseFormat"));

describe("Degraded status", () => {
    test("only the last 24 hours count degraded as down", async () => {
        UptimeCalculator.currentDate = dayjs.utc("2025-06-30 12:00:00");
        let c = new UptimeCalculator();

        // 23 hours of degraded, then it is up again
        for (let i = 0; i < 23; i++) {
            await c.update(DEGRADED);
            UptimeCalculator.currentDate = UptimeCalculator.currentDate.add(1, "hour");
        }
        await c.update(UP);

        // Last 24 hours: 23 degraded (down) + 1 up
        assert.strictEqual(c.get24Hour().uptime, 1 / 24);
        // Hourly and daily data count degraded as up
        assert.strictEqual(c.get7Day().uptime, 1);
        assert.strictEqual(c.get30Day().uptime, 1);
        assert.strictEqual(c.get1Year().uptime, 1);
    });

    test("minutely data is the only data that knows about degraded", async () => {
        UptimeCalculator.currentDate = dayjs.utc("2025-06-30 12:00:00");
        let c = new UptimeCalculator();
        await c.update(DEGRADED);
        await c.update(DOWN);

        const minutely = c.getAggregatedBuckets(1, 1440).at(-1);
        assert.deepStrictEqual([minutely.up, minutely.down, minutely.degraded], [0, 2, 1]);

        const hourly = c.getAggregatedBuckets(7, 168).at(-1);
        assert.deepStrictEqual([hourly.up, hourly.down, hourly.degraded], [1, 1, 0]);

        const daily = c.getAggregatedBuckets(90, 90).at(-1);
        assert.deepStrictEqual([daily.up, daily.down, daily.degraded], [1, 1, 0]);
    });

    test("flatStatus() treats degraded as up", () => {
        assert.strictEqual(new UptimeCalculator().flatStatus(DEGRADED), UP);
    });

    test("changes to and from degraded are important, but only degraded -> down notifies", () => {
        for (const other of [UP, DOWN, PENDING, MAINTENANCE]) {
            assert.strictEqual(Monitor.isImportantBeat(false, other, DEGRADED), true);
            assert.strictEqual(Monitor.isImportantBeat(false, DEGRADED, other), true);
            assert.strictEqual(Monitor.isImportantForNotification(false, other, DEGRADED), false);
        }
        assert.strictEqual(Monitor.isImportantBeat(false, DEGRADED, DEGRADED), false);
        assert.strictEqual(Monitor.isImportantForNotification(false, DEGRADED, DOWN), true);
        assert.strictEqual(Monitor.isImportantForNotification(false, DEGRADED, UP), false);
    });

    test("parseDegradedDependsOn() accepts a list of IDs only", () => {
        assert.deepStrictEqual(Monitor.parseDegradedDependsOn(undefined), []);
        assert.deepStrictEqual(Monitor.parseDegradedDependsOn([3, 1, 3]), [3, 1]);
        assert.throws(() => Monitor.parseDegradedDependsOn("1,2"));
        assert.throws(() => Monitor.parseDegradedDependsOn(["1"]));
    });
});
