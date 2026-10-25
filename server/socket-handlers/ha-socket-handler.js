const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const haConfig = require("../ha-config");
const Database = require("../database");
const { UptimeKumaServer } = require("../uptime-kuma-server");

/**
 * Handlers of Settings -> High Availability (SQLite peer HA, see HA-SQLITE.md).
 * Only reachable on the active node: standby nodes refuse dashboard connections.
 * @param {Socket} socket Socket.io instance
 * @returns {void}
 */
module.exports.haSocketHandler = (socket) => {
    const server = UptimeKumaServer.getInstance();

    /**
     * @returns {object} Stored config, or the defaults when HA was never configured on this node
     */
    const currentConfig = () => haConfig.load(Database.dataDir) || haConfig.normalize({});

    socket.on("getHAStatus", async (callback) => {
        try {
            checkLogin(socket);
            const ha = server.ha;
            callback({
                ok: true,
                running: !!ha?.peerMode,
                dbType: Database.dbConfig.type,
                detail: ha?.peerMode ? ha.getDetail() : null,
            });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("getHAConfig", async (callback) => {
        try {
            checkLogin(socket);
            callback({
                ok: true,
                config: haConfig.forUI(currentConfig()),
                configured: !!haConfig.load(Database.dataDir),
                dbType: Database.dbConfig.type,
                running: !!server.ha?.peerMode,
            });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("saveHAConfig", async (input, callback) => {
        try {
            checkLogin(socket);
            if (Database.dbConfig.type !== "sqlite") {
                throw new Error(
                    "This page is for SQLite installs. With MariaDB use the database based HA (see HA.md)."
                );
            }

            const previous = haConfig.load(Database.dataDir);
            const base = previous || haConfig.normalize({});
            const next = { ...base, ...input };

            // The secret is never sent to the browser: empty means "keep the current one", "generate" creates a new one
            const typed = typeof input.secret === "string" ? input.secret.trim() : "";
            if (input.generateSecret) {
                next.secret = haConfig.generateSecret();
            } else if (typed) {
                next.secret = typed;
            } else {
                next.secret = base.secret || haConfig.generateSecret();
            }
            delete next.generateSecret;
            delete next.hasSecret;

            // The first node already has the real data. A joining node (created from a join token) is never bootstrap.
            next.bootstrap = previous ? previous.bootstrap : true;
            next.nodeName = next.nodeName || process.env.UPTIME_KUMA_HA_NODE_NAME || "";

            const stored = haConfig.save(Database.dataDir, next);

            const ha = server.ha;
            const live = !!ha?.peerMode;
            if (live) {
                ha.applyConfig(stored);
            }

            // Shared tunables and the main/secondary role are kept in sync with the other node
            const push = [];
            if (live && stored.enabled) {
                const shared = {};
                for (const key of haConfig.SHARED_KEYS) {
                    shared[key] = stored[key];
                }
                for (const url of stored.peers) {
                    try {
                        await ha.peerRequest(
                            url,
                            "POST",
                            "/api/ha/config",
                            { shared, preferred: !stored.preferred },
                            5000
                        );
                        push.push({ url, ok: true });
                    } catch (e) {
                        push.push({ url, ok: false, msg: e.message });
                    }
                }
            }

            const restartRequired =
                stored.enabled !== !!previous?.enabled ||
                (stored.enabled && !live) ||
                (live &&
                    (stored.nodeName !== previous?.nodeName ||
                        stored.renewIntervalSec !== previous?.renewIntervalSec ||
                        stored.secret !== previous?.secret ||
                        JSON.stringify(stored.peers) !== JSON.stringify(previous?.peers)));

            log.info("ha", `HA settings saved (enabled: ${stored.enabled}, restart required: ${restartRequired})`);
            callback({ ok: true, msg: "Saved.", config: haConfig.forUI(stored), restartRequired, push });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("generateHAJoinToken", async (callback) => {
        try {
            checkLogin(socket);
            const config = haConfig.load(Database.dataDir);
            if (!config?.enabled) {
                throw new Error("Save the settings with High Availability enabled first");
            }
            callback({ ok: true, token: haConfig.makeJoinToken(config) });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });
};
