const { describe, test } = require("node:test");
const assert = require("node:assert");
const Monitor = require("../../server/model/monitor");

/**
 * Build a monitor bean-like object without touching the database
 * @param {object} props Properties to set, as the bean would expose them
 * @returns {Monitor} Monitor instance with the given properties
 */
function makeMonitor(props) {
    return Object.assign(Object.create(Monitor.prototype), { id: 1, name: "Test", type: "http", ...props });
}

describe("Monitor status page pill options", () => {
    describe("normalizePillMode()", () => {
        test("accepts the known modes", () => {
            assert.strictEqual(Monitor.normalizePillMode("global"), "global");
            assert.strictEqual(Monitor.normalizePillMode("status"), "status");
            assert.strictEqual(Monitor.normalizePillMode("uptime"), "uptime");
        });

        test("falls back to global for unknown, empty or missing values", () => {
            assert.strictEqual(Monitor.normalizePillMode("bogus"), "global");
            assert.strictEqual(Monitor.normalizePillMode(""), "global");
            assert.strictEqual(Monitor.normalizePillMode(null), "global");
            assert.strictEqual(Monitor.normalizePillMode(undefined), "global");
            assert.strictEqual(Monitor.normalizePillMode(1), "global");
        });
    });

    describe("toPublicJSON()", () => {
        test("defaults to following the global setting with the pill shown (legacy rows)", async () => {
            const json = await makeMonitor({}).toPublicJSON();
            assert.strictEqual(json.pillMode, "global");
            assert.strictEqual(json.showPill, true);
        });

        test("exposes stored values, converting SQL 0/1 to a boolean", async () => {
            const hidden = await makeMonitor({ pillMode: "uptime", showPill: 0 }).toPublicJSON();
            assert.strictEqual(hidden.pillMode, "uptime");
            assert.strictEqual(hidden.showPill, false);

            const shown = await makeMonitor({ pillMode: "status", showPill: 1 }).toPublicJSON();
            assert.strictEqual(shown.pillMode, "status");
            assert.strictEqual(shown.showPill, true);
        });

        test("sanitizes an invalid stored mode", async () => {
            const json = await makeMonitor({ pillMode: "nope", showPill: true }).toPublicJSON();
            assert.strictEqual(json.pillMode, "global");
        });
    });
});
