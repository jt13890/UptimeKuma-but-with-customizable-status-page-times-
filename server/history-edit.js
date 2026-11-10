/**
 * History editor: set a time range in the past of a monitor to UP or DOWN.
 *
 * Every stat bucket (stat_minutely / stat_hourly / stat_daily) is derived one-to-one from heartbeats,
 * so an edit moves one count per heartbeat from its old category to the new one, in the bucket of its
 * minute, hour and day. Slots of the range without a heartbeat (monitor was paused, server was off) get a
 * new heartbeat, so the change is visible in the heartbeat bar too.
 *
 * Only ranges inside the heartbeat retention are allowed: older time only exists as aggregated stats.
 */

const dayjs = require("dayjs");
const { R } = require("redbean-node");
const { UP, DOWN, PENDING, MAINTENANCE, DEGRADED } = require("../src/util");

const MAX_RANGE_DAYS = 90;
const MAX_INSERTS = 5000;
const DEFAULT_KEEP_DAYS = 180;

// How long each stat table keeps its rows, in seconds (see UptimeCalculator)
const TABLES = {
    minutely: { table: "stat_minutely", bucketSeconds: 60, keepSeconds: 24 * 60 * 60 },
    hourly: { table: "stat_hourly", bucketSeconds: 3600, keepSeconds: 30 * 24 * 60 * 60 },
    daily: { table: "stat_daily", bucketSeconds: 86400, keepSeconds: 365 * 24 * 60 * 60 },
};

/**
 * Check the request of the client
 * @param {object} request The request
 * @param {number} request.from Start of the range, ms since epoch (included)
 * @param {number} request.to End of the range, ms since epoch (excluded)
 * @param {string} request.status "up" or "down"
 * @param {number} now Current time in ms
 * @param {number} keepDays Heartbeat retention in days
 * @returns {{from: number, to: number, status: number}} Checked values, status as UP / DOWN constant
 * @throws {Error} If the request is not allowed
 */
function validateEdit({ from, to, status }, now = Date.now(), keepDays = DEFAULT_KEEP_DAYS) {
    from = Number(from);
    to = Number(to);

    if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new Error("Start and end time are required");
    }
    if (status !== "up" && status !== "down") {
        throw new Error("Status must be up or down");
    }
    if (from >= to) {
        throw new Error("The end must be after the start");
    }
    if (to > now) {
        throw new Error("Only time in the past can be changed");
    }
    if (from < now - keepDays * 86400000) {
        throw new Error(`Only the last ${keepDays} days can be changed (the heartbeat retention period)`);
    }
    if (to - from > MAX_RANGE_DAYS * 86400000) {
        throw new Error(`The range is too long, change at most ${MAX_RANGE_DAYS} days at once`);
    }

    return { from, to, status: status === "up" ? UP : DOWN };
}

/**
 * How a heartbeat with this status is counted in a stat table (same rules as UptimeCalculator.update)
 * @param {number} status Heartbeat status
 * @param {"minutely"|"hourly"|"daily"} table Stat table
 * @returns {{up: number, down: number, maintenance: number, degraded: number}} Counts
 */
function categoriesOf(status, table) {
    const counts = { up: 0, down: 0, maintenance: 0, degraded: 0 };
    if (status === MAINTENANCE) {
        counts.maintenance = 1;
    } else if (status === DEGRADED) {
        // Degraded only counts as down in the minutely data, it counts as up in the hourly and daily data
        if (table === "minutely") {
            counts.down = 1;
            counts.degraded = 1;
        } else {
            counts.up = 1;
        }
    } else if (status === UP) {
        counts.up = 1;
    } else if (status === DOWN || status === PENDING) {
        counts.down = 1;
    }
    return counts;
}

/**
 * Start of the stat bucket (unix seconds, UTC) a time belongs to
 * @param {"minutely"|"hourly"|"daily"} table Stat table
 * @param {number} ms Time in ms
 * @returns {number} Bucket key
 */
function bucketKey(table, ms) {
    const seconds = Math.floor(ms / 1000);
    return seconds - (seconds % TABLES[table].bucketSeconds);
}

/**
 * Work out what has to change. Pure function, nothing is written.
 * @param {object} options Options
 * @param {Array<{id: number, time: number, status: number}>} options.beats Existing heartbeats in the range
 * @param {number} options.from Start of the range, ms (included)
 * @param {number} options.to End of the range, ms (excluded)
 * @param {number} options.status New status, UP or DOWN
 * @param {number} options.intervalSeconds Interval of the monitor
 * @param {number} options.now Current time in ms
 * @returns {object} Plan: updates, inserts, deltas per table and a summary
 * @throws {Error} If too many heartbeats would be created
 */
