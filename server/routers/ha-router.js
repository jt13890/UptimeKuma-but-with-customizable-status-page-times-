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

module.exports = router;
