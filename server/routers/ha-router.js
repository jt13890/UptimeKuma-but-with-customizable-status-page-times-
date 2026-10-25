const express = require("express");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { dispatchPeerRequest } = require("../ha-peer");

const router = express.Router();
const server = UptimeKumaServer.getInstance();

// Node-to-node API, see dispatchPeerRequest() in ha-peer.js. /api/ha/health (load balancers) is in api-router.js
router.all(/^\/api\/ha\/(status|snapshot|observe|handover|leader-gone|config)$/, async (req, res) => {
    const ha = server.ha;
    const result = await dispatchPeerRequest(ha, {
        method: req.method,
        name: req.params[0],
        query: req.query,
        authorization: req.headers.authorization,
        have: req.headers["x-ha-have"],
        body: req.body,
    });

    if (result.snapshot) {
        const snapshot = result.snapshot;
        res.set({
            "Content-Type": "application/gzip",
            "x-ha-snapshot-id": snapshot.id,
            "x-ha-sha256": snapshot.sha256,
            "x-ha-epoch": String(snapshot.epoch),
        });
        ha.replicator
            .openStream(snapshot)
            .on("error", () => res.destroy())
            .pipe(res);
        return;
    }
    if (result.json) {
        res.status(result.status).json(result.json);
    } else {
        res.status(result.status).end();
    }
});

/**
 * Only the active node exposes the dashboard. On a standby, browser navigations to dashboard pages get a short
 * explanation instead (public status pages, badges, assets and the API keep working on both nodes).
 * @param {express.Request} req Request
 * @param {express.Response} res Response
 * @param {Function} next Next
 * @returns {void}
 */
function standbyGuard(req, res, next) {
    const ha = server.ha;
    if (!ha?.peerMode || ha.isLeader() || req.method !== "GET") {
        return next();
    }
    const p = req.path;
    const passThrough = /^\/(status|api|upload|metrics|assets|_e2e)(\/|$)/.test(p) || p.includes(".");
    if (passThrough || !(req.headers.accept || "").includes("text/html")) {
        return next();
    }

    const active = ha.activePeers()[0];
    const link = active?.url ? `<p><a href="${escapeHtml(active.url)}">${escapeHtml(active.url)}</a></p>` : "";
    res.status(503)
        .set("Retry-After", "10")
        .send(
            `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
                `<title>Standby</title></head><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
                `<h2>This node is on standby</h2><p>Another node is currently running Uptime Kuma. ` +
                `The dashboard is only available there. Public status pages are still served from this node.</p>${link}</body></html>`
        );
}

/**
 * @param {string} text Text
 * @returns {string} HTML-escaped text
 */
function escapeHtml(text) {
    return String(text).replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
}

module.exports = router;
module.exports.standbyGuard = standbyGuard;