function planHistoryEdit({ beats, from, to, status, intervalSeconds, now = Date.now() }) {
    const step = Math.max(20, intervalSeconds || 60) * 1000;
    const sorted = [...beats].sort((a, b) => a.time - b.time);

    const deltas = { minutely: new Map(), hourly: new Map(), daily: new Map() };
    const addDelta = (table, time, counts, sign, create) => {
        const key = bucketKey(table, time);
        let delta = deltas[table].get(key);
        if (!delta) {
            delta = { up: 0, down: 0, maintenance: 0, degraded: 0, create: false };
            deltas[table].set(key, delta);
        }
        for (const name of ["up", "down", "maintenance", "degraded"]) {
            delta[name] += sign * counts[name];
        }
        // A missing row is only created for new heartbeats, and only while the table would still keep it
        if (create && time >= now - TABLES[table].keepSeconds * 1000) {
            delta.create = true;
        }
    };

    const updates = [];
    let unchanged = 0;
    for (const beat of sorted) {
        if (beat.status === status) {
            unchanged++;
            continue;
        }
        updates.push({ id: beat.id, oldStatus: beat.status });
        for (const table of Object.keys(TABLES)) {
            addDelta(table, beat.time, categoriesOf(beat.status, table), -1, false);
            addDelta(table, beat.time, categoriesOf(status, table), 1, false);
        }
    }

    // Slots without a heartbeat
    const inserts = [];
    let pointer = 0;
    for (let slotStart = from; slotStart < to; slotStart += step) {
        const slotEnd = Math.min(slotStart + step, to);
        while (pointer < sorted.length && sorted[pointer].time < slotStart) {
            pointer++;
        }
        const covered = pointer < sorted.length && sorted[pointer].time < slotEnd;
        if (!covered) {
            inserts.push({ time: slotStart });
            if (inserts.length > MAX_INSERTS) {
                throw new Error("The range has too many gaps to fill, change a shorter range");
            }
        }
    }
    for (const insert of inserts) {
        for (const table of Object.keys(TABLES)) {
            addDelta(table, insert.time, categoriesOf(status, table), 1, true);
        }
    }

    return {
        updates,
        inserts,
        deltas,
        summary: {
            existing: sorted.length,
            changed: updates.length,
            unchanged,
            inserted: inserts.length,
        },
    };
}

/**
 * Format a time for the heartbeat table (UTC)
 * @param {number} ms Time in ms
 * @returns {string} Date time string
 */
function toDbTime(ms) {
    return R.isoDateTimeMillis(dayjs.utc(ms));
}

/**
 * Load the heartbeats of a range
 * @param {number} monitorID Monitor ID
 * @param {number} from Start in ms (included)
 * @param {number} to End in ms (excluded)
 * @returns {Promise<Array<{id: number, time: number, status: number}>>} Heartbeats
 */
async function loadBeats(monitorID, from, to) {
    const rows = await R.getAll(
        "SELECT id, time, status FROM heartbeat WHERE monitor_id = ? AND time >= ? AND time < ? ORDER BY time",
        [monitorID, toDbTime(from), toDbTime(to)]
    );
    return rows.map((row) => ({ id: row.id, time: dayjs.utc(row.time).valueOf(), status: row.status }));
}

/**
 * Preview an edit: how many heartbeats would change
 * @param {number} monitorID Monitor ID
 * @param {object} request Request of the client, see validateEdit()
 * @param {number} intervalSeconds Interval of the monitor
 * @param {number} keepDays Heartbeat retention in days
 * @returns {Promise<object>} Summary
 */
async function previewHistoryEdit(monitorID, request, intervalSeconds, keepDays) {
    const { from, to, status } = validateEdit(request, Date.now(), keepDays);
    const beats = await loadBeats(monitorID, from, to);
    return planHistoryEdit({ beats, from, to, status, intervalSeconds }).summary;
}

/**
 * Apply an edit
 * @param {number} monitorID Monitor ID
 * @param {object} request Request of the client, see validateEdit()
 * @param {number} intervalSeconds Interval of the monitor
 * @param {number} keepDays Heartbeat retention in days
 * @returns {Promise<object>} Summary
 */
