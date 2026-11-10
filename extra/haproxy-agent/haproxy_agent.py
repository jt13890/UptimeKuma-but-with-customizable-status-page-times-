#!/usr/bin/env python3
"""
Uptime Kuma HAProxy agent

Runs on an HAProxy node, reads the HAProxy runtime API (stats socket) and exposes the
frontend / backend / server state as JSON over HTTP(S), so Uptime Kuma can pull it.

Only the read-only commands "show stat" and "show info" are ever sent to HAProxy. Nothing from an
HTTP request is passed to the socket (the "proxy" filter is applied in Python), so a leaked token
cannot be used to change HAProxy.

Requirements: Python 3.8+, no third party packages.

HAProxy needs a stats socket, for example in the global section:
    stats socket /run/haproxy/admin.sock mode 660 level operator
    (level user is enough, this agent only reads)

Example:
    HAPROXY_AGENT_TOKEN=change-me ./haproxy_agent.py --socket /run/haproxy/admin.sock \
        --listen 100.64.0.10:8404

Endpoints:
    GET /health                 -> {"ok": true}, no token needed, nothing sensitive
    GET /v1/stats[?proxy=NAME]  -> {"agent_version", "timestamp", "info": {...}, "stats": [...]}
                                   Authorization: Bearer <token> is required
"""

import argparse
import csv
import hmac
import json
import logging
import os
import socket
import ssl
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

AGENT_VERSION = "1.0.0"
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
log = logging.getLogger("haproxy-agent")


class HAProxyError(Exception):
    """HAProxy could not be queried"""


def run_command(target, command, timeout):
    """
    Send one command to the HAProxy runtime API and return the raw answer.
    `command` is always one of the fixed strings below, never user input.
    target: path of a unix socket, or "tcp://host:port" / "host:port"
    """
    if command not in ("show stat", "show info"):
        raise HAProxyError("command not allowed")

    try:
        if target.startswith("tcp://") or (":" in target and not target.startswith("/")):
            host, _, port = target.replace("tcp://", "").rpartition(":")
            sock = socket.create_connection((host, int(port)), timeout=timeout)
        else:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            sock.connect(target)
    except (OSError, ValueError) as e:
        raise HAProxyError(f"cannot connect to HAProxy socket: {e}") from e

    try:
        sock.sendall((command + "\n").encode())
        chunks, size = [], 0
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise HAProxyError("response from HAProxy is too large")
            chunks.append(chunk)
    except OSError as e:
        raise HAProxyError(f"error while talking to HAProxy: {e}") from e
    finally:
        sock.close()

    return b"".join(chunks).decode("utf-8", errors="replace")


def parse_stat(raw):
    """Parse the CSV of "show stat" to a list of dicts. Empty fields are left out."""
    lines = [line for line in raw.splitlines() if line.strip()]
    if not lines or not lines[0].startswith("#"):
        raise HAProxyError("unexpected answer to 'show stat'")

    header = [name for name in lines[0].lstrip("# ").split(",")]
    rows = []
    for values in csv.reader(lines[1:]):
        row = {}
        for name, value in zip(header, values):
            if name and value != "":
                row[name] = int(value) if value.lstrip("-").isdigit() else value
        if row.get("pxname"):
            rows.append(row)
    return rows


def parse_info(raw):
    """Parse "show info" (Key: value lines)"""
    info = {}
    for line in raw.splitlines():
        key, sep, value = line.partition(":")
        if sep:
            value = value.strip()
            info[key.strip()] = int(value) if value.isdigit() else value
    return info


def collect(args, proxy=None):
    stats = parse_stat(run_command(args.socket, "show stat", args.timeout))
    if proxy:
        stats = [row for row in stats if row.get("pxname") == proxy]
    try:
        info = parse_info(run_command(args.socket, "show info", args.timeout))
    except HAProxyError:
        info = {}
    return {
        "agent_version": AGENT_VERSION,
        "timestamp": int(time.time()),
        "info": info,
        "stats": stats,
    }


def make_handler(args):
    token = args.token.encode() if args.token else None

    class Handler(BaseHTTPRequestHandler):
        server_version = "UptimeKumaHAProxyAgent/" + AGENT_VERSION

        def log_message(self, fmt, *a):
            log.info("%s - %s", self.address_string(), fmt % a)

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            if token is None:
                return True
            header = self.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return False
            return hmac.compare_digest(header[7:].strip().encode(), token)

        def do_GET(self):
            url = urlparse(self.path)

            if url.path == "/health":
                try:
                    run_command(args.socket, "show info", args.timeout)
                    return self._send(200, {"ok": True})
                except HAProxyError:
                    return self._send(503, {"ok": False})

            if url.path != "/v1/stats":
                return self._send(404, {"error": "not found"})

            if not self._authorized():
                return self._send(401, {"error": "unauthorized"})

            proxy = parse_qs(url.query).get("proxy", [None])[0]
            try:
                return self._send(200, collect(args, proxy))
            except HAProxyError as e:
                log.error("%s", e)
                return self._send(502, {"error": str(e)})

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Uptime Kuma HAProxy agent")
    parser.add_argument("--socket", default=os.environ.get("HAPROXY_SOCKET", "/run/haproxy/admin.sock"),
                        help="HAProxy stats socket: unix socket path or tcp://host:port (env HAPROXY_SOCKET)")
    parser.add_argument("--listen", default=os.environ.get("HAPROXY_AGENT_LISTEN", "127.0.0.1:8404"),
                        help="host:port to listen on (env HAPROXY_AGENT_LISTEN), default 127.0.0.1:8404")
    parser.add_argument("--token", default=os.environ.get("HAPROXY_AGENT_TOKEN"),
                        help="shared secret, sent as Bearer token (env HAPROXY_AGENT_TOKEN)")
    parser.add_argument("--insecure-no-auth", action="store_true",
                        help="allow running without a token (only for testing)")
    parser.add_argument("--tls-cert", help="PEM certificate, enables HTTPS")
    parser.add_argument("--tls-key", help="PEM private key for --tls-cert")
    parser.add_argument("--timeout", type=float, default=5.0, help="HAProxy socket timeout in seconds")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if not args.token and not args.insecure_no_auth:
        parser.error("a token is required: use --token / HAPROXY_AGENT_TOKEN (or --insecure-no-auth for testing)")
    if args.token and len(args.token) < 16 and not args.insecure_no_auth:
        parser.error("the token is too short, use at least 16 characters")
    if bool(args.tls_cert) != bool(args.tls_key):
        parser.error("--tls-cert and --tls-key must be used together")

    host, _, port = args.listen.rpartition(":")
    try:
        httpd = ThreadingHTTPServer((host or "127.0.0.1", int(port)), make_handler(args))
    except (OSError, ValueError) as e:
        parser.error(f"cannot listen on {args.listen}: {e}")

    if args.tls_cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.tls_cert, args.tls_key)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    log.info("listening on %s://%s (HAProxy socket: %s)", "https" if args.tls_cert else "http", args.listen, args.socket)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    sys.exit(main())
