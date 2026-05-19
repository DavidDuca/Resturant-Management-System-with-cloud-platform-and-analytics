const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const Order    = require('../models/Order');
const Counter  = require('../models/Counter');
const { printOrderReceipt } = require('../printer');

// ── Menu helpers ──────────────────────────────────────────────────────────────
// Always re-require so edits via admin are reflected immediately
function getMenu()       { return require('../menu').MENU; }
function getAddOns()     { return require('../menu').ADD_ONS; }
function getCatDefaults(){ return require('../menu').CATEGORY_DEFAULTS || {}; }
function getCategories() { return require('../menu').CATEGORIES || Object.keys(getMenu()); }
function getAllItems()   { return Object.values(getMenu()).flat(); }

// Resolve {cookingArea, pairBehavior} for a single menu item, falling back to
// category defaults so legacy items keep working without a data migration.
function resolveRouting(menuItem, category) {
  const def = getCatDefaults()[category] || { cookingArea: 'kitchen', pairBehavior: 'fixed' };
  return {
    cookingArea:  menuItem.cookingArea  || def.cookingArea,
    pairBehavior: menuItem.pairBehavior || def.pairBehavior
  };
}

// ── Random orderId generator ──────────────────────────────────────────────────
// 6-char uppercase alphanumeric, e.g. "A3X9K2"
function generateOrderId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous I,O,0,1
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
async function uniqueOrderId() {
  let id, exists = true;
  while (exists) {
    id     = generateOrderId();
    exists = await Order.exists({ orderId: id });
  }
  return id;
}

// ── 5-minute cutoff helper ────────────────────────────────────────────────────
const READY_TTL_MS = 5 * 60 * 1000;
function isExpiredReady(order) {
  if (order.status !== 'ready') return false;
  if (!order.readyAt) return false;
  return Date.now() - new Date(order.readyAt).getTime() > READY_TTL_MS;
}

// ── Station helpers ──────────────────────────────────────────────────────────
// Build the initial `stations` map for an order based on the distinct cooking
// areas referenced by its items. Every active area starts at `pending` and
// progresses independently from there.
function buildInitialStations(items) {
  const defs = require('../menu').CATEGORY_DEFAULTS || {};
  const areas = new Set();
  for (const it of items || []) {
    const a = it.cookingArea || (defs[it.category]?.cookingArea ?? 'kitchen');
    areas.add(a);
  }
  const now = new Date();
  const out = {};
  areas.forEach(a => {
    out[a] = { status: 'pending', updatedAt: now };
  });
  return out;
}

// Hydrate legacy orders (saved before the station model existed) by inferring
// stations from items + the legacy top-level status. Pure — does not mutate.
function hydrateStations(orderObj) {
  const existing = Order.stationsToObject(orderObj.stations);
  if (existing && Object.keys(existing).length > 0) return existing;
  const stations = buildInitialStations(orderObj.items);
  const legacy = orderObj.status;
  // Mirror legacy status onto every inferred station so old data still renders
  // sensibly. Per-station independence applies to NEW orders going forward.
  if (['preparing','ready','completed'].includes(legacy)) {
    for (const k of Object.keys(stations)) {
      stations[k].status = legacy;
      if (legacy === 'ready' || legacy === 'completed') {
        stations[k].readyAt = orderObj.readyAt || orderObj.updatedAt;
      }
      if (legacy === 'completed') {
        stations[k].completedAt = orderObj.completedAt || orderObj.updatedAt;
      }
    }
  }
  return stations;
}

// Attach a hydrated `stations` plain object to a serialized order. Always use
// this before sending an order to a client, so the front-end never sees a Map
// or a missing field.
function withStations(orderDoc) {
  const obj = (typeof orderDoc.toObject === 'function') ? orderDoc.toObject() : orderDoc;
  obj.stations = hydrateStations(obj);
  return obj;
}

// Expose so server.js socket handler can reuse the same logic.
router.buildInitialStations = buildInitialStations;
router.hydrateStations      = hydrateStations;
router.withStations         = withStations;
router.READY_TTL_MS         = READY_TTL_MS;

