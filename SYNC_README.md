# GrillSync — Cloud Sync Layer (v3)

This update **extends** the existing offline-first POS without changing any
existing workflow. Three things changed:

1. **Analytics dashboard removed** — `server/routes/analytics.js` deleted,
   `/api/analytics` un-mounted, cashier sidebar tab + panel hidden via the
   new theme stylesheet (the JS code is dormant; you can delete the
   `loadAnalytics()` block in `public/js/cashier.js` later if you want a
   slimmer build). All analytics will now live in the upcoming cloud
   dashboard.

2. **Cloud Sync API service** — a new modular layer that uploads local
   restaurant data to a central cloud dashboard, fully offline-first.

3. **Light kiosk theme** — cool white/blue palette inspired by Jollibee /
   McDonald's kiosks, injected via `public/css/theme-light.css`. No HTML
   was restructured; the stylesheet overrides `:root` tokens on every page.

---

## Architecture

```
+------------------------------------------------------+
|                LOCAL RESTAURANT SERVER               |   ← primary, offline-first
|  POS · KDS · Sockets · Printer · MongoDB             |
|                       │                              |
|             post-save │ enqueueOrder()               |
|                       ▼                              |
|              [ SyncQueue (Mongo) ]                   |   ← persistent outbox
|                       │                              |
|              syncService loop (15s)                  |   ← background, non-blocking
|             batched + HMAC-signed POST               |
+-----------------------│------------------------------+
                        ▼  (when online)
            https://cloud.grillsync.app/sync/batch       ← future cloud dashboard
```

**Internet failure never affects POS operations.** Orders, payments, KDS,
printing, and realtime sockets all continue working. The outbox simply
grows; once connectivity returns, the loop drains it automatically with
exponential backoff.

---

## Folder additions

```
server/
  middleware/
    apiKeyAuth.js          ← guards /api/sync/* (loopback/LAN by default)
  sync/
    SyncQueue.js           ← Mongoose model — local outbox
    syncService.js         ← background uploader, retry, backoff, HMAC sign
    syncRoutes.js          ← /api/sync admin endpoints
public/
  css/
    theme-light.css        ← injected into every page
```

No existing file was structurally rewritten. `server/server.js` was edited
in two places (route mount swap + post-save hook + start loop on boot).

---

## API endpoints (local admin)

All under `/api/sync`, gated by `apiKeyAuth`:

| Method | Path                    | Purpose                                  |
|--------|-------------------------|------------------------------------------|
| GET    | `/api/sync/status`      | online flag, last success, queue counts  |
| GET    | `/api/sync/pending`     | list pending / uploading / failed rows   |
| GET    | `/api/sync/dead`        | permanently-failed rows (admin review)   |
| POST   | `/api/sync/drain`       | force an immediate drain attempt         |
| POST   | `/api/sync/retry/:id`   | requeue a dead/failed row                |
| DELETE | `/api/sync/purge?olderThanDays=7` | clean up synced history        |

Auth:
- If `LOCAL_ADMIN_TOKEN` env is set → required as `X-Admin-Token` header.
- Otherwise → loopback + private LAN (192.168/10/172) allowed.

---

## Cloud upload contract

`POST {CLOUD_SYNC_URL}/sync/batch`

Headers:
```
X-Api-Key:       <restaurant API key>
X-Restaurant-Id: <restaurant id>
X-Timestamp:     <ms-since-epoch>
X-Signature:     HMAC_SHA256(secret, "{timestamp}.{body}")
Content-Type:    application/json
```

Body:
```json
{
  "restaurantId": "jonels-main",
  "sentAt": "2026-05-17T12:34:56.000Z",
  "records": [
    { "id":"<localQueueId>", "entity":"order", "entityId":"AB12CD",
      "op":"upsert", "payload": { ... }, "createdAt":"..." }
  ]
}
```

Expected response (200):
```json
{ "accepted": [{ "id":"<localQueueId>", "cloudId":"<cloud-uuid>" }] }
```

Any 4xx (except 408/429) → row parked as `dead`. 5xx / network / timeout
→ exponential backoff (5s → 30 min cap, with jitter), up to
`SYNC_MAX_ATTEMPTS` (default 50) before parking.

---

## Environment variables

```env
# Cloud sync (leave blank = offline-only mode; queue still records data)
CLOUD_SYNC_URL=https://cloud.grillsync.app
CLOUD_SYNC_API_KEY=rk_live_xxx
CLOUD_SYNC_SECRET=whsec_xxx
CLOUD_RESTAURANT_ID=jonels-main

# Tuning (all optional)
SYNC_INTERVAL_MS=15000
SYNC_BATCH_SIZE=25
SYNC_MAX_ATTEMPTS=50
SYNC_TIMEOUT_MS=12000

# Local sync-admin protection (optional but recommended on networked boxes)
LOCAL_ADMIN_TOKEN=set-a-long-random-string
```

---

## Data shipped

Currently enqueued automatically on every order save:

- **order**   — full order snapshot including station states
- **sale**    — denormalized sales record for paid orders

The same outbox supports `expense`, `product`, `inventory`,
`analytics_daily` whenever those write paths are added — just call
`syncService.enqueue(entity, entityId, payload)` from the writer.

---

## Offline-first guarantees

- Post-save hook is `await`-free at the call site — POS code path never
  waits on the queue, let alone the network.
- All network I/O lives behind `AbortController` with a hard timeout.
- Drain runs single-flighted (`_running` flag) — never piles up.
- Permanent failures don't loop forever — they're parked as `dead` for
  admin review.
- The queue is in the same MongoDB the POS already uses, so it's covered
  by your existing backup routine.

---

## Run

```
npm install        # no new deps needed
npm start
```

The dev server picks up the new sync routes and the light theme
automatically. If `CLOUD_SYNC_URL` is unset you'll see:

```
[SYNC] Offline-only mode (CLOUD_SYNC_URL / CLOUD_SYNC_API_KEY not set).
       Queue will accumulate locally.
```

That's expected — the cloud dashboard is the next piece you build.
