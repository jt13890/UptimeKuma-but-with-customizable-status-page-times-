# High availability for SQLite installs

Two Uptime Kuma nodes, each with its **own** `kuma.db`. If one goes offline the other keeps going. Only one node
exposes the dashboard. When the main node is back, it gets everything the other node recorded and takes over again.

(`HA.md` describes the MariaDB variant, where both nodes share one database. This document is for SQLite.)

## Set up

1. On the node that already has your data: **Settings → High Availability**
   - tick *Enable*, give it a name, tick *This is the main node*
   - *This node's URL*: how the other node reaches this one (`https://…` or a VPN address)
   - *Other node URL*: where the second node will live
   - *Generate* a shared secret, **Save**, restart Uptime Kuma once
2. Click **Create join token** and start the second node with it (the page shows a ready-made `docker run`):
   ```
   UPTIME_KUMA_HA_JOIN=<token>
   UPTIME_KUMA_HA_NODE_NAME=second-node
   UPTIME_KUMA_HA_URL=https://this-second-node.example.com
   ```
   The second node copies the data first and only then stands by. It will not become active before it has done
   that, so a fresh empty node can never take over.
3. Both nodes must run the **same version**. Nodes of different versions refuse to sync.

> **Security.** A snapshot is your entire database (password hashes, notification credentials). The nodes
> authenticate with the shared secret, but that does not encrypt anything: use HTTPS or a private network
> (Tailscale, WireGuard). The settings page warns about plain HTTP over public addresses.

## What happens when

| Situation | Behaviour |
|---|---|
| Main node dies | Secondary notices after *Take over after* (default 15 s + 10 s stagger) and becomes active, monitors start from its copy of the data. A graceful shutdown (restart, update) is announced, the other node takes over immediately. |
| Main node comes back | It starts as standby, sees the secondary is active and waits until that was stable for *Wait before handing back* (30 s). Then the **handover**: the secondary stops its monitors, makes a final snapshot, the main node applies it (so everything recorded in the meantime is on the main node), and only then becomes active. Its previous database is kept in `data/ha/backups/`. |
| Main node loses its wifi | It cannot reach the targets under *Connectivity check*. After *Stand down after* (20 s) it stops monitoring instead of recording false DOWNs, and the secondary takes over. When the wifi is back it takes over the secondary's data, then the active role again. |
| A service is down for one node but up for the other | **Up wins.** The standby also runs the checks and reports to the active node. A DOWN/PENDING result of the active node is overruled if the other node recently saw the service UP. |
| The link between the nodes breaks, both have internet | Both become active (see *Limits*). When the link is back the node with the higher epoch wins, the other one demotes and takes over its data. Its own database is kept in `data/ha/backups/`. |
| A node has no connectivity at all and cannot see the other | It never promotes itself, it cannot know whether the other node is dead or whether it is the one that is cut off. |

## Load balancer (HAProxy, nginx, Traefik)

A standby answers **HTTP 503 on every path and method** (including `OPTIONS /` and `HEAD /`, the default checks of
most load balancers), except the node-to-node API. So a load balancer marks it down without special configuration and
only the active node receives traffic. Its answer carries `X-HA-Role: standby` and `Retry-After: 10`.

```
backend kuma
    option httpchk GET /api/ha/health
    http-check expect status 200
    server node-a 10.0.0.1:3001 check inter 3s fall 2 rise 2
    server node-b 10.0.0.2:3001 check inter 3s fall 2 rise 2
```

`/api/ha/health` also tells you why (`role`, `epoch`). During a handover both nodes are briefly down (a few seconds).
If you prefer the standby to keep serving public status pages (for DNS based failover without a load balancer),
turn on *Standby also serves public status pages*; then the load balancer **must** check `/api/ha/health`, because
`/` and the status pages answer 200 on both nodes.

## How it works

- **Election** (`server/ha-peer.js`): every 5 s each node asks the other for its status. No active node reachable for
  long enough → promote with `epoch + 1`. Two active nodes → higher epoch wins, then the preferred node, then node id.
  Conflicts are resolved with epochs, not clocks.
- **Replication** (`server/ha-replication.js`): the active node makes a consistent snapshot with `VACUUM INTO` on a
  separate connection (does not block monitoring), gzips it and serves it. The standby pulls it every *Copy the data
  every* seconds, verifies sha256 and `PRAGMA quick_check`, then swaps it in (`Database.swapSqliteFile`). A broken
  download never touches the live database.
- **Observations** (up wins) travel over the same HTTP channel instead of the database table used by the MariaDB variant.
- **Settings** live in `data/ha.json` (per node, mode 0600), not in the database, because the database is replaced by
  the other node's copy. Shared tunables are pushed to the other node when you save; the secret, name and URLs stay local.

## Limits you should know

- **Data loss window.** If the active node dies, the standby has the data as of the last snapshot (default ≤ 60 s old,
  minimum 5 s; shorter intervals cost the active node more I/O). Configuration changes and heartbeats from that window are
  lost. A planned handover loses nothing.
- **Split brain is possible by design** (availability over consistency): without a third arbiter a node cannot tell a dead
  peer from a broken link. The connectivity check makes it unlikely for the "wifi is gone" case, but if both nodes have
  internet and only the link between them fails, both run. When the link returns, one side's data is replaced by the
  other's; the replaced database stays in `data/ha/backups/` (newest 3 kept).
- **Two nodes only** are supported and tested.
- **Files outside the database** (`data/upload`, custom CSS assets) are not replicated.
- Enabling/disabling, node name, peers and the secret need a restart; the other tunables apply live.
- By default the standby answers 503 everywhere (see *Load balancer*). With *Standby also serves public status pages* it serves status pages, badges and the API, but not the dashboard.
- If you only monitor your local network, clear the connectivity targets, otherwise a node that has no internet is
  considered offline.

## Tests

`test/backend-test/test-ha-peer.js` starts two real nodes (real HTTP, real SQLite files; needs Node 22.5+ for
`node:sqlite`, skipped on older versions) and covers failover, failback with data return, up wins, losing connectivity,
split brain, wrong secret, version mismatch, corrupted snapshot and the join token.
