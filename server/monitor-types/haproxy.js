const axios = require("axios");
const https = require("https");
const dayjs = require("dayjs");
const { MonitorType } = require("./monitor-type");
const { UP, DEGRADED, MAINTENANCE } = require("../../src/util");

/**
 * Turn the status column of HAProxy's "show stat" into one of our categories.
 * HAProxy values: UP, DOWN, NOLB, MAINT, DRAIN, NO CHECK, OPEN, STOP, and transitional ones
 * like "UP 1/3" (still up, a check is failing) or "DOWN 1/2" (down, coming up) or "MAINT (via be/srv)".
 * @param {string} status Raw HAProxy status
 * @returns {"up"|"degraded"|"maint"|"down"} Category
 */
function classifyStatus(status) {
    const value = String(status ?? "").toUpperCase();
    if (value.startsWith("UP") || value.startsWith("OPEN") || value.startsWith("NO CHECK")) {
        return "up";
    }
    if (value.startsWith("DRAIN") || value.startsWith("NOLB")) {
        return "degraded";
    }
    if (value.startsWith("MAINT")) {
        return "maint";
    }
    return "down";
}

/**
 * Decide the state of a monitor from the rows of "show stat".
 * Down results are thrown, so the normal retry and notification handling applies.
 * @param {object[]} stats Rows of "show stat" (objects with pxname, svname, status, ...)
 * @param {object} options What to look at
 * @param {string} options.proxy Frontend / backend (proxy) name
 * @param {string} options.server Server name, if empty the whole proxy is checked
 * @param {number} options.minUpServers Minimum number of servers that must be up, 1 if not set
 * @returns {{status: number, msg: string}} Heartbeat status (UP, DEGRADED or MAINTENANCE) and message
 * @throws {Error} If the target is down or does not exist
 */
function evaluateHaproxyStats(stats, { proxy, server, minUpServers = 1 }) {
    const rows = (Array.isArray(stats) ? stats : []).filter((row) => row.pxname === proxy);

    if (rows.length === 0) {
        throw new Error(`Proxy "${proxy}" was not found on the HAProxy node`);
    }

    // A single server
    if (server) {
        const row = rows.find((r) => r.svname === server);
        if (!row) {
            throw new Error(`Server "${server}" was not found in "${proxy}"`);
        }
        const category = classifyStatus(row.status);
        const label = `${proxy}/${server}: ${row.status}`;

        if (category === "up") {
            return { status: UP, msg: label };
        } else if (category === "degraded") {
            return { status: DEGRADED, msg: label };
        } else if (category === "maint") {
            return { status: MAINTENANCE, msg: label };
        }
        throw new Error(row.check_status ? `${label} (check: ${row.check_status})` : label);
    }

    // A whole proxy: a "listen" section has both rows, the backend row is the one that matters
    const aggregate = rows.find((r) => r.svname === "BACKEND") || rows.find((r) => r.svname === "FRONTEND");
    const servers = rows.filter((r) => r.svname !== "BACKEND" && r.svname !== "FRONTEND");

    if (aggregate?.svname === "FRONTEND" && servers.length === 0) {
        if (classifyStatus(aggregate.status) !== "up") {
            throw new Error(`Frontend "${proxy}" is ${aggregate.status}`);
        }
        return { status: UP, msg: `Frontend ${proxy}: ${aggregate.status}` };
    }

    if (aggregate && classifyStatus(aggregate.status) === "down") {
        throw new Error(`Backend "${proxy}" is ${aggregate.status}, no server is available`);
    }

    const upServers = servers.filter((r) => classifyStatus(r.status) === "up");
    const notUp = servers.filter((r) => classifyStatus(r.status) !== "up");
    const summary = `${proxy}: ${upServers.length}/${servers.length} servers up`;
    const detail = notUp.map((r) => `${r.svname} ${r.status}`).join(", ");

    if (upServers.length < Math.max(1, minUpServers)) {
        throw new Error(`${summary}, minimum is ${Math.max(1, minUpServers)}${detail ? ` (${detail})` : ""}`);
    }

    if (notUp.length > 0) {
        return { status: DEGRADED, msg: `${summary} (${detail})` };
    }

    return { status: UP, msg: summary };
}

/**
 * HAProxy monitor type.
 * Pulls frontend / backend / server state from the HAProxy agent (extra/haproxy-agent).
 */
class HaproxyMonitorType extends MonitorType {
    name = "haproxy";

    // A backend can be degraded (some servers down) and a server can be in maintenance
    allowCustomStatus = true;

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        if (!monitor.haproxy_agent_url) {
            throw new Error("HAProxy agent URL is required");
        }
        if (!monitor.haproxy_proxy) {
            throw new Error("Frontend / backend name is required");
        }

        let baseURL;
        try {
            baseURL = new URL(monitor.haproxy_agent_url);
        } catch (_) {
            throw new Error("HAProxy agent URL is invalid");
        }
        if (baseURL.protocol !== "http:" && baseURL.protocol !== "https:") {
            throw new Error("HAProxy agent URL must start with http:// or https://");
        }

        // The timeout is in seconds. Values that are not plausible (runtime patched default) fall back to 10s.
        const timeoutSeconds = monitor.timeout > 0 && monitor.timeout <= 3600 ? monitor.timeout : 10;
        const headers = { Accept: "application/json" };
        if (monitor.haproxy_agent_token) {
            headers.Authorization = `Bearer ${monitor.haproxy_agent_token}`;
        }

        const url = `${baseURL.origin}${baseURL.pathname.replace(/\/+$/, "")}/v1/stats`;
        const startTime = dayjs().valueOf();
        let data;

        try {
            const res = await axios.get(url, {
                params: { proxy: monitor.haproxy_proxy },
                headers,
                timeout: timeoutSeconds * 1000,
                maxContentLength: 32 * 1024 * 1024,
                maxRedirects: 0,
                httpsAgent: new https.Agent({ rejectUnauthorized: !monitor.getIgnoreTls() }),
            });
            data = res.data;
        } catch (error) {
            if (error.response) {
                if (error.response.status === 401) {
                    throw new Error("HAProxy agent rejected the token");
                }
                const reason = error.response.data?.error;
                throw new Error(`HAProxy agent returned ${error.response.status}${reason ? `: ${reason}` : ""}`);
            }
            throw new Error(`Cannot reach the HAProxy agent: ${error.message}`);
        }

        heartbeat.ping = dayjs().valueOf() - startTime;

        if (!data || !Array.isArray(data.stats)) {
            throw new Error("Unexpected answer from the HAProxy agent");
        }

        const result = evaluateHaproxyStats(data.stats, {
            proxy: monitor.haproxy_proxy,
            server: monitor.haproxy_server,
            minUpServers: monitor.haproxy_min_up_servers,
        });

        heartbeat.status = result.status;
        heartbeat.msg = result.msg;
    }
}

module.exports = {
    HaproxyMonitorType,
    evaluateHaproxyStats,
    classifyStatus,
};
