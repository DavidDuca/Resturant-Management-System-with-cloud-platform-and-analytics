/**
 * syncService.js — offline-first cloud uploader.
 *
 * Design contract
 * ───────────────
 *   • The POS is the source of truth. Local operations NEVER wait on us.
 *   • We pull from SyncQueue in small batches and POST to the central cloud
 *     dashboard with HMAC-signed, API-key-authenticated requests.
 *   • Failures use exponential backoff with jitter (max ~30 min between tries)
 *     and are retried forever until success or a permanent (4xx) rejection,
 *     at which point the row is parked as `dead` for admin inspection.
 *   • Internet outages, DNS failures, and cloud 5xx are all transparently
 *     queued — no sales data is ever lost.
 *
 * Environment (all optional — service runs in OFFLINE_ONLY mode without them):
 *   CLOUD_SYNC_URL          base URL of the central dashboard API
 *   CLOUD_SYNC_API_KEY      restaurant API key issued by the cloud dashboard
 *   CLOUD_SYNC_SECRET       HMAC secret for request signing
 *   CLOUD_RESTAURANT_ID     this branch's unique restaurant identifier
 *   SYNC_BATCH_SIZE         default 25
 *   SYNC_INTERVAL_MS        default 15000 (15s)
 *   SYNC_MAX_ATTEMPTS       default 50 (then parked as `dead`)
 * 
 */
const fs          = require('fs');
const path        = require('path');
const dotenv      = require('dotenv');

