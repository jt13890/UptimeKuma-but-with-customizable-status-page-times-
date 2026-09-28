/*
 * Check that an existing Uptime Kuma data folder can be used by this version.
 * Used by install.sh --import-data, run from the installed app folder.
 *
 * Usage: node extra/native/check-data-dir.js <data folder>
 * Exits with 1 and an explanation if the data can't be used.
 */
const fs = require("fs");
const path = require("path");

const dataDir = process.argv[2];
const migrationsDir = path.join(__dirname, "../../db/knex_migrations");

/**
 * Print an error and exit
 * @param {string} msg Error message
 * @returns {never} Never returns, exits the process
 */
function fail(msg) {
    console.error("error: " + msg);
    process.exit(1);
}

if (!dataDir || !fs.existsSync(dataDir)) {
    fail(`data folder not found: ${dataDir}`);
}

let dbType = "sqlite";
const dbConfigPath = path.join(dataDir, "db-config.json");
if (fs.existsSync(dbConfigPath)) {
    try {
        dbType = JSON.parse(fs.readFileSync(dbConfigPath, "utf-8")).type || "sqlite";
    } catch (e) {
        fail(`can't read ${dbConfigPath}: ${e.message}`);
    }
}

if (dbType === "embedded-mariadb") {
    fail("this data uses the embedded MariaDB of the Docker image, which only exists in Docker. " +
        "Export a backup or switch that install to SQLite or an external MariaDB first.");
}

if (dbType === "mariadb") {
    console.log("Uses an external MariaDB server, it will be used as is (make sure it is reachable from this device).");
    process.exit(0);
}

const dbPath = path.join(dataDir, "kuma.db");
if (!fs.existsSync(dbPath)) {
    fail(`${dataDir} doesn't look like an Uptime Kuma data folder (no kuma.db)`);
}

const sqlite3 = require("@louislam/sqlite3");
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        fail(`can't open ${dbPath}: ${err.message}`);
    }
});

db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knex_migrations'", (err, tables) => {
    if (err) {
        fail(`can't read ${dbPath}: ${err.message}`);
    }

    // Databases from 1.x have no knex migrations yet, they are upgraded on first start
    if (tables.length === 0) {
        console.log("Data from Uptime Kuma 1.x, it will be upgraded on first start (this can take a while for big databases).");
        db.close();
        return;
    }

    db.all("SELECT name FROM knex_migrations", (err, rows) => {
        if (err) {
            fail(`can't read ${dbPath}: ${err.message}`);
        }
        db.close();

        const known = new Set(fs.readdirSync(migrationsDir));
        const unknown = rows.map(row => row.name).filter(name => !known.has(name));

        if (unknown.length > 0) {
            fail("this data comes from a newer Uptime Kuma than this version, which doesn't know these database changes:\n  " +
                unknown.join("\n  ") +
                "\nUpdate this version first (merge the newer upstream release into it).");
        }

        console.log("Data is compatible.");
    });
});
