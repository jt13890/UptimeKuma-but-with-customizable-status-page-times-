const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { log } = require("../src/util");

/**
 * Snapshot replication between SQLite nodes.
 *
 * The active node produces a consistent snapshot of kuma.db (`VACUUM INTO`, taken on a separate connection so the
 * main connection is not blocked, safe while heartbeats are being written). A standby downloads it, verifies it
 * (sha256 + `PRAGMA quick_check`) and only then swaps it in as its own database.
 *
 * The database driver and the "swap the live database file" step are injected, so the logic can be tested without
 * a running server.
 */
class Replicator {
    /**
     * @param {object} options Options
     * @param {string} options.dataDir Data directory
     * @param {Function} options.createSnapshot async (destFile) => void, writes a consistent copy of the live DB
     * @param {Function} options.quickCheck async (file) => boolean, true if the file is an intact database
     * @param {Function} options.applyFile async (file) => void, replaces the live DB with this file
     * @param {Function} options.getEpoch () => number, epoch stamped into snapshots
     * @param {number} options.snapshotIntervalSec Cache lifetime of a snapshot on the active node
     * @param {Function} options.fetch fetch implementation
     */
    constructor(options) {
        this.dataDir = options.dataDir;
        this.workDir = path.join(this.dataDir, "ha");
        this.createSnapshotFn = options.createSnapshot;
        this.quickCheckFn = options.quickCheck;
        this.applyFileFn = options.applyFile;
        this.getEpoch = options.getEpoch || (() => 0);
        this.snapshotIntervalSec = options.snapshotIntervalSec ?? 60;
        this.fetch = options.fetch || globalThis.fetch;

        this.cache = null;
        this.inFlight = null;
        fs.mkdirSync(this.workDir, { recursive: true });
        this.cleanupWorkDir();
    }

    /**
     * Remove leftovers of an interrupted run
     * @returns {void}
     */
    cleanupWorkDir() {
        for (const name of fs.readdirSync(this.workDir)) {
            if (name.startsWith("snapshot-") || name.startsWith("incoming-")) {
                fs.rmSync(path.join(this.workDir, name), { force: true });
            }
        }
    }

