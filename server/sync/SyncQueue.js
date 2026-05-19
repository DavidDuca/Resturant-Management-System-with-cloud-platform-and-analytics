/**
 * SyncQueue model — local persistent outbox for cloud uploads.
 *
 * Every record that needs to ship to the cloud central dashboard is appended
 * here FIRST. The actual upload is performed asynchronously by syncService,
 * so POS operations are never blocked by network I/O. If the cloud is down
 * or the internet is unavailable, items just accumulate here and drain
 * automatically once connectivity returns.
 *
 * The schema is intentionally generic so any future entity (orders, sales,
 * expenses, inventory, products, analytics rollups…) can use the same outbox.
 */
const mongoose = require('mongoose');

const SyncQueueSchema = new mongoose.Schema({
  // What kind of payload is this? Used for routing on the cloud side.
  entity: {
    type: String,
    required: true,
    enum: ['order', 'sale', 'expense', 'product', 'inventory', 'analytics_daily'],
    index: true
  },
  // Local primary key (e.g. orderId). Used for dedupe + idempotent upserts.
  entityId: { type: String, required: true, index: true },

  // upsert | delete — cloud applies accordingly.
  op: { type: String, enum: ['upsert', 'delete'], default: 'upsert' },

  // Full payload snapshot (denormalized so the upload doesn't need to re-read
  // local DB — important because the row may change again before sync runs).
  payload: { type: mongoose.Schema.Types.Mixed, required: true },

  // Lifecycle
  status: {
    type: String,
    enum: ['pending', 'uploading', 'synced', 'failed', 'dead'],
    default: 'pending',
    index: true
  },
  attempts:     { type: Number, default: 0 },
  lastAttemptAt:{ type: Date },
  nextAttemptAt:{ type: Date, default: Date.now, index: true },
  lastError:    { type: String },

  // Cloud-side id assigned after a successful upload (so we can correlate).
  cloudId:      { type: String },

  createdAt:    { type: Date, default: Date.now, index: true },
  syncedAt:     { type: Date }
});

// Avoid duplicate pending rows for the same entity+entityId+op.
SyncQueueSchema.index(
  { entity: 1, entityId: 1, op: 1, status: 1 },
  { partialFilterExpression: { status: { $in: ['pending', 'uploading'] } } }
);

module.exports = mongoose.model('SyncQueue', SyncQueueSchema);