// ── Multer config for product image uploads ───────────────────────────────────
const ASSETS_DIR = path.join(__dirname, '../../public/assets/menu');
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ASSETS_DIR),
  filename: (req, file, cb) => {
    // Use the itemId from the body if provided, else generate a slug
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const base = req.body.imageFilename || `item-${Date.now()}`;
    cb(null, `${base}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (/image\/(jpeg|png|webp|gif)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  MENU & ADMIN ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/orders/menu
router.get('/menu', (_req, res) => {
  res.json({ menu: getMenu(), addOns: getAddOns() });
});

// POST /api/orders/admin/products — add a new product
router.post('/admin/products', upload.single('image'), async (req, res) => {
  try {
    const { category, name, description, price, cookingArea, pairBehavior } = req.body;
    const validCats = getCategories();
    if (!validCats.includes(category))
      return res.status(400).json({ error: `Invalid category. Allowed: ${validCats.join(', ')}` });
    if (!name || !price)
      return res.status(400).json({ error: 'name and price are required.' });

    const menuPath  = path.join(__dirname, '../menu.js');
    const menuMod   = require('../menu');
    const MENU      = menuMod.MENU;
    if (!Array.isArray(MENU[category])) MENU[category] = [];

    // Build a new item id: category prefix + next index. nonGrilled → 'n'.
    const prefixMap = { grills: 'g', nonGrilled: 'n', drinks: 'd', sides: 's' };
    const prefix    = prefixMap[category] || category[0];
    const existing  = MENU[category];
    const num       = String(existing.length + 1).padStart(2, '0');
    const id        = `${prefix}${num}`;

    const imageFile = req.file ? path.basename(req.file.filename) : null;
    const def       = (menuMod.CATEGORY_DEFAULTS || {})[category] || { cookingArea: 'kitchen', pairBehavior: 'fixed' };

    const newItem = {
      id,
      name:         name.trim(),
      price:        parseFloat(price),
      description:  (description || '').trim(),
      image:        imageFile,
      cookingArea:  ['grill','kitchen'].includes(cookingArea)  ? cookingArea  : def.cookingArea,
      pairBehavior: ['fixed','follow-grill'].includes(pairBehavior) ? pairBehavior : def.pairBehavior
    };

    existing.push(newItem);
    writeMenu(MENU, menuMod.ADD_ONS, menuPath);

    // Broadcast menu update to all kiosks
    req.app.get('io').emit('menu:updated', { menu: MENU, addOns: menuMod.ADD_ONS });
    res.json({ success: true, item: newItem });
  } catch (err) {
    console.error('[ADMIN] add product error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/admin/products/:id — update product fields
router.patch('/admin/products/:id', upload.single('image'), async (req, res) => {
  try {
    const menuPath = path.join(__dirname, '../menu.js');
    const menuMod  = require('../menu');
    const MENU     = menuMod.MENU;
    const allItems = Object.values(MENU).flat();
    const item     = allItems.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Product not found.' });

    if (req.body.name)        item.name        = req.body.name.trim();
    if (req.body.description) item.description = req.body.description.trim();
    if (req.body.price)       item.price       = parseFloat(req.body.price);
    if (req.body.inStock !== undefined) item.inStock = req.body.inStock !== 'false';
    if (req.body.cookingArea && ['grill','kitchen'].includes(req.body.cookingArea))
      item.cookingArea = req.body.cookingArea;
    if (req.body.pairBehavior && ['fixed','follow-grill'].includes(req.body.pairBehavior))
      item.pairBehavior = req.body.pairBehavior;
    if (req.file)             item.image       = path.basename(req.file.filename);

    writeMenu(MENU, menuMod.ADD_ONS, menuPath);
    req.app.get('io').emit('menu:updated', { menu: MENU, addOns: menuMod.ADD_ONS });
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/orders/admin/products/:id — remove a product
router.delete('/admin/products/:id', async (req, res) => {
  try {
    const menuPath = path.join(__dirname, '../menu.js');
    const menuMod  = require('../menu');
    const MENU     = menuMod.MENU;

    let found = false;
    for (const cat of getCategories()) {
      if (!Array.isArray(MENU[cat])) continue;
      const idx = MENU[cat].findIndex(i => i.id === req.params.id);
      if (idx !== -1) { MENU[cat].splice(idx, 1); found = true; break; }
    }
    if (!found) return res.status(404).json({ error: 'Product not found.' });

    writeMenu(MENU, menuMod.ADD_ONS, menuPath);
    req.app.get('io').emit('menu:updated', { menu: MENU, addOns: menuMod.ADD_ONS });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Writes the in-memory MENU back to menu.js on disk so changes survive restarts.
 * Also invalidates the require() cache so the next require('../menu') picks up changes.
 */
function writeMenu(MENU, ADD_ONS, menuPath) {
  const content = `/**
 * menu.js — Jonel's Inasalan — auto-generated, do not edit manually
 */

const MENU = ${JSON.stringify(MENU, null, 2)};

const ADD_ONS = ${JSON.stringify(ADD_ONS, null, 2)};

const CATEGORY_DEFAULTS = {
  grills:     { cookingArea: 'grill',   pairBehavior: 'fixed' },
  nonGrilled: { cookingArea: 'kitchen', pairBehavior: 'fixed' },
  drinks:     { cookingArea: 'kitchen', pairBehavior: 'fixed' },
  sides:      { cookingArea: 'kitchen', pairBehavior: 'follow-grill' }
};

const CATEGORIES = ['grills', 'nonGrilled', 'drinks', 'sides'];

module.exports = { MENU, ADD_ONS, CATEGORY_DEFAULTS, CATEGORIES };
`;
  fs.writeFileSync(menuPath, content, 'utf8');
  // Bust require cache
  delete require.cache[require.resolve('../menu')];
}

// ═════════════════════════════════════════════════════════════════════════════
//  ORDER ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/orders — place new order from kiosk
router.post('/', async (req, res) => {
  const io = req.app.get('io');
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'Order must contain at least one item.' });

    const allItems  = getAllItems();
    const allAddOns = getAddOns();
    const MENU      = getMenu();

    let totalPrice = 0;
    const validatedItems = [];
    const stagedRoutings = []; // parallel to validatedItems; finalized after first pass

    for (const ci of items) {
      const menuItem = allItems.find(m => m.id === ci.itemId);
      if (!menuItem) return res.status(400).json({ error: `Unknown item ID: ${ci.itemId}` });

      const qty = parseInt(ci.quantity, 10);
      if (!qty || qty < 1) return res.status(400).json({ error: `Invalid quantity for ${ci.itemId}` });

      const validatedAddOns = [];
      for (const ca of (ci.addOns || [])) {
        const ao = allAddOns.find(a => a.id === ca.id);
        if (ao) validatedAddOns.push({ name: ao.name, price: ao.price });
      }

      const addonTotal = validatedAddOns.reduce((s, a) => s + a.price, 0);
      const lineTotal  = (menuItem.price + addonTotal) * qty;
      totalPrice += lineTotal;

      // Find which menu category this item belongs to (supports any registered category)
      let category = 'grills';
      for (const cat of getCategories()) {
        if (Array.isArray(MENU[cat]) && MENU[cat].find(x => x.id === menuItem.id)) { category = cat; break; }
      }

      const routing = resolveRouting(menuItem, category);
      stagedRoutings.push(routing);

      validatedItems.push({
        itemId: menuItem.id, name: menuItem.name, category,
        cookingArea: routing.cookingArea, // provisional; finalized below
        basePrice: menuItem.price, quantity: qty,
        addOns: validatedAddOns, lineTotal
      });
    }

    // ── Smart routing pass ──────────────────────────────────────────────────
    // pairBehavior 'follow-grill' → if the order contains ANY grill item,
    // force this line to 'grill'; otherwise keep its native cookingArea.
    const orderHasGrill = stagedRoutings.some(r => r.cookingArea === 'grill' && r.pairBehavior !== 'follow-grill');
    validatedItems.forEach((it, i) => {
      const r = stagedRoutings[i];
      if (r.pairBehavior === 'follow-grill') {
        it.cookingArea = orderHasGrill ? 'grill' : (r.cookingArea || 'kitchen');
      }
    });

    const orderId    = await uniqueOrderId();
    const customerNo = await Counter.nextDailyCustomerNo();

    const order = new Order({
      orderId, customerNo, items: validatedItems, totalPrice, status: 'pending'
    });
    await order.save();

    io.emit('order:new', order.toObject());
    printOrderReceipt(order.toObject()).catch(e => console.error('[PRINT]', e));

    res.status(201).json({ success: true, orderId, customerNo, totalPrice });
  } catch (err) {
    console.error('[POST /orders]', err);
    res.status(500).json({ error: 'Server error placing order.' });
  }
});

// PATCH /api/orders/:orderId/complete — auto-complete after 5-min ready
router.patch('/:orderId/complete', async (req, res) => {
  const io = req.app.get('io');
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) return res.status(404).json({ error: 'Not found.' });
    if (order.status !== 'ready') return res.status(409).json({ error: 'Not in ready state.' });

    order.status      = 'completed';
    order.completedAt = new Date();
    await order.save();

    io.emit('order:statusUpdated', { orderId: order.orderId, status: 'completed', order: order.toObject() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/history — cashier order history, paginated
router.get('/history', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
    const limit = Math.min(50, parseInt(req.query.limit || '30', 10));
    const skip  = (page - 1) * limit;

    // Optional date filter: ?date=2025-06-15 (PH local date)
    let dateFilter = {};
    if (req.query.date) {
      const d     = new Date(req.query.date + 'T00:00:00+08:00');
      const dEnd  = new Date(d.getTime() + 24 * 60 * 60 * 1000);
      dateFilter  = { placedAt: { $gte: d, $lt: dEnd } };
    }

    const [orders, total] = await Promise.all([
      Order.find({ status: { $in: ['paid','preparing','ready','completed','cancelled'] }, ...dateFilter })
        .sort({ placedAt: -1 })
        .skip(skip).limit(limit),
      Order.countDocuments({ status: { $in: ['paid','preparing','ready','completed','cancelled'] }, ...dateFilter })
    ]);

    res.json({ orders, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/kitchen/active?area=kitchen|grill — area-aware feed.
// Returns active orders that contain at least one item routed to the requested
// cooking area. Each order is returned with `_routedItems` (filtered to the
// area). The original `items` array is preserved for backwards compatibility.
async function activeForArea(area) {
  const cutoff = new Date(Date.now() - READY_TTL_MS);
  // Pull anything that could possibly belong to this station. We filter
  // precisely in JS using the (hydrated) station status — much simpler than
  // building a Map-aware Mongo query, and still bounded by overall status.
  const orders = await Order.find({
    status: { $in: ['paid', 'preparing', 'partially-ready', 'ready'] }
  }).sort({ paidAt: 1 }).limit(80);

  const defs = require('../menu').CATEGORY_DEFAULTS || {};
  return orders
    .map(o => {
      const obj = withStations(o); // hydrates legacy orders too
      obj.items = obj.items.map(it => ({
        ...it,
        cookingArea: it.cookingArea || (defs[it.category]?.cookingArea ?? 'kitchen')
      }));
      obj._routedItems = obj.items.filter(it => it.cookingArea === area);
      obj._stationStatus = obj.stations?.[area]?.status || null;
      return obj;
    })
    // Must have at least one item routed here AND a live station state.
    .filter(o => o._routedItems.length > 0 && o._stationStatus)
    // Drop stations that are completed OR ready-but-expired.
    .filter(o => {
      if (o._stationStatus === 'completed') return false;
      if (o._stationStatus === 'ready') {
        const ra = o.stations[area]?.readyAt;
        if (ra && new Date(ra).getTime() < cutoff.getTime()) return false;
      }
      return true;
    })
    .slice(0, 30);
}

router.get('/kitchen/active', async (req, res) => {
  try {
    const area = req.query.area === 'grill' ? 'grill' : 'kitchen';
    res.json(await activeForArea(area));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/grill/active — convenience alias
router.get('/grill/active', async (_req, res) => {
  try { res.json(await activeForArea('grill')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders/bestsellers?limit=10 — top sellers across ALL categories,
// ranked by total quantity sold. Used by the kiosk "Best Sellers" tab.
router.get('/bestsellers', async (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit || '10', 10)));
    const PAID  = ['paid', 'preparing', 'ready', 'completed'];
    const agg = await Order.aggregate([
      { $match: { status: { $in: PAID } } },
      { $unwind: '$items' },
      { $group: {
          _id: '$items.itemId',
          name:     { $first: '$items.name' },
          category: { $first: '$items.category' },
          totalQty:     { $sum: '$items.quantity' },
          totalRevenue: { $sum: '$items.lineTotal' }
      }},
      { $sort: { totalQty: -1 } },
      { $limit: limit }
    ]);

    // Hydrate with current menu metadata (image, price, inStock)
    const allItems = getAllItems();
    const enriched = agg.map(row => {
      const m = allItems.find(x => x.id === row._id) || {};
      return {
        itemId:   row._id,
        name:     m.name || row.name,
        category: row.category,
        price:    m.price ?? null,
        image:    m.image || null,
        description: m.description || '',
        inStock:  m.inStock !== false,
        cookingArea: m.cookingArea || null,
        totalQty: row.totalQty,
        totalRevenue: row.totalRevenue
      };
    }).filter(r => r.price !== null); // drop items removed from menu

    res.json({ items: enriched });
  } catch (err) {
    console.error('[BESTSELLERS]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/tv/display — TV: any order with at least one station
// currently preparing or ready (and not yet expired). The TV itself splits
// these into 4 columns (Grill Preparing/Ready, Kitchen Preparing/Ready).
router.get('/tv/display', async (_req, res) => {
  try {
    const cutoff = new Date(Date.now() - READY_TTL_MS);
    const orders = await Order.find({
      status: { $in: ['preparing', 'partially-ready', 'ready'] }
    }).sort({ paidAt: -1 }).limit(120);

    const out = orders.map(withStations).filter(o => {
      // Keep only orders that still have a non-completed, non-expired station.
      return Object.entries(o.stations).some(([_, s]) => {
        if (!s) return false;
        if (s.status === 'preparing') return true;
        if (s.status === 'ready') {
          if (!s.readyAt) return true;
          return new Date(s.readyAt).getTime() >= cutoff.getTime();
        }
        return false;
      });
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/:orderId — cashier lookup (must be after named routes)
router.get('/:orderId', async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/:orderId/pay
router.patch('/:orderId/pay', async (req, res) => {
  const io = req.app.get('io');
  try {
    const { cashReceived } = req.body;
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order)                     return res.status(404).json({ error: 'Order not found.' });
    if (order.status !== 'pending') return res.status(409).json({ error: `Order is already ${order.status}.` });
    if (cashReceived < order.totalPrice)
      return res.status(400).json({ error: 'Cash received is less than total.' });

    order.status       = 'paid';
    order.cashReceived = cashReceived;
    order.changeDue    = parseFloat((cashReceived - order.totalPrice).toFixed(2));
    order.paidAt       = new Date();
    // Initialize per-station workflow from the items present in this order.
    const initial = buildInitialStations(order.items);
    order.stations = new Map(Object.entries(initial));
    await order.save();

    const broadcast = withStations(order);
    io.emit('order:paid', broadcast);
    res.json({ success: true, order: broadcast });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/:orderId/cancel
router.patch('/:orderId/cancel', async (req, res) => {
  const io = req.app.get('io');
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (!['pending','paid'].includes(order.status))
      return res.status(409).json({ error: `Cannot cancel: ${order.status}` });

    order.status = 'cancelled';
    await order.save();
    io.emit('order:cancelled', { orderId: order.orderId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
