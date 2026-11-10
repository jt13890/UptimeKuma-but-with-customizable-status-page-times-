/**
 * Authentication of status page viewers, used for login-only groups.
 *
 * A viewer is authenticated if one of these is true:
 * 1. Forward / proxy auth: the status page has a "forward auth header" configured, the request carries that header
 *    with a value, and the request comes straight from a trusted proxy (IP / CIDR list of the status page).
 *    The header is ignored when the list is empty, otherwise anyone could send it.
 * 2. The request carries a valid Uptime Kuma login token: "Authorization: Bearer <JWT>".
 *
 * The global "disable auth" setting is deliberately ignored: it is used behind forward auth proxies,
 * where everybody would count as logged in and login-only groups would be public.
 *
 * Authenticated responses are never cached (see viewerAwareCache).
 */

const net = require("node:net");
const jwt = require("jsonwebtoken");
const { R } = require("redbean-node");
const { UptimeKumaServer } = require("./uptime-kuma-server");
const { shake256, SHAKE256_LENGTH } = require("./util-server");

const HEADER_NAME_REGEX = /^[A-Za-z0-9-]{1,100}$/;

/**
 * Split a list of IPs / CIDRs written by a person
 * @param {string|null|undefined} text Comma, space or newline separated list
 * @returns {string[]} Entries
 */
function splitList(text) {
    return String(text ?? "")
        .split(/[\s,;]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
}

/**
 * Check and normalize the trusted proxy list from the editor
 * @param {string|null|undefined} text List of IPs / CIDRs
 * @returns {string} One entry per line
 * @throws {Error} If an entry is not an IP address or CIDR range
 */
function normalizeTrustedProxies(text) {
    const entries = splitList(text);
    for (const entry of entries) {
        const [address, prefix, extra] = entry.split("/");
        const family = net.isIP(address);
        const maxPrefix = family === 4 ? 32 : 128;
        const prefixValid =
            prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) >= 0 && Number(prefix) <= maxPrefix);

        if (!family || extra !== undefined || !prefixValid) {
            throw new Error(`Invalid trusted proxy "${entry}", use an IP address or a CIDR range like 10.0.0.0/8`);
        }
    }
    return entries.join("\n");
}

/**
 * Check and normalize the forward auth header name
 * @param {string|null|undefined} name Header name
 * @returns {string|null} Name or null if empty
 * @throws {Error} If it is not a valid header name
 */
function normalizeHeaderName(name) {
    const value = String(name ?? "").trim();
    if (value === "") {
        return null;
    }
    if (!HEADER_NAME_REGEX.test(value)) {
        throw new Error("Invalid forward auth header name, use letters, digits and dashes only");
    }
    return value;
}

/**
 * Check the URL of the "log in" link shown on the status page.
 * It is rendered as a link on a public page, so only http(s) URLs and paths of this site are accepted.
 * @param {string|null|undefined} url URL or path
 * @returns {string|null} URL or null if empty
 * @throws {Error} If the URL is not allowed
 */
function normalizeLoginUrl(url) {
    const value = String(url ?? "").trim();
    if (value === "") {
        return null;
    }
    if (value.length > 500) {
        throw new Error("The login URL is too long");
    }
    // A path of this site, but not "//host" (protocol relative) or "/\\host" (some browsers treat it as //)
    if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) {
        return value;
    }
    try {
        const parsed = new URL(value);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            return value;
        }
    } catch (_) {
        // fall through
    }
    throw new Error("The login URL must start with http://, https:// or /");
}

/**
 * Is the address in the list of trusted proxies?
 * @param {string|undefined} remoteAddress Address of the TCP peer
 * @param {string|null|undefined} trustedProxies List of IPs / CIDRs
 * @returns {boolean} True if trusted
 */
function isTrustedProxy(remoteAddress, trustedProxies) {
    if (!remoteAddress) {
        return false;
    }
    const entries = splitList(trustedProxies);
    if (entries.length === 0) {
        return false;
    }

    // IPv4 peers on a dual stack socket look like ::ffff:10.0.0.1
    let address = remoteAddress;
    if (address.toLowerCase().startsWith("::ffff:") && net.isIPv4(address.slice(7))) {
        address = address.slice(7);
    }
    const addressFamily = net.isIP(address);
    if (!addressFamily) {
        return false;
    }

    const list = new net.BlockList();
    for (const entry of entries) {
        const [ip, prefix] = entry.split("/");
        const family = net.isIP(ip);
        if (!family) {
            continue;
        }
        if (prefix === undefined) {
            list.addAddress(ip, family === 4 ? "ipv4" : "ipv6");
        } else {
            list.addSubnet(ip, Number(prefix), family === 4 ? "ipv4" : "ipv6");
        }
    }
    return list.check(address, addressFamily === 4 ? "ipv4" : "ipv6");
}

