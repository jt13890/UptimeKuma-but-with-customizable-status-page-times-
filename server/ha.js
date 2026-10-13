const os = require("os");
const crypto = require("crypto");
const { R } = require("redbean-node");
const { log, UP } = require("../src/util");
const Database = require("./database");

const EXPIRED = "1970-01-01 00:00:00";

/**
 * Active/passive high availability, based on a lease stored in the (shared) database.
 *
 * - Every node campaigns for the single row in `ha_lease`.
 * - The holder is the active node: it runs monitors, notifications and background jobs.
 * - All other nodes are standby: they serve public status pages and wait.
 * - The active node renews the lease every `renewIntervalSec`. If it has not managed to renew
 *   for `ttlSec - renewIntervalSec` it fences itself (stops everything) BEFORE any standby is
 *   allowed to take over (standby needs the full `ttlSec` to elapse), so two nodes never run
 *   monitors at the same time, even if the active node is partitioned from the database.
 * - Expiry is evaluated with the database clock, so clock skew between nodes does not matter.
 *
 * Disabled by default (UPTIME_KUMA_HA_ENABLED=1 to enable). When disabled this class is inert and
 * `isLeader()` is always true, so single-node behaviour is unchanged.
 */
class HAManager {
    /**
     * @param {object} options Options
     * @param {boolean} options.enabled Enable HA
     * @param {string} options.name Human readable node name (default: hostname)
     * @param {number} options.ttlSec Lease time to live in seconds
     * @param {number} options.renewIntervalSec How often to renew / campaign in seconds
     * @param {Function} options.onPromote Called when this node becomes active
     * @param {Function} options.onDemote Called when this node stops being active
     * @param {Function} options.onStandbySync Called periodically while standby
     * @param {number} options.standbySyncEvery Call onStandbySync every N ticks
     */
    constructor(options = {}) {
        this.enabled =
            options.enabled ?? ["1", "true"].includes(String(process.env.UPTIME_KUMA_HA_ENABLED).toLowerCase());

        const name = options.name || process.env.UPTIME_KUMA_HA_NODE_NAME || os.hostname();
        // The random suffix makes two processes with the same name distinct, so a misconfiguration
        // can never produce two nodes that both believe they own the lease.
        this.nodeId = `${name}:${crypto.randomBytes(3).toString("hex")}`;

        let ttlSec = parseInt(options.ttlSec ?? process.env.UPTIME_KUMA_HA_LEASE_TTL ?? 15);
        let renewSec = parseInt(options.renewIntervalSec ?? process.env.UPTIME_KUMA_HA_RENEW_INTERVAL ?? 5);

        if (!Number.isInteger(ttlSec) || !Number.isInteger(renewSec) || renewSec < 1 || ttlSec < renewSec * 2) {
            log.warn(
                "ha",
                "Invalid lease settings (need integers, ttl >= 2 * renew interval). Using ttl=15s, renew=5s."
            );
            ttlSec = 15;
            renewSec = 5;
        }

        this.ttlSec = ttlSec;
        this.renewIntervalSec = renewSec;
        // Leader stops itself after this long without a confirmed renewal. Always < ttl.
        this.fenceAfterMs = (ttlSec - renewSec) * 1000;

        // Standby nodes also run the checks and report what they see ("up wins" on the active node)
        this.observe =
            options.observe ??
            !["0", "false"].includes(String(process.env.UPTIME_KUMA_HA_OBSERVE ?? "1").toLowerCase());
        // How old a peer's UP observation may be and still count. Default per monitor: 1.5 x interval + 5s.
        const envMaxAge = parseInt(process.env.UPTIME_KUMA_HA_OBSERVATION_MAX_AGE);
        this.observationMaxAgeSec = options.observationMaxAgeSec ?? (envMaxAge > 0 ? envMaxAge : null);

        this.onPromote = options.onPromote || (async () => {});
        this.onDemote = options.onDemote || (async () => {});
        this.onStandbySync = options.onStandbySync || (async () => {});
        this.standbySyncEvery = options.standbySyncEvery ?? 12;

        this.leader = false;
        this.epoch = 0;
        this.lastRenewOk = 0;
        this.tickCount = 0;
        this.timer = null;
        this.watchdog = null;
        this.stopped = true;
        this.transitioning = false;
    }

    /**
     * Is HA turned on?
     * @returns {boolean} True if enabled
     */
    isEnabled() {
        return this.enabled;
    }

    /**
     * True if this node should currently run monitors / jobs and accept dashboard connections.
     * Always true when HA is disabled.
     * @returns {boolean} True if active
     */
    isLeader() {
        if (!this.enabled) {
            return true;
        }
        return this.leader && Date.now() - this.lastRenewOk <= this.fenceAfterMs;
    }

