const { describe, test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const { SystemServiceMonitorType } = require("../../server/monitor-types/system-service");
const { DOWN, UP } = require("../../src/util");
const process = require("process");
const childProcess = require("node:child_process");
const { execSync } = childProcess;

/**
 * Check if the test should be skipped.
 * @returns {boolean} True if the test should be skipped
 */
function shouldSkip() {
    if (process.platform === "win32") {
        return false;
    }
    if (process.platform !== "linux") {
        return true;
    }

    // We currently only support systemd as an init system on linux
    // -> Check if PID 1 is systemd (or init which maps to systemd)
    try {
        const pid1Comm = execSync("ps -p 1 -o comm=", { encoding: "utf-8" }).trim();
        return ![ "systemd", "init" ].includes(pid1Comm);
    } catch (e) {
        return true;
    }
}

describe("SystemServiceMonitorType", { skip: shouldSkip() }, () => {
    let monitorType;
    let heartbeat;
    let originalPlatform;

    beforeEach(() => {
        monitorType = new SystemServiceMonitorType();
        heartbeat = {
            status: DOWN,
            msg: "",
        };
        originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    });

    afterEach(() => {
        if (originalPlatform) {
            Object.defineProperty(process, "platform", originalPlatform);
        }
    });

    test("check() returns UP for a running service", async () => {
        // Windows: 'Dnscache' is always running.
        // Linux: 'dbus' or 'cron' are standard services.
        const serviceName = process.platform === "win32" ? "Dnscache" : "dbus";

        const monitor = {
            system_service_name: serviceName,
        };

        await monitorType.check(monitor, heartbeat);

        assert.strictEqual(heartbeat.status, UP);
        assert.ok(heartbeat.msg.includes("is running"));
    });

    test("check() returns DOWN for a stopped service", async () => {
        const monitor = {
            system_service_name: "non-existent-service-12345",
        };

        // Query a non-existent service to force an error/down state.
        // We pass the promise directly to assert.rejects, avoiding unnecessary async wrappers.
        await assert.rejects(monitorType.check(monitor, heartbeat));

        assert.strictEqual(heartbeat.status, DOWN);
    });

    test("check() fails gracefully with invalid characters", async () => {
        // Mock platform for validation logic test
        Object.defineProperty(process, "platform", {
            value: "linux",
            configurable: true,
        });

        const monitor = {
            system_service_name: "invalid&service;name",
        };

        // Expected validation error
        await assert.rejects(monitorType.check(monitor, heartbeat));

        assert.strictEqual(heartbeat.status, DOWN);
    });

    test("check() throws on unsupported platforms", async () => {
        // This test mocks the platform, so it can run anywhere.
        Object.defineProperty(process, "platform", {
            value: "darwin",
            configurable: true,
        });

        const monitor = {
            system_service_name: "test-service",
        };

        await assert.rejects(monitorType.check(monitor, heartbeat), /not supported/);
    });
});

describe("SystemServiceMonitorType on Linux init systems", () => {
    let monitorType;
    let heartbeat;
    let originalPlatform;
    let calls;

    beforeEach(() => {
        monitorType = new SystemServiceMonitorType();
        heartbeat = {
            status: DOWN,
            msg: "",
        };
        calls = [];
        originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
        Object.defineProperty(process, "platform", {
            value: "linux",
            configurable: true,
        });
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", originalPlatform);
        mock.restoreAll();
    });

    /**
     * Pretend to be running with the given init system, and make the service command exit with the given code
     * @param {string} initSystem "systemd" or "openrc"
     * @param {number} exitCode Exit code of the service command
     * @param {string} stdout Output of the service command
     * @returns {void}
     */
    function mockInitSystem(initSystem, exitCode, stdout) {
        mock.method(SystemServiceMonitorType, "getLinuxInitSystem", () => initSystem);
        mock.method(childProcess, "execFile", (cmd, args, options, callback) => {
            calls.push([ cmd, ...args ]);
            const error = exitCode === 0 ? null : Object.assign(new Error("Command failed"), { code: exitCode });
            callback(error, stdout, "");
        });
    }

    test("OpenRC: started service is UP", async () => {
        mockInitSystem("openrc", 0, " * status: started\n");
        await monitorType.check({ system_service_name: "sshd" }, heartbeat);

        assert.deepStrictEqual(calls, [[ "rc-service", "sshd", "status" ]]);
        assert.strictEqual(heartbeat.status, UP);
        assert.ok(heartbeat.msg.includes("is running"));
    });

    test("OpenRC: stopped or crashed service is DOWN with the rc-service output", async () => {
        mockInitSystem("openrc", 3, " * status: stopped\n");
        await assert.rejects(monitorType.check({ system_service_name: "sshd" }, heartbeat), /status: stopped/);
        assert.strictEqual(heartbeat.status, DOWN);

        mock.restoreAll();
        mockInitSystem("openrc", 32, " * status: crashed\n");
        await assert.rejects(monitorType.check({ system_service_name: "sshd" }, heartbeat), /status: crashed/);
    });

    test("systemd: uses systemctl is-active", async () => {
        mockInitSystem("systemd", 0, "active\n");
        await monitorType.check({ system_service_name: "sshd" }, heartbeat);

        assert.deepStrictEqual(calls, [[ "systemctl", "is-active", "sshd" ]]);
        assert.strictEqual(heartbeat.status, UP);
    });

    test("invalid service names are rejected before running anything", async () => {
        mockInitSystem("openrc", 0, "");
        await assert.rejects(monitorType.check({ system_service_name: "sshd; reboot" }, heartbeat), /Invalid service name/);
        assert.deepStrictEqual(calls, []);
    });
});
