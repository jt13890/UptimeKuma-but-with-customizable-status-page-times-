const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { HaproxyMonitorType, evaluateHaproxyStats, classifyStatus } = require("../../server/monitor-types/haproxy");
const { UP, DEGRADED, MAINTENANCE } = require("../../src/util");

const row = (pxname, svname, status, extra = {}) => ({ pxname, svname, status, ...extra });

const healthy = [
    row("fe", "FRONTEND", "OPEN"),
    row("web", "s1", "UP"),
    row("web", "s2", "UP"),
    row("web", "BACKEND", "UP"),
];

describe("HAProxy monitor: classifyStatus", () => {
    test("maps HAProxy statuses", () => {
        for (const s of ["UP", "UP 1/3", "OPEN", "NO CHECK"]) {
            assert.strictEqual(classifyStatus(s), "up", s);
        }
        for (const s of ["DRAIN", "NOLB"]) {
            assert.strictEqual(classifyStatus(s), "degraded", s);
        }
        for (const s of ["MAINT", "MAINT (via web/s1)"]) {
            assert.strictEqual(classifyStatus(s), "maint", s);
        }
        for (const s of ["DOWN", "DOWN 1/2", "STOP", "", undefined]) {
            assert.strictEqual(classifyStatus(s), "down", String(s));
        }
    });
});

describe("HAProxy monitor: evaluateHaproxyStats", () => {
    test("backend with all servers up is UP", () => {
        const r = evaluateHaproxyStats(healthy, { proxy: "web" });
        assert.strictEqual(r.status, UP);
        assert.strictEqual(r.msg, "web: 2/2 servers up");
    });

    test("backend with a server down is DEGRADED and names it", () => {
        const stats = [row("web", "s1", "UP"), row("web", "s2", "DOWN"), row("web", "BACKEND", "UP")];
        const r = evaluateHaproxyStats(stats, { proxy: "web" });
        assert.strictEqual(r.status, DEGRADED);
        assert.match(r.msg, /1\/2 servers up \(s2 DOWN\)/);
    });

    test("backend below the minimum number of servers throws", () => {
        const stats = [row("web", "s1", "UP"), row("web", "s2", "DOWN"), row("web", "BACKEND", "UP")];
        assert.throws(() => evaluateHaproxyStats(stats, { proxy: "web", minUpServers: 2 }), /minimum is 2/);
    });

    test("backend that HAProxy reports DOWN throws", () => {
        const stats = [row("web", "s1", "DOWN"), row("web", "BACKEND", "DOWN")];
        assert.throws(() => evaluateHaproxyStats(stats, { proxy: "web" }), /no server is available/);
    });

    test("a minimum of 0 or less is treated as 1", () => {
        const stats = [row("web", "s1", "DOWN"), row("web", "BACKEND", "UP")];
        assert.throws(() => evaluateHaproxyStats(stats, { proxy: "web", minUpServers: 0 }), /minimum is 1/);
    });

    test("single server states", () => {
        const stats = [
            row("web", "up", "UP"),
            row("web", "down", "DOWN", { check_status: "L4TOUT" }),
            row("web", "maint", "MAINT"),
            row("web", "drain", "DRAIN"),
        ];
        assert.strictEqual(evaluateHaproxyStats(stats, { proxy: "web", server: "up" }).status, UP);
        assert.strictEqual(evaluateHaproxyStats(stats, { proxy: "web", server: "maint" }).status, MAINTENANCE);
        assert.strictEqual(evaluateHaproxyStats(stats, { proxy: "web", server: "drain" }).status, DEGRADED);
        assert.throws(() => evaluateHaproxyStats(stats, { proxy: "web", server: "down" }), /L4TOUT/);
        assert.throws(() => evaluateHaproxyStats(stats, { proxy: "web", server: "nope" }), /not found/);
    });

    test("frontend only", () => {
        assert.strictEqual(evaluateHaproxyStats(healthy, { proxy: "fe" }).status, UP);
        assert.throws(() => evaluateHaproxyStats([row("fe", "FRONTEND", "STOP")], { proxy: "fe" }), /STOP/);
    });

    test("listen section uses the BACKEND row", () => {
        const stats = [row("l", "FRONTEND", "OPEN"), row("l", "s1", "UP"), row("l", "BACKEND", "UP")];
        assert.strictEqual(evaluateHaproxyStats(stats, { proxy: "l" }).msg, "l: 1/1 servers up");
    });

    test("unknown proxy and bad input throw", () => {
        assert.throws(() => evaluateHaproxyStats(healthy, { proxy: "nope" }), /was not found/);
        assert.throws(() => evaluateHaproxyStats(undefined, { proxy: "web" }), /was not found/);
    });
});