    /**
     * Current role for status/health endpoints
     * @returns {{enabled: boolean, role: string, epoch: number}} Status
     */
    getStatus() {
        return {
            enabled: this.enabled,
            role: !this.enabled ? "standalone" : this.isLeader() ? "active" : "standby",
            epoch: this.epoch,
        };
    }

    /**
     * SQL fragments for the current database dialect (the database clock is the only clock used)
     * @returns {{now: string, future: string}} SQL fragments
     */
    sqlTime() {
        const ttl = Number(this.ttlSec); // validated integer in the constructor
        if (Database.dbConfig.type === "sqlite") {
            return {
                now: "datetime('now')",
                future: `datetime('now', '+${ttl} seconds')`,
                ago: (sec) => `datetime('now', '-${Math.ceil(Number(sec))} seconds')`,
            };
        }
        return {
            now: "UTC_TIMESTAMP()",
            future: `DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${ttl} SECOND)`,
            ago: (sec) => `DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${Math.ceil(Number(sec))} SECOND)`,
        };
    }

    /**
     * Should this node run checks only to report them (standby with observation enabled)?
     * @returns {boolean} True if it should observe
     */
    canObserve() {
        return this.enabled && this.observe && !this.stopped && !this.isLeader();
    }

    /**
     * Store what this node saw for a monitor (one row per monitor and node).
     * @param {number} monitorId Monitor id
     * @param {number} status Heartbeat status (UP, DOWN, PENDING)
     * @param {string} msg Message of the check
     * @param {number|null} ping Response time
     * @returns {Promise<void>}
     */
    async recordObservation(monitorId, status, msg, ping) {
        const { now } = this.sqlTime();
        const values = [
            monitorId,
            this.nodeId,
            status,
            msg ? String(msg).substring(0, 500) : null,
            Number.isFinite(Number(ping)) && ping !== null ? Math.round(Number(ping)) : null,
        ];

        if (Database.dbConfig.type === "sqlite") {
            await R.exec(
                `INSERT INTO ha_observation (monitor_id, node_id, status, msg, ping, observed_at)
                 VALUES (?, ?, ?, ?, ?, ${now})
                 ON CONFLICT (monitor_id, node_id) DO UPDATE SET
                     status = excluded.status, msg = excluded.msg, ping = excluded.ping, observed_at = excluded.observed_at`,
                values
            );
        } else {
            await R.exec(
                `INSERT INTO ha_observation (monitor_id, node_id, status, msg, ping, observed_at)
                 VALUES (?, ?, ?, ?, ?, ${now})
                 ON DUPLICATE KEY UPDATE
                     status = VALUES(status), msg = VALUES(msg), ping = VALUES(ping), observed_at = VALUES(observed_at)`,
                values
            );
        }
    }

    /**
     * "Up wins": did another node recently see this monitor UP?
     * Never throws; if the database cannot be asked the local result stands.
     * @param {object} monitor Monitor bean
     * @returns {Promise<{nodeName: string, ping: number|null}|null>} The peer that saw it UP, if any
     */
    async findPeerUp(monitor) {
        if (!this.enabled || !this.observe) {
            return null;
        }
        try {
            const maxAge = this.observationMaxAgeSec ?? Math.ceil(Number(monitor.interval || 60) * 1.5 + 5);
            const { ago } = this.sqlTime();
            const row = await R.getRow(
                `SELECT node_id, ping FROM ha_observation
                 WHERE monitor_id = ? AND status = ? AND node_id <> ? AND observed_at >= ${ago(maxAge)}
                 ORDER BY observed_at DESC LIMIT 1`,
                [monitor.id, UP, this.nodeId]
            );
            return row ? { nodeName: String(row.node_id).split(":")[0], ping: row.ping } : null;
        } catch (e) {
            log.warn("ha", `Could not read peer observations: ${e.message}`);
            return null;
        }
    }

    /**
     * Remove observations of nodes that are long gone (node ids change on every process start)
     * @returns {Promise<void>}
     */
    async pruneObservations() {
        const { ago } = this.sqlTime();
        await R.exec(`DELETE FROM ha_observation WHERE observed_at < ${ago(86400)}`);
    }

    /**
     * Try to take or renew the lease.
     * @returns {Promise<boolean>} True if this node holds the lease afterwards
     */
    async campaign() {
        const { now, future } = this.sqlTime();

        // NOTE: `epoch` must be assigned before `holder`. MariaDB evaluates SET assignments left to
        // right and would otherwise already see the new holder when evaluating the CASE.
        await R.exec(
            `UPDATE ha_lease
             SET epoch = CASE WHEN holder = ? THEN epoch ELSE epoch + 1 END,
                 holder = ?,
                 expires_at = ${future}
             WHERE id = 1 AND (holder = ? OR holder IS NULL OR expires_at < ${now})`,
            [this.nodeId, this.nodeId, this.nodeId]
        );

        const row = await R.getRow("SELECT holder, epoch FROM ha_lease WHERE id = 1");
        if (!row) {
            // Table exists (migration) but the row was removed: recreate it, next tick will win it.
            await R.knex("ha_lease").insert({ id: 1, holder: null, epoch: 0, expires_at: EXPIRED });
            return false;
        }

        if (row.holder === this.nodeId) {
            this.epoch = row.epoch;
            return true;
        }
        return false;
    }

