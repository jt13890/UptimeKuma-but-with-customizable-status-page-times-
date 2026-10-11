# Active/passive high availability

Two (or more) Uptime Kuma nodes share **one MariaDB database**. Exactly one node is _active_ (runs monitors,
sends notifications, runs background jobs). The others are _standby_ and take over automatically.
Disabled by default: with `UPTIME_KUMA_HA_ENABLED` unset, behaviour is identical to stock Uptime Kuma.

## How it works

- A single-row lease table (`ha_lease`) is the lock. Nodes campaign every `RENEW_INTERVAL` seconds.
- The active node renews the lease. If it cannot renew for `TTL - RENEW_INTERVAL` seconds (e.g. it lost the
  database) it **stops its own monitors first**; a standby can only win after the full `TTL`. Two nodes never run
  monitors at the same time.
- Lease expiry uses the **database clock**, so clock skew between nodes is irrelevant.
- Graceful shutdown (SIGTERM) releases the lease, failover then takes about one renew interval.
  A crash/power loss takes up to `TTL` seconds.
- `epoch` increases on every change of active node (fencing token, visible at `/api/ha/health`).
- Monitors resume from the last heartbeat stored in the database, so there is no burst of checks on takeover.
  (In-memory retry counters restart, as they do on any normal restart.)

| Feature                             | Active          | Standby                                      |
| ----------------------------------- | --------------- | -------------------------------------------- |
| Monitors, notifications, jobs       | yes             | no                                           |
| Dashboard (socket.io)               | yes             | refused (clients retry until it is active)   |
| `/api/push/<token>`                 | yes             | HTTP 503                                     |
| Public status pages, badges         | yes             | yes (data refreshed from the DB periodically)|
| `/api/ha/health`                    | 200             | 503                                          |

## Configuration (environment variables)

| Variable                        | Default  | Meaning                                         |
| ------------------------------- | -------- | ----------------------------------------------- |
| `UPTIME_KUMA_HA_ENABLED`        | off      | `1` / `true` to enable                          |
| `UPTIME_KUMA_HA_NODE_NAME`      | hostname | Name shown in logs (a random suffix is added)   |
| `UPTIME_KUMA_HA_LEASE_TTL`      | `15`     | Lease lifetime in seconds                       |
| `UPTIME_KUMA_HA_RENEW_INTERVAL` | `5`      | Campaign/renew interval; must satisfy TTL >= 2x |

## Deployment checklist

1. **MariaDB must be shared and itself highly available** (Galera, primary/replica with automatic failover, or a
   managed service). A single database server is still a single point of failure.
   SQLite works only for testing two processes on the same host.
2. Run the same Uptime Kuma version on every node. **Start the first node alone** on a new database (setup wizard,
   migrations), then start the others.
3. Put a load balancer / reverse proxy in front and use `GET /api/ha/health` as the health check, so traffic only
   reaches the active node (200). Point push-monitor clients and your Prometheus scrape at that same address.
4. `data/upload` (status page logos/assets) is **not** in the database. Share it between nodes (NFS etc.) or sync it.
5. Cloudflare Tunnel / other per-node settings are not coordinated; configure them per node as needed.

Example HAProxy backend:

```
backend kuma
    option httpchk GET /api/ha/health
    http-check expect status 200
    server kuma-a 10.0.0.11:3001 check inter 2s fall 2 rise 1
    server kuma-b 10.0.0.12:3001 check inter 2s fall 2 rise 1
```

## Known limitations

- The dashboard and push endpoint are active-only by design; a standby never accepts writes that its in-memory
  state would not see.
- Status pages served by a standby can lag by up to about a minute behind the active node.
- A node that is demoted disconnects all dashboard clients; they reconnect via the load balancer.