describe("HAProxy monitor: check() against an agent", () => {
    let agent;
    let baseUrl;
    let lastRequest;
    let respond;

    before(async () => {
        agent = http.createServer((req, res) => {
            lastRequest = { url: req.url, auth: req.headers.authorization };
            const { status, body } = respond(req);
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
        });
        await new Promise((resolve) => agent.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${agent.address().port}`;
    });

    after(() => agent.close());

    const makeMonitor = (overrides = {}) => ({
        haproxy_agent_url: baseUrl,
        haproxy_agent_token: "secret-token-123456",
        haproxy_proxy: "web",
        haproxy_server: "",
        haproxy_min_up_servers: 1,
        timeout: 5,
        getIgnoreTls: () => false,
        ...overrides,
    });

    test("sends the token and proxy filter, sets status, message and ping", async () => {
        respond = () => ({ status: 200, body: { stats: healthy } });
        const beat = {};
        await new HaproxyMonitorType().check(makeMonitor(), beat, null);

        assert.strictEqual(lastRequest.auth, "Bearer secret-token-123456");
        assert.strictEqual(lastRequest.url, "/v1/stats?proxy=web");
        assert.strictEqual(beat.status, UP);
        assert.strictEqual(beat.msg, "web: 2/2 servers up");
        assert.ok(beat.ping >= 0);
    });

    test("a trailing slash and a path prefix in the agent URL are handled", async () => {
        respond = () => ({ status: 200, body: { stats: healthy } });
        await new HaproxyMonitorType().check(makeMonitor({ haproxy_agent_url: `${baseUrl}/prefix/` }), {}, null);
        assert.strictEqual(lastRequest.url, "/prefix/v1/stats?proxy=web");
    });

    test("401 gives a clear message", async () => {
        respond = () => ({ status: 401, body: { error: "unauthorized" } });
        await assert.rejects(new HaproxyMonitorType().check(makeMonitor(), {}, null), /rejected the token/);
    });

    test("agent errors are reported", async () => {
        respond = () => ({ status: 502, body: { error: "cannot connect to HAProxy socket: boom" } });
        await assert.rejects(
            new HaproxyMonitorType().check(makeMonitor(), {}, null),
            /502: cannot connect to HAProxy socket/
        );
    });

    test("an unreachable agent is reported", async () => {
        await assert.rejects(
            new HaproxyMonitorType().check(makeMonitor({ haproxy_agent_url: "http://127.0.0.1:1" }), {}, null),
            /Cannot reach the HAProxy agent/
        );
    });

    test("invalid configuration is rejected before any request", async () => {
        const type = new HaproxyMonitorType();
        await assert.rejects(type.check(makeMonitor({ haproxy_agent_url: "" }), {}, null), /agent URL is required/);
        await assert.rejects(type.check(makeMonitor({ haproxy_agent_url: "not a url" }), {}, null), /invalid/);
        await assert.rejects(
            type.check(makeMonitor({ haproxy_agent_url: "ftp://x" }), {}, null),
            /http:\/\/ or https:\/\//
        );
        await assert.rejects(type.check(makeMonitor({ haproxy_proxy: "" }), {}, null), /name is required/);
    });

    test("a malformed answer is rejected", async () => {
        respond = () => ({ status: 200, body: { nope: true } });
        await assert.rejects(new HaproxyMonitorType().check(makeMonitor(), {}, null), /Unexpected answer/);
    });
});
