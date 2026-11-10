const { R } = require("redbean-node");
const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const apicache = require("../modules/apicache");
const { Settings } = require("../settings");
const { UptimeCalculator } = require("../uptime-calculator");
const { sendHeartbeatList, sendImportantHeartbeatList } = require("../client");
const { previewHistoryEdit, applyHistoryEdit } = require("../history-edit");

/**
 * Heartbeats are kept for this many days (the range that can be edited)
 * @returns {Promise<number>} Days
 */
async function getKeepDays() {
    const days = Number(await Settings.get("keepDataPeriodDays"));
    // 0 or less: old data is never deleted, the daily stats are the limit then
    return days >= 1 ? days : 365;
}

/**
 * Load a monitor of the user
 * @param {number} monitorID Monitor ID
 * @param {number} userID User ID
 * @returns {Promise<object>} Monitor row
 * @throws {Error} If the monitor does not exist or belongs to someone else
 */
async function getOwnMonitor(monitorID, userID) {
    const monitor = await R.getRow("SELECT id, name, interval FROM monitor WHERE id = ? AND user_id = ?", [
        monitorID,
        userID,
    ]);
    if (!monitor) {
        throw new Error("Monitor not found");
    }
    return monitor;
}

/**
 * Socket handler to change the history of a monitor
 * @param {Socket} socket Socket.io instance
 * @param {UptimeKumaServer} server Server
 * @returns {void}
 */
module.exports.historyEditSocketHandler = (socket, server) => {
    // How many heartbeats would change?
    socket.on("previewMonitorHistory", async (monitorID, request, callback) => {
        try {
            checkLogin(socket);
            const monitor = await getOwnMonitor(monitorID, socket.userID);
            const summary = await previewHistoryEdit(monitor.id, request, monitor.interval, await getKeepDays());
            callback({ ok: true, summary });
        } catch (error) {
            callback({ ok: false, msg: error.message });
        }
    });

    // Set a range in the past to UP or DOWN
    socket.on("editMonitorHistory", async (monitorID, request, callback) => {
        try {
            checkLogin(socket);
            const monitor = await getOwnMonitor(monitorID, socket.userID);
            const summary = await applyHistoryEdit(monitor.id, request, monitor.interval, await getKeepDays());

            log.info(
                "manage",
                `History edit: monitor ${monitor.id} ${new Date(Number(request.from)).toISOString()} - ${new Date(Number(request.to)).toISOString()} set to ${request.status}, ` +
                    `${summary.changed} changed, ${summary.inserted} added. User ID: ${socket.userID}`
            );

            // Everything that cached the old numbers
            await UptimeCalculator.remove(monitor.id);
            apicache.clear();
            await sendHeartbeatList(socket, monitor.id, true, true);
            await sendImportantHeartbeatList(socket, monitor.id, true, true);
            const Monitor = require("../model/monitor");
            await Monitor.sendStats(server.io, monitor.id, socket.userID);

            callback({ ok: true, summary });
        } catch (error) {
            log.error("manage", `History edit failed: ${error.message}`);
            callback({ ok: false, msg: error.message });
        }
    });
};
