const { R } = require("redbean-node");
const { log, UP, DEGRADED } = require("../../src/util");
const Database = require("../database");

/**
 * Degraded heartbeats only count against the last 24 hours, after that they are stored as UP.
 * They are not important anymore either, so they don't show up in the event list.
 * @param {number|null} fromHoursAgo Only look at heartbeats newer than this many hours, null to look at all of them
 * @returns {Promise<void>}
 */
const settle = async (fromHoursAgo) => {
    try {
        const sqlHourOffset = Database.sqlHourOffset();
        const monitors = await R.getAll("SELECT id FROM monitor");

        for (const monitor of monitors) {
            let sql = `UPDATE heartbeat SET status = ?, important = 0
                WHERE monitor_id = ? AND status = ? AND time < ${sqlHourOffset}`;
            const params = [UP, monitor.id, DEGRADED, -24];

            if (fromHoursAgo != null) {
                // Keeps the query on the (monitor_id, time) index
                sql += ` AND time >= ${sqlHourOffset}`;
                params.push(-fromHoursAgo);
            }

            await R.exec(sql, params);
        }
    } catch (e) {
        log.error("settleDegraded", `Failed to settle degraded heartbeats: ${e.message}`);
    }
};

/**
 * Settle the degraded heartbeats that became older than 24 hours recently (hourly job).
 * The window is wider than the job interval, so a restart or a late run doesn't skip any.
 * @returns {Promise<void>}
 */
const settleRecentDegraded = async () => {
    await settle(72);
};

/**
 * Settle all the degraded heartbeats older than 24 hours, for ones the hourly job missed
 * (e.g. the server was stopped for a few days). Part of the daily clean up.
 * @returns {Promise<void>}
 */
const settleAllDegraded = async () => {
    await settle(null);
};

module.exports = {
    settleRecentDegraded,
    settleAllDegraded,
};
