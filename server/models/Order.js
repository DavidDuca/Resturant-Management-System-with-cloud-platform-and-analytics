const mongoose = require('mongoose');

const AddOnSchema = new mongoose.Schema({
  name:  { type: String, required: true },
  price: { type: Number, required: true, default: 0 }
}, { _id: false });

const OrderItemSchema = new mongoose.Schema({
  itemId:    { type: String, required: true },
  name:      { type: String, required: true },
  category:  { type: String, required: true },
  // Smart routing: which station actually cooks/prepares this line item.
  // 'grill' → Grill Dashboard, 'kitchen' → Kitchen Dashboard.
  cookingArea: { type: String, enum: ['grill', 'kitchen'], default: 'kitchen' },
  basePrice: { type: Number, required: true },
  quantity:  { type: Number, required: true, min: 1 },
  addOns:    { type: [AddOnSchema], default: [] },
  lineTotal: { type: Number, required: true }
}, { _id: false });

// ── Per-station workflow state ───────────────────────────────────────────────
// Each cooking station owns its own lifecycle. A single order may live in
// multiple stations simultaneously and progress through them independently.
// New stations (drinks, dessert, fryer, packaging…) can be added without
// schema changes — `stations` is a free-form Map keyed by area name.
const StationStateSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['pending', 'preparing', 'ready', 'completed'],
    default: 'pending'
  },
  startedAt:   { type: Date },   // moved to preparing
  readyAt:     { type: Date },   // moved to ready
  completedAt: { type: Date },   // moved to completed
  updatedAt:   { type: Date, default: Date.now }
}, { _id: false });

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true, index: true },
  customerNo: { type: Number, required: true },

  items: {
    type: [OrderItemSchema], required: true,
    validate: v => Array.isArray(v) && v.length > 0
  },
  totalPrice:   { type: Number, required: true, min: 0 },

  cashReceived: { type: Number, default: 0 },
  changeDue:    { type: Number, default: 0 },

  // ── Overall (computed) status ──────────────────────────────────────────────
  // pending          → kiosk placed, not yet paid
  // paid             → cashier confirmed, all stations still pending
  // preparing        → at least one station actively preparing
  // partially-ready  → at least one station ready, others not yet
  // ready            → ALL stations ready
  // completed        → ALL stations completed (released to customer)
  // cancelled        → cashier cancelled
  status: {
    type: String,
    enum: ['pending','paid','preparing','partially-ready','ready','completed','cancelled'],
    default: 'pending', index: true
  },

  // Per-station workflow. Map<areaName, StationState>. Initialized at payment
  // from the distinct cookingAreas across line items.
  stations: {
    type: Map,
    of: StationStateSchema,
    default: () => new Map()
  },

  placedAt:    { type: Date, default: Date.now },
  paidAt:      { type: Date },
  readyAt:     { type: Date },   // first time ALL stations are ready
  completedAt: { type: Date },
  updatedAt:   { type: Date, default: Date.now }
});

OrderSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

/**
 * Compute the overall order status from station states.
 * Pure function — does not mutate the order.
 */
OrderSchema.statics.computeOverallStatus = function (stationsObj) {
  const states = Object.values(stationsObj || {})
    .map(s => (s && s.status) ? s.status : 'pending');
  if (states.length === 0) return 'paid';
  if (states.every(s => s === 'completed')) return 'completed';
  if (states.every(s => s === 'ready'))     return 'ready';
  if (states.some(s => s === 'ready'))      return 'partially-ready';
  if (states.some(s => s === 'preparing'))  return 'preparing';
  return 'paid';
};

/**
 * Helper: convert order.stations (Map or plain object) to a plain object so
 * the front-end and computeOverallStatus can read it uniformly.
 */
OrderSchema.statics.stationsToObject = function (stations) {
  if (!stations) return {};
  if (typeof stations.toObject === 'function') return stations.toObject();
  if (stations instanceof Map) {
    const out = {};
    stations.forEach((v, k) => { out[k] = v; });
    return out;
  }
  return stations;
};


// ── Cloud sync hook ──────────────────────────────────────────────────────────
// IMPORTANT: Mongoose middleware must be registered BEFORE mongoose.model(...).
// The old server.js hook was attached after the model was already compiled,
// so it did not reliably fire and orders never entered the SyncQueue.
OrderSchema.post('save', function (doc) {
  try {
    const syncService = require('../sync/syncService');
    syncService.enqueueOrder(doc).catch(err => {
      console.error('[SYNC] enqueue order failed:', err.message);
    });
  } catch (err) {
    console.error('[SYNC] hook error:', err.message);
  }
});

module.exports = mongoose.model('Order', OrderSchema);
