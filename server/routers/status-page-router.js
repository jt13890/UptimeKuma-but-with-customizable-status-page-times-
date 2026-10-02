let express = require("express");
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const StatusPage = require("../model/status_page");
const { allowDevAllOrigin, sendHttpError } = require("../util-server");
const { R } = require("redbean-node");
const { badgeConstants, UP, DOWN, MAINTENANCE, DEGRADED } = require("../../src/util");
const dayjs = require("dayjs");
const { makeBadge } = require("badge-maker");
const { UptimeCalculator } = require("../uptime-calculator");

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();

router.get("/status/:slug", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status/:slug/rss", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageRSSResponse(response, slug, request);
});

router.get("/status", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status-page", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

// Status page config, incident, monitor list
router.get("/api/status-page/:slug", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Status Page Not Found");
            return null;
        }

        let statusPageData = await StatusPage.getStatusPageData(statusPage);

        // Response
        response.json(statusPageData);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status Page Polling Data
// Can fetch only if published
// Optional query: ?maxBeats=N, the number of bars the client can display (used when the status page has a history range set)
router.get("/api/status-page/heartbeat/:slug", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let heartbeatList = {};
        let heartbeatBarList = {};
        let uptimeList = {};

        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageRow = await R.getRow("SELECT id, heartbeat_bar_days FROM status_page WHERE slug = ? ", [slug]);
        let statusPageID = statusPageRow?.id;
        let heartbeatBarDays = StatusPage.normalizeHeartbeatBarDays(statusPageRow?.heartbeat_bar_days);
        let maxBeats = parseMaxBeats(request.query.maxBeats);

        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        for (let monitorID of monitorIDList) {
            // With a history range, the bars come from the aggregated stats,
            // so only the latest heartbeat is needed (for the current status)
            let list = await R.getAll(
                `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT ?
            `,
                [monitorID, heartbeatBarDays > 0 ? 1 : 100]
            );

            list = R.convertToBeans("heartbeat", list);
            heartbeatList[monitorID] = list.reverse().map((row) => row.toPublicJSON());

            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
            uptimeList[`${monitorID}_24`] = uptimeCalculator.get24Hour().uptime;

            if (heartbeatBarDays > 0) {
                heartbeatBarList[monitorID] = getHeartbeatBars(uptimeCalculator, heartbeatBarDays, maxBeats);
                uptimeList[`${monitorID}_${heartbeatBarDays}d`] = getRangeUptime(uptimeCalculator, heartbeatBarDays);
            }
        }

        response.json({
            heartbeatList,
            heartbeatBarList,
            heartbeatBarDays,
            uptimeList,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

/**
 * Parse the maxBeats query parameter
 * @param {any} value Raw query value
 * @returns {number} Number of bars, between 1 and MAX_BARS
 */
function parseMaxBeats(value) {
    const MAX_BARS = 200;
    const parsed = parseInt(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 100;
    }
    return Math.min(parsed, MAX_BARS);
}

/**
 * Build the aggregated heartbeat bars for a status page with a history range
 * Each bar looks like a heartbeat so that HeartbeatBar can render it.
 * @param {UptimeCalculator} uptimeCalculator Uptime calculator of the monitor
 * @param {number} days Number of days to cover
 * @param {number} maxBeats Maximum number of bars
 * @returns {Array<object>} Bars ordered from oldest to newest
 */
function getHeartbeatBars(uptimeCalculator, days, maxBeats) {
    const now = uptimeCalculator.getCurrentDate().unix();
    const format = (timestamp) => dayjs.unix(timestamp).utc().format("YYYY-MM-DD HH:mm:ss");

    return uptimeCalculator.getAggregatedBuckets(days, maxBeats).map((bucket) => {
        const total = bucket.up + bucket.down;

        // Show what the monitor was for most of the bar, so a short blip doesn't color a whole day.
        // On a tie, the worse status wins. No checks at all = no data (null).
        // Degraded checks are counted as down in the bucket, so take them out of the down count.
        const [status, count] = [
            [DOWN, bucket.down - bucket.degraded],
            [DEGRADED, bucket.degraded],
            [MAINTENANCE, bucket.maintenance],
            [UP, bucket.up],
        ].reduce((best, candidate) => (candidate[1] > best[1] ? candidate : best));

        return {
            status: count > 0 ? status : null,
            time: format(bucket.start),
            endTime: format(Math.min(bucket.end, now)),
            uptime: total > 0 ? bucket.up / total : null,
        };
    });
}

/**
 * Get the uptime of a monitor over the last `days` days
 * @param {UptimeCalculator} uptimeCalculator Uptime calculator of the monitor
 * @param {number} days Number of days
 * @returns {number} Uptime between 0 and 1
 */
function getRangeUptime(uptimeCalculator, days) {
    if (days <= 1) {
        return uptimeCalculator.get24Hour().uptime;
    } else if (days <= 30) {
        return uptimeCalculator.getData(days * 24, "hour").uptime;
    }
    return uptimeCalculator.getData(days, "day").uptime;
}

// Status page's manifest.json
router.get("/api/status-page/:slug/manifest.json", cache("1440 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Response
        response.json({
            name: statusPage.title,
            start_url: "/status/" + statusPage.slug,
            display: "standalone",
            icons: [
                {
                    src: statusPage.icon,
                    sizes: "128x128",
                    type: "image/png",
                },
            ],
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/status-page/:slug/incident-history", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        if (!statusPageID) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        const cursor = request.query.cursor || null;
        const result = await StatusPage.getIncidentHistory(statusPageID, cursor, true);
        response.json({
            ok: true,
            ...result,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// overall status-page status badge
router.get("/api/status-page/:slug/badge", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    const statusPageID = await StatusPage.slugToID(slug);
    const {
        label,
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        partialColor = "#F6BE00",
        maintenanceColor = "#808080",
        style = badgeConstants.defaultStyle,
    } = request.query;

    try {
        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        let hasUp = false;
        let hasDown = false;
        let hasMaintenance = false;

        for (let monitorID of monitorIDList) {
            // retrieve the latest heartbeat
            let beat = await R.getAll(
                `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 1
            `,
                [monitorID]
            );

            // to be sure, when corresponding monitor not found
            if (beat.length === 0) {
                continue;
            }
            // handle status of beat
            if (beat[0].status === 3) {
                hasMaintenance = true;
            } else if (beat[0].status === 2) {
                // ignored
            } else if (beat[0].status === 1) {
                hasUp = true;
            } else {
                hasDown = true;
            }
        }

        const badgeValues = { style };

        if (!hasUp && !hasDown && !hasMaintenance) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            if (hasMaintenance) {
                badgeValues.label = label ? label : "";
                badgeValues.color = maintenanceColor;
                badgeValues.message = "Maintenance";
            } else if (hasUp && !hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = upColor;
                badgeValues.message = "Up";
            } else if (hasUp && hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = partialColor;
                badgeValues.message = "Degraded";
            } else {
                badgeValues.label = label ? label : "";
                badgeValues.color = downColor;
                badgeValues.message = "Down";
            }
        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

module.exports = router;