    /**
     * Active node: get a snapshot (cached for snapshotIntervalSec, concurrent calls share one run).
     * @param {object} options Options
     * @param {boolean} options.fresh Ignore the cache (used for the final snapshot of a handover)
     * @returns {Promise<{id: string, file: string, sha256: string, size: number, createdAt: number, epoch: number}>} Snapshot
     */
    async getSnapshot({ fresh = false } = {}) {
        const maxAgeMs = fresh ? 0 : this.snapshotIntervalSec * 1000;
        if (this.cache && Date.now() - this.cache.createdAt < maxAgeMs) {
            return this.cache;
        }
        if (this.inFlight) {
            // A fresh one was asked for while an older run is in flight: wait for it, then run again
            if (!fresh) {
                return this.inFlight;
            }
            await this.inFlight.catch(() => {});
        }

        this.inFlight = this.createSnapshotFile().finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    /**
     * @returns {Promise<object>} Snapshot description
     */
    async createSnapshotFile() {
        const createdAt = Date.now();
        const epoch = this.getEpoch();
        const id = `${epoch}-${createdAt}`;
        const file = path.join(this.workDir, `snapshot-${id}.db`);

        await this.createSnapshotFn(file);
        const sha256 = await hashFile(file);
        const size = (await fsp.stat(file)).size;

        const previous = this.cache;
        this.cache = { id, file, sha256, size, createdAt, epoch };
        if (previous && previous.file !== file) {
            fs.rmSync(previous.file, { force: true });
        }
        log.debug("ha", `Snapshot ${id} created (${size} bytes)`);
        return this.cache;
    }

    /**
     * @param {object} snapshot Snapshot from getSnapshot()
     * @returns {import("stream").Readable} gzip stream of the snapshot file
     */
    openStream(snapshot) {
        return fs.createReadStream(snapshot.file).pipe(zlib.createGzip({ level: 3 }));
    }

    /**
     * Standby: download the snapshot of the active node, verify it, swap it in.
     * @param {string} peerUrl Base URL of the active node
     * @param {string} secret Shared secret
     * @param {object} options Options
     * @param {string|null} options.have Id of the snapshot that is already applied (skips the download if unchanged)
     * @param {boolean} options.final Ask for the final snapshot of a handover (the peer is no longer active)
     * @param {Function} options.beforeApply async (info) => void, called after verification, before the swap
     * @returns {Promise<{applied: boolean, id: string, epoch: number}>} Result
     */
    async pull(peerUrl, secret, { have = null, final = false, beforeApply = null } = {}) {
        const url = `${peerUrl}/api/ha/snapshot${final ? "?final=1" : ""}`;
        const res = await this.fetch(url, {
            headers: { Authorization: `Bearer ${secret}`, "x-ha-have": have || "" },
            signal: AbortSignal.timeout(120000),
        });

        if (res.status === 304) {
            return { applied: false, id: have, epoch: 0 };
        }
        if (!res.ok) {
            throw new Error(`Peer answered HTTP ${res.status} to the snapshot request`);
        }

        const id = res.headers.get("x-ha-snapshot-id");
        const expectedHash = res.headers.get("x-ha-sha256");
        const epoch = parseInt(res.headers.get("x-ha-epoch") || "0");
        if (!id || !expectedHash) {
            throw new Error("Peer sent a snapshot without id/checksum");
        }

        const incoming = path.join(this.workDir, `incoming-${id}.db`);
        try {
            await pipeline(Readable.fromWeb(res.body), zlib.createGunzip(), fs.createWriteStream(incoming));

            const actual = await hashFile(incoming);
            if (actual !== expectedHash) {
                throw new Error("Snapshot checksum mismatch, discarded");
            }
            if (!(await this.quickCheckFn(incoming))) {
                throw new Error("Snapshot failed the integrity check, discarded");
            }
            if (beforeApply) {
                await beforeApply({ id, epoch });
            }
            await this.applyFileFn(incoming);
        } catch (e) {
            fs.rmSync(incoming, { force: true });
            throw e;
        }
        return { applied: true, id, epoch };
    }

    /**
     * Delete old pre-sync backups of the database, keep the newest `keep`
     * @param {string} backupDir Directory
     * @param {number} keep How many to keep
     * @returns {void}
     */
    static pruneBackups(backupDir, keep) {
        if (!fs.existsSync(backupDir)) {
            return;
        }
        const files = fs
            .readdirSync(backupDir)
            .filter((name) => name.startsWith("kuma-") && name.endsWith(".db"))
            .sort();
        for (const name of files.slice(0, Math.max(0, files.length - keep))) {
            fs.rmSync(path.join(backupDir, name), { force: true });
        }
    }
}

/**
 * @param {string} file File
 * @returns {Promise<string>} sha256 hex
 */
function hashFile(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        fs.createReadStream(file)
            .on("data", (chunk) => hash.update(chunk))
            .on("end", () => resolve(hash.digest("hex")))
            .on("error", reject);
    });
}

/**
 * Production driver functions based on @louislam/sqlite3 (the driver Uptime Kuma already uses).
 * @param {string} livePath Path of the live kuma.db
 * @returns {{createSnapshot: Function, quickCheck: Function}} Functions for the Replicator
 */
function sqliteOps(livePath) {
    const sqlite3 = require("@louislam/sqlite3");

    const open = (file, mode) =>
        new Promise((resolve, reject) => {
            const db = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(db)));
        });
    const run = (db, sql) => new Promise((resolve, reject) => db.run(sql, (err) => (err ? reject(err) : resolve())));
    const all = (db, sql) =>
        new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
    const close = (db) => new Promise((resolve) => db.close(() => resolve()));

    return {
        async createSnapshot(dest) {
            fs.rmSync(dest, { force: true });
            // Own connection: the application's single connection is not blocked while this runs
            const db = await open(livePath, sqlite3.OPEN_READONLY);
            try {
                await run(db, "PRAGMA busy_timeout = 30000");
                await run(db, `VACUUM INTO '${dest.replace(/'/g, "''")}'`);
            } finally {
                await close(db);
            }
        },

        async quickCheck(file) {
            const db = await open(file, sqlite3.OPEN_READONLY);
            try {
                const rows = await all(db, "PRAGMA quick_check");
                const tables = await all(
                    db,
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('monitor', 'setting', 'user')"
                );
                return rows.length === 1 && rows[0].quick_check === "ok" && tables.length === 3;
            } finally {
                await close(db);
            }
        },
    };
}

module.exports = { Replicator, sqliteOps, hashFile };