async function applyHistoryEdit(monitorID, request, intervalSeconds, keepDays) {
    // Required here, the model needs the whole server
    const Monitor = require("./model/monitor");
    const now = Date.now();
    const { from, to, status } = validateEdit(request, now, keepDays);
    const label = status === UP ? "UP" : "DOWN";
    const msg = `Manually set to ${label} (history edit)`;

    const beats = await loadBeats(monitorID, from, to);
    const plan = planHistoryEdit({ beats, from, to, status, intervalSeconds, now });
    const step = Math.max(20, intervalSeconds || 60);

    // New stat rows need a ping (the columns are NOT NULL). UP rows get the usual ping of the monitor,
    // so the filled time does not pull the average latency down to 0.
    const averagePings = {};
    const averagePing = async (trx, name, table) => {
        if (!(name in averagePings)) {
            const row = await trx.getRow(
                `SELECT AVG(ping) AS average FROM ${table} WHERE monitor_id = ? AND ping > 0`,
                [monitorID]
            );
            averagePings[name] = row && row.average ? row.average : 0;
        }
        return averagePings[name];
    };

    const trx = await R.begin();
    try {
        // 1. Heartbeats
        for (const update of plan.updates) {
            await trx.exec(
                status === UP
                    ? "UPDATE heartbeat SET status = ?, msg = ? WHERE id = ?"
                    : "UPDATE heartbeat SET status = ?, msg = ?, ping = NULL WHERE id = ?",
                [status, msg, update.id]
            );
        }
        for (const insert of plan.inserts) {
            const bean = trx.dispense("heartbeat");
            bean.monitor_id = monitorID;
            bean.status = status;
            bean.msg = msg;
            bean.time = toDbTime(insert.time);
            bean.ping = null;
            bean.duration = step;
            bean.down_count = 0;
            bean.retries = 0;
            bean.important = false;
            await trx.store(bean);
        }

        // 2. Stat buckets
        for (const [name, { table }] of Object.entries(TABLES)) {
            for (const [key, delta] of plan.deltas[name]) {
                let bean = await trx.findOne(table, " monitor_id = ? AND timestamp = ? ", [monitorID, key]);
                if (!bean) {
                    if (!delta.create) {
                        continue;
                    }
                    bean = trx.dispense(table);
                    bean.monitor_id = monitorID;
                    bean.timestamp = key;
                    bean.up = 0;
                    bean.down = 0;
                    const ping = delta.up > 0 ? await averagePing(trx, name, table) : 0;
                    bean.ping = ping;
                    bean.ping_min = ping;
                    bean.ping_max = ping;
                }

                let extras = {};
                try {
                    extras = bean.extras ? JSON.parse(bean.extras) : {};
                } catch (_) {
                    extras = {};
                }

                bean.up = Math.max(0, (bean.up || 0) + delta.up);
                bean.down = Math.max(0, (bean.down || 0) + delta.down);
                extras.maintenance = Math.max(0, (extras.maintenance || 0) + delta.maintenance);
                extras.degraded = Math.min(Math.max(0, (extras.degraded || 0) + delta.degraded), bean.down);
                for (const field of ["maintenance", "degraded"]) {
                    if (!extras[field]) {
                        delete extras[field];
                    }
                }
                bean.extras = Object.keys(extras).length > 0 ? JSON.stringify(extras) : null;
                await trx.store(bean);
            }
        }

        // 3. "important" marks the beats where the status changed, they may have moved at the edges of the range
        const previous = await trx.getRow(
            "SELECT status FROM heartbeat WHERE monitor_id = ? AND time < ? ORDER BY time DESC LIMIT 1",
            [monitorID, toDbTime(from)]
        );
        const rows = await trx.getAll(
            "SELECT id, status, important FROM heartbeat WHERE monitor_id = ? AND time >= ? ORDER BY time LIMIT ?",
            [monitorID, toDbTime(from), plan.summary.existing + plan.summary.inserted + 1]
        );
        let previousStatus = previous ? previous.status : null;
        let isFirstBeat = !previous;
        for (const row of rows) {
            const important = Monitor.isImportantBeat(isFirstBeat, previousStatus, row.status);
            if (!!row.important !== important) {
                await trx.exec("UPDATE heartbeat SET important = ? WHERE id = ?", [important ? 1 : 0, row.id]);
            }
            isFirstBeat = false;
            previousStatus = row.status;
        }

        await trx.commit();
    } catch (error) {
        await trx.rollback();
        throw error;
    }

    return plan.summary;
}

module.exports = {
    MAX_RANGE_DAYS,
    DEFAULT_KEEP_DAYS,
    validateEdit,
    categoriesOf,
    bucketKey,
    planHistoryEdit,
    previewHistoryEdit,
    applyHistoryEdit,
};