/**
 * Does the request carry a valid Uptime Kuma login token?
 * Same checks as the socket "loginByToken": valid signature, active user, password not changed since.
 * @param {import("express").Request} request Request
 * @returns {Promise<boolean>} True if a valid token is present
 */
async function hasValidLoginToken(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        return false;
    }

    try {
        const secret = UptimeKumaServer.getInstance().jwtSecret;
        if (!secret) {
            return false;
        }
        const decoded = jwt.verify(header.slice(7).trim(), secret, { algorithms: ["HS256"] });
        const user = await R.findOne("user", " username = ? AND active = 1 ", [decoded.username]);
        return !!user && decoded.h === shake256(user.password, SHAKE256_LENGTH);
    } catch (_) {
        return false;
    }
}

/**
 * Does the request come through a forward auth proxy that reports a logged-in user?
 * @param {import("express").Request} request Request
 * @param {object|null} settings The forward auth settings of the status page
 * @param {string|null} settings.forward_auth_header Header name
 * @param {string|null} settings.forward_auth_trusted_proxies Trusted proxies
 * @returns {boolean} True if authenticated by the proxy
 */
function hasForwardAuth(request, settings) {
    const headerName = settings?.forward_auth_header;
    if (!headerName) {
        return false;
    }

    const value = request.headers[headerName.toLowerCase()];
    if (typeof value !== "string" || value.trim() === "") {
        return false;
    }

    // The TCP peer, not X-Forwarded-For: that one can be set by the client
    return isTrustedProxy(request.socket?.remoteAddress, settings.forward_auth_trusted_proxies);
}

/**
 * Is the viewer of this request authenticated for the status page?
 * @param {import("express").Request} request Request
 * @param {object|null} statusPage Status page bean or row with the forward auth settings
 * @returns {Promise<boolean>} True if authenticated
 */
async function isViewerAuthenticated(request, statusPage) {
    if (hasForwardAuth(request, statusPage)) {
        return true;
    }
    return await hasValidLoginToken(request);
}

/**
 * Load the settings needed to authenticate a viewer of a status page
 * @param {string} slug Slug of the status page
 * @returns {Promise<object|null>} Row or null
 */
async function loadAuthSettings(slug) {
    return await R.getRow(
        "SELECT id, forward_auth_header, forward_auth_trusted_proxies FROM status_page WHERE slug = ? ",
        [String(slug).toLowerCase()]
    );
}

/**
 * Wrap an apicache middleware so that authenticated viewers never read from or write to the cache.
 * Anonymous responses only contain public data, so they are cached as before.
 * It sets request.statusPageAuthenticated for the route handler.
 * @param {Function} cacheMiddleware Result of apicache.middleware(duration)
 * @param {(request: import("express").Request) => string} getSlug Gets the slug of the request, params.slug if not set
 * @returns {Function} Express middleware
 */
function viewerAwareCache(cacheMiddleware, getSlug = (request) => request.params.slug || "default") {
    return async (request, response, next) => {
        let authenticated = false;

        try {
            const settings = await loadAuthSettings(getSlug(request));
            authenticated = !!settings && (await isViewerAuthenticated(request, settings));
        } catch (_) {
            authenticated = false;
        }

        request.statusPageAuthenticated = authenticated;

        // The answer depends on the login token, shared caches must not mix them up
        response.vary("Authorization");

        if (authenticated) {
            response.set("Cache-Control", "private, no-store");
            return next();
        }

        return cacheMiddleware(request, response, next);
    };
}

module.exports = {
    normalizeTrustedProxies,
    normalizeHeaderName,
    normalizeLoginUrl,
    isTrustedProxy,
    hasForwardAuth,
    hasValidLoginToken,
    isViewerAuthenticated,
    viewerAwareCache,
};