// Load .env whether this file is started from the project root (`npm start`)
// or directly from the server folder (`node server.js`, helper scripts, etc.).
const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '.env')
];
const envPath = envCandidates.find(p => fs.existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

const crypto      = require('crypto');
const SyncQueue   = require('./SyncQueue');

const CFG = () => ({
  url:        process.env.CLOUD_SYNC_URL || '',
  apiKey:     process.env.CLOUD_SYNC_API_KEY || '',
  secret:     process.env.CLOUD_SYNC_SECRET || '',
  restaurant: process.env.CLOUD_RESTAURANT_ID || 'local',
  batchSize:  parseInt(process.env.SYNC_BATCH_SIZE || '25', 10),
  intervalMs: parseInt(process.env.SYNC_INTERVAL_MS || '15000', 10),
  maxAttempts:parseInt(process.env.SYNC_MAX_ATTEMPTS || '50', 10),
  timeoutMs:  parseInt(process.env.SYNC_TIMEOUT_MS || '12000', 10)
});

let _timer = null;
let _running = false;
let _online = true;
let _lastSuccessAt = null;
let _lastError = null;

function isConfigured() {
  const c = CFG();
  return !!(c.url && c.apiKey && c.secret);
}

/**
 * Enqueue a record for upload. Fire-and-forget — callers never await network.
 * Safe to call from hot paths (e.g. post-save hooks); the only DB write is a
 * single small insert into the local SyncQueue collection.
 */
async function enqueue(entity, entityId, payload, op = 'upsert') {
  try {
    // Upsert so repeated saves of the same entity (status updates, etc.)
    // refresh the payload instead of hitting the duplicate-index error and
    // being silently swallowed. A row already `synced` is re-queued so the
    // cloud always gets the latest snapshot.
    await SyncQueue.findOneAndUpdate(
      { entity, entityId, op, status: { $in: ['pending', 'failed', 'dead'] } },
      {
        $set: {
          payload,
          status: 'pending',
          nextAttemptAt: new Date(),
          lastError: null
        },
        $setOnInsert: { entity, entityId, op, attempts: 0, createdAt: new Date() }
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    // Even queue failures must not crash the POS. Just log.
    console.error('[SYNC] enqueue failed:', err.message);
  }
}

/**
 * Convenience: enqueue an Order document (used as a post-save hook).
 * Strips internal Mongo metadata and ships a clean snapshot.
 */
async function enqueueOrder(orderDoc) {
  if (!orderDoc) return;
  const o = (typeof orderDoc.toObject === 'function') ? orderDoc.toObject() : orderDoc;
  const stations = (o.stations && typeof o.stations === 'object' && !Array.isArray(o.stations))
    ? (o.stations instanceof Map
        ? Object.fromEntries(o.stations)
        : o.stations)
    : {};
  await enqueue('order', o.orderId, {
    orderId:      o.orderId,
    customerNo:   o.customerNo,
    items:        o.items,
    totalPrice:   o.totalPrice,
    cashReceived: o.cashReceived,
    changeDue:    o.changeDue,
    status:       o.status,
    stations,
    placedAt:     o.placedAt,
    paidAt:       o.paidAt,
    readyAt:      o.readyAt,
    completedAt:  o.completedAt,
    updatedAt:    o.updatedAt
  });
  // Paid orders also generate a "sale" snapshot — the cloud dashboard
  // can use either or both depending on what it tracks.
  if (['paid','preparing','partially-ready','ready','completed'].includes(o.status)) {
    await enqueue('sale', o.orderId, {
      orderId:     o.orderId,
      totalPrice:  o.totalPrice,
      itemCount:   (o.items || []).reduce((s,i)=>s+(i.quantity||0),0),
      paymentMethod: o.paymentMethod || 'cash',
      paidAt:      o.paidAt || o.placedAt
    });
  }
}

// ── HMAC signing ────────────────────────────────────────────────────────────
function signRequest(bodyString, timestamp) {
  const { secret } = CFG();
  // Cloud posAuth.js verifies with HMAC_SHA256(sha256(plainSecret), ...).
  // Both sides must use sha256(plainSecret) as the HMAC key — NOT the raw secret.
  const hmacKey = crypto.createHash('sha256').update(secret).digest('hex');
  return crypto
    .createHmac('sha256', hmacKey)
    .update(`${timestamp}.${bodyString}`)
    .digest('hex');
}

async function postBatch(batch) {
  const c = CFG();
  const body = JSON.stringify({
    restaurantId: c.restaurant,
    branchId:     process.env.CLOUD_BRANCH_ID || '',
    sentAt:       new Date().toISOString(),
    records:      batch.map(r => ({
      id:       r._id.toString(),
      entity:   r.entity,
      entityId: r.entityId,
      op:       r.op,
      payload:  r.payload,
      createdAt:r.createdAt
    }))
  });
  const ts  = Date.now().toString();
  const sig = signRequest(body, ts);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), c.timeoutMs);
  try {
    const resp = await fetch(`${c.url.replace(/\/$/,'')}/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Api-Key':       c.apiKey,
        'X-Restaurant-Id': c.restaurant,
        'X-Timestamp':     ts,
        'X-Signature':     sig
      },
      body,
      signal: ctrl.signal
    });
    const text = await resp.text().catch(() => '');
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: resp.ok, status: resp.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

// Exponential backoff with jitter, capped at 30 minutes.
function nextDelayMs(attempts) {
  const base = Math.min(30 * 60 * 1000, 5000 * Math.pow(2, Math.min(attempts, 10)));
  return base * (0.7 + Math.random() * 0.6);
}

async function drainOnce() {
  if (_running) return { skipped: 'busy' };
  if (!isConfigured()) return { skipped: 'not-configured' };
  _running = true;
  try {
    const now = new Date();
    const c = CFG();
    const batch = await SyncQueue.find({
      status: 'pending',
      $or: [
        { nextAttemptAt: { $lte: now } },
        { nextAttemptAt: { $exists: false } }
      ]
    }).sort({ createdAt: 1 }).limit(c.batchSize);

    if (batch.length === 0) return { uploaded: 0 };

    // Mark uploading
    const ids = batch.map(b => b._id);
    await SyncQueue.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'uploading', lastAttemptAt: now }, $inc: { attempts: 1 } }
    );

    let result;
    try {
      result = await postBatch(batch);
    } catch (err) {
      // Network-level failure (DNS, abort, offline).
      _online = false;
      _lastError = err.message;
      console.error('[SYNC] network error:', err.message);
      const delay = nextDelayMs(batch[0].attempts + 1);
      await SyncQueue.updateMany(
        { _id: { $in: ids } },
        { $set: { status: 'pending', lastError: err.message, nextAttemptAt: new Date(Date.now() + delay) } }
      );
      return { uploaded: 0, networkError: err.message };
    }

    if (result.ok) {
      _online = true;
      _lastSuccessAt = new Date();
      _lastError = null;
      // Optional per-record cloud ids in response (json.accepted = [{id, cloudId}])
      const cloudMap = {};
      (result.json?.accepted || []).forEach(a => { cloudMap[a.id] = a.cloudId; });
      await Promise.all(batch.map(b => SyncQueue.updateOne(
        { _id: b._id },
        { $set: { status: 'synced', syncedAt: new Date(), cloudId: cloudMap[b._id.toString()] || null, lastError: null } }
      )));
      return { uploaded: batch.length };
    }

    // HTTP-level failure — print the cloud response body so 401s show the
    // exact reason: Missing auth headers / Stale timestamp / Invalid credentials / Bad signature.
    _lastError = `HTTP ${result.status}: ${(result.text || '').slice(0, 300)}`;
    console.error('[SYNC]', _lastError);

    // 401 is recoverable: credentials/clock can be fixed without killing the queue forever.
    const isPermanent = result.status >= 400 && result.status < 500
      && ![401, 408, 429].includes(result.status);
    await Promise.all(batch.map(async (b) => {
      const dead = isPermanent || b.attempts >= c.maxAttempts;
      const delay = nextDelayMs(b.attempts);
      await SyncQueue.updateOne(
        { _id: b._id },
        dead
          ? { $set: { status: 'dead', lastError: _lastError } }
          : { $set: { status: 'pending', lastError: _lastError, nextAttemptAt: new Date(Date.now() + delay) } }
      );
    }));
    return { uploaded: 0, httpError: _lastError };
  } catch (err) {
    console.error('[SYNC] drain error:', err);
    _lastError = err.message;
    return { error: err.message };
  } finally {
    _running = false;
  }
}

function startSyncLoop() {
  if (_timer) return;
  const c = CFG();
  if (!isConfigured()) {
    console.log('[SYNC] Offline-only mode (CLOUD_SYNC_URL / CLOUD_SYNC_API_KEY not set). Queue will accumulate locally.');
    return;
  }
  console.log(`[SYNC] Cloud sync enabled → ${c.url} (every ${c.intervalMs}ms, batch=${c.batchSize})`);
  _timer = setInterval(() => { drainOnce().catch(()=>{}); }, c.intervalMs);
  // Kick off immediately
  drainOnce().catch(()=>{});
}

function stopSyncLoop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

async function getStatus() {
  const [pending, uploading, failed, dead, synced] = await Promise.all([
    SyncQueue.countDocuments({ status: 'pending' }),
    SyncQueue.countDocuments({ status: 'uploading' }),
    SyncQueue.countDocuments({ status: 'failed' }),
    SyncQueue.countDocuments({ status: 'dead' }),
    SyncQueue.countDocuments({ status: 'synced' })
  ]);
  return {
    configured:    isConfigured(),
    online:        _online,
    running:       _running,
    lastSuccessAt: _lastSuccessAt,
    lastError:     _lastError,
    counts: { pending, uploading, failed, dead, synced }
  };
}

module.exports = {
  enqueue,
  enqueueOrder,
  drainOnce,
  startSyncLoop,
  stopSyncLoop,
  getStatus,
  isConfigured
};