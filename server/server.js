const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path     = require('path');

const orderRoutes     = require('./routes/orders');
const syncRoutes      = require('./sync/syncRoutes');
const syncService     = require('./sync/syncService');
const apiKeyAuth      = require('./middleware/apiKeyAuth');
const Order           = require('./models/Order');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.set('io', io);
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/jonels_inasalan';
mongoose.connect(MONGO_URI)
  .then(() => console.log('[DB] MongoDB connected'))
  .catch(err => console.error('[DB] Error:', err));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/orders', orderRoutes);
app.use('/api/sync',   apiKeyAuth, syncRoutes);

// Order cloud-sync hook is registered in models/Order.js before model compilation.

// ── Helpers (re-use the route module's station logic) ────────────────────────
const { buildInitialStations, hydrateStations, withStations, READY_TTL_MS } = orderRoutes;

const ALLOWED_AREAS    = ['grill', 'kitchen']; // extend here for future stations
const ALLOWED_STATUSES = ['preparing', 'ready'];

/**
 * Update a single station's status on an order. Recomputes overall status,
 * stamps timestamps, persists, and broadcasts. Returns the broadcast payload.
 *
 * Independence guarantee: this function ONLY mutates the requested station.
 * No other station's status is ever touched here.
 */
async function updateStation({ orderId, area, status }) {
  if (!ALLOWED_STATUSES.includes(status)) throw new Error(`Invalid station status: ${status}`);

  const order = await Order.findOne({ orderId });
  if (!order) return null;

  // Hydrate stations on legacy orders so the Map is always populated.
  const hydrated = hydrateStations(order.toObject());
  // Replace the doc's Map only if it was empty (don't clobber live state).
  if (!order.stations || order.stations.size === 0) {
    order.stations = new Map(Object.entries(hydrated));
  }

  if (!order.stations.get(area)) {
    // Station wasn't part of the original routing — nothing to update.
    throw new Error(`Order ${orderId} has no station "${area}"`);
  }

  const now  = new Date();
  const cur  = order.stations.get(area).toObject ? order.stations.get(area).toObject() : order.stations.get(area);
  const next = { ...cur, status, updatedAt: now };
  if (status === 'preparing' && !cur.startedAt) next.startedAt = now;
  if (status === 'ready')                       next.readyAt   = now;
  order.stations.set(area, next);

  // Recompute overall status from the (mutated) stations map.
  const stationsObj = Order.stationsToObject(order.stations);
  const wasReady    = order.status === 'ready';
  const overall     = Order.computeOverallStatus(stationsObj);
  order.status      = overall;
  if (overall === 'ready' && !wasReady) order.readyAt = now;
  await order.save();

  const payload = withStations(order);
  io.emit('order:stationUpdated', { orderId, area, status, order: payload });
  // Backwards-compat: also emit the legacy event so any old consumer keeps working.
  io.emit('order:statusUpdated',  { orderId, status: overall, order: payload });

  // ── Per-station 5-min auto-complete ────────────────────────────────────────
  // When a station goes ready, schedule it to auto-complete after the TTL.
  // When ALL stations are completed, the order's overall status becomes
  // 'completed' and it disappears from kitchen + TV.
  if (status === 'ready') {
    setTimeout(() => completeStation(orderId, area).catch(e =>
      console.error('[AUTO] complete-station error:', e)), READY_TTL_MS);
  }
  return payload;
}

async function completeStation(orderId, area) {
  const order = await Order.findOne({ orderId });
  if (!order) return;
  const cur = order.stations.get(area);
  if (!cur || cur.status !== 'ready') return;

  const now = new Date();
  const next = (cur.toObject ? cur.toObject() : cur);
  order.stations.set(area, { ...next, status: 'completed', completedAt: now, updatedAt: now });

  const stationsObj = Order.stationsToObject(order.stations);
  const overall     = Order.computeOverallStatus(stationsObj);
  order.status      = overall;
  if (overall === 'completed' && !order.completedAt) order.completedAt = now;
  await order.save();

  const payload = withStations(order);
  io.emit('order:stationUpdated', { orderId, area, status: 'completed', order: payload });
  io.emit('order:statusUpdated',  { orderId, status: overall, order: payload });
  console.log(`[AUTO] Order ${orderId} station ${area} → completed (overall=${overall})`);
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[WS] Connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[WS] Disconnected: ${socket.id}`));

  /**
   * Station-aware status update.
   *   { orderId, area: 'grill'|'kitchen', status: 'preparing'|'ready' }
   *
   * Each dashboard sends its OWN area — the server never derives one station's
   * status from another. If `area` is omitted (legacy clients), we fall back
   * to applying the change to every station the order has, preserving the old
   * single-status behavior for any unmigrated client.
   */
  socket.on('kitchen:updateStatus', async ({ orderId, area, status }) => {
    try {
      if (area && ALLOWED_AREAS.includes(area)) {
        await updateStation({ orderId, area, status });
        console.log(`[WS] ${orderId} :: ${area} → ${status}`);
        return;
      }

      // Legacy fallback — apply to every station this order has.
      const order = await Order.findOne({ orderId });
      if (!order) return;
      const hydrated = hydrateStations(order.toObject());
      const areas = Object.keys(hydrated);
      for (const a of areas) {
        await updateStation({ orderId, area: a, status });
      }
      console.log(`[WS] ${orderId} :: legacy → ${status} (broadcast to ${areas.join(',')})`);
    } catch (err) {
      console.error('[WS] kitchen:updateStatus error:', err.message);
    }
  });
});

// Startup
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Jonel's Inasalan POS — running on port ${PORT}`);
  console.log(`  Kiosk   → http://<server-ip>:${PORT}/kiosk.html`);
  console.log(`  Cashier → http://<server-ip>:${PORT}/cashier.html`);
  console.log(`  Grill   → http://<server-ip>:${PORT}/grill.html`);
  console.log(`  Kitchen → http://<server-ip>:${PORT}/kitchen.html`);
  console.log(`  TV      → http://<server-ip>:${PORT}/tv.html`);
  console.log(`  Sync    → http://<server-ip>:${PORT}/api/sync/status\n`);
  // Start background cloud-sync loop (no-op if not configured)
  syncService.startSyncLoop();
});