    /**
     * Give the lease up immediately so a standby can take over without waiting for expiry
     * @returns {Promise<void>}
     */
    async release() {
        try {
            await R.exec("UPDATE ha_lease SET holder = NULL, expires_at = ? WHERE id = 1 AND holder = ?", [
                EXPIRED,
                this.nodeId,
            ]);
        } catch (e) {
            log.warn("ha", "Could not release lease: " + e.message);
        }
    }

    /**
     * Start campaigning
     * @returns {Promise<void>}
     */
    async start() {
        if (!this.enabled || !this.stopped) {
            return;
        }
        this.stopped = false;

        if (Database.dbConfig.type === "sqlite") {
            log.warn(
                "ha",
                "HA is enabled with SQLite. This only works for nodes on the SAME host sharing one data directory. Use MariaDB for real failover."
            );
        }
        log.info(
            "ha",
            `HA enabled. Node: ${this.nodeId}, lease ttl: ${this.ttlSec}s, renew: ${this.renewIntervalSec}s`
        );

        // Independent of the (possibly hung) database call: stop the active node as soon as its lease may be in doubt
        this.watchdog = setInterval(() => {
            if (this.leader && !this.transitioning && Date.now() - this.lastRenewOk > this.fenceAfterMs) {
                this.demote("lease could not be renewed in time").catch((e) => log.error("ha", e));
            }
        }, 250); // fine grained: the fence must fire well before a standby can win (ttl - fence >= renew interval)

        await this.tick();
    }

    /**
     * One campaign round, then schedules the next
     * @returns {Promise<void>}
     */
    async tick() {
        if (this.stopped) {
            return;
        }

        try {
            const held = await this.campaign();

            if (held) {
                this.lastRenewOk = Date.now();
                if (!this.leader) {
                    await this.promote();
                }
                this.leaderTicks = (this.leaderTicks || 0) + 1;
                if (this.leaderTicks % 60 === 0) {
                    this.pruneObservations().catch((e) => log.warn("ha", "Prune failed: " + e.message));
                }
            } else if (this.leader) {
                await this.demote("lease is held by another node");
            } else {
                this.tickCount++;
                if (
                    this.standbySyncEvery > 0 &&
                    (this.tickCount === 1 || this.tickCount % this.standbySyncEvery === 0)
                ) {
                    try {
                        await this.onStandbySync();
                    } catch (e) {
                        log.warn("ha", "Standby sync failed: " + e.message);
                    }
                }
            }
        } catch (e) {
            log.warn("ha", "Lease campaign failed: " + e.message);
            if (this.leader && Date.now() - this.lastRenewOk > this.fenceAfterMs) {
                await this.demote("lease could not be renewed in time");
            }
        }

        if (!this.stopped) {
            this.timer = setTimeout(() => this.tick(), this.renewIntervalSec * 1000);
        }
    }

    /**
     * This node became active
     * @returns {Promise<void>}
     */
    async promote() {
        this.transitioning = true;
        log.info("ha", `Became ACTIVE (epoch ${this.epoch}). Starting monitors and jobs.`);
        try {
            this.leader = true;
            await this.onPromote(this);
        } catch (e) {
            log.error("ha", "Promotion failed, releasing lease: " + e.message);
            this.leader = false;
            try {
                await this.onDemote(this);
            } catch (e2) {
                log.error("ha", e2);
            }
            await this.release();
        } finally {
            this.transitioning = false;
        }
    }

    /**
     * This node is no longer active
     * @param {string} reason Why
     * @returns {Promise<void>}
     */
    async demote(reason) {
        if (!this.leader) {
            return;
        }
        this.transitioning = true;
        this.leader = false;
        log.warn("ha", `Became STANDBY: ${reason}. Stopping monitors and jobs.`);
        try {
            await this.onDemote(this);
        } catch (e) {
            log.error("ha", "Demotion handler failed: " + e.message);
        } finally {
            this.transitioning = false;
        }
    }

    /**
     * Stop campaigning and hand the lease over (graceful shutdown)
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        clearTimeout(this.timer);
        clearInterval(this.watchdog);
        if (this.leader) {
            this.leader = false;
            await this.release();
        }
    }
}

module.exports = { HAManager };
