// seed13kOrders.js
require('dotenv').config();
const mongoose = require('mongoose');
const { MENU, ADD_ONS } = require('./server/menu');
const Order = require('./server/models/Order');

// ────────────────────────────────────────────────────────────────────────────
// Helper functions
// ────────────────────────────────────────────────────────────────────────────
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function randomDateBetween(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function generateOrderId() {
  // 6-character alphanumeric, e.g., "A3X9K2"
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Flatten menu into product list
function getAllProducts() {
  const products = [];
  for (const [category, items] of Object.entries(MENU)) {
    for (const item of items) {
      products.push({
        itemId: item.id,
        name: item.name,
        category: category,
        basePrice: item.price,
      });
    }
  }
  return products;
}

const PRODUCTS = getAllProducts();

// Peak hour biasing: lunch (11-13) and dinner (18-20) get more orders
function getPeakBiasedTime(baseDate) {
  const hour = rand(0, 23);
  let weight = 1;
  if (hour >= 11 && hour <= 13) weight = 4;
  else if (hour >= 18 && hour <= 20) weight = 3;
  else if (hour >= 9 && hour <= 10) weight = 2;
  else if (hour >= 14 && hour <= 16) weight = 1.5;
  else weight = 0.5;
  if (Math.random() > weight / 4) return getPeakBiasedTime(baseDate);
  baseDate.setHours(hour, rand(0, 59), rand(0, 59), 0);
  return baseDate;
}

// Generate a single order (always completed)
function generateOrder(orderDate) {
  const numItems = rand(1, 5);               // 1 to 5 different items
  const items = [];
  let totalPrice = 0;

  for (let i = 0; i < numItems; i++) {
    const product = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
    const qty = rand(1, 3);                  // 1 to 3 of that product
    const lineTotal = product.basePrice * qty;

    // Add-ons for this line item (20% chance)
    const addOns = [];
    if (Math.random() < 0.2 && ADD_ONS.length) {
      const addon = ADD_ONS[Math.floor(Math.random() * ADD_ONS.length)];
      if (addon.price > 0) {
        addOns.push({ name: addon.name, price: addon.price });
      }
    }

    items.push({
      itemId: product.itemId,
      name: product.name,
      category: product.category,
      basePrice: product.basePrice,
      quantity: qty,
      addOns: addOns,
      lineTotal: lineTotal,
    });
    totalPrice += lineTotal;
  }

  // Occasionally add a standalone add‑on (e.g., extra rice) as a separate line
  if (Math.random() < 0.15 && ADD_ONS.length) {
    const addon = ADD_ONS[Math.floor(Math.random() * ADD_ONS.length)];
    if (addon.price > 0) {
      items.push({
        itemId: addon.id,
        name: addon.name,
        category: 'addons',
        basePrice: addon.price,
        quantity: 1,
        addOns: [],
        lineTotal: addon.price,
      });
      totalPrice += addon.price;
    }
  }

  // All seeded orders are completed
  const status = 'completed';
  const paidAt = orderDate;
  const completedAt = orderDate;
  // readyAt is set a few minutes before completion
  const readyAt = new Date(orderDate.getTime() - rand(5, 30) * 60000);

  // Customer number: random 1..999 (real system resets daily, but for seeding it's fine)
  const customerNo = rand(1, 999);

  return {
    orderId: generateOrderId(),
    customerNo,
    items,
    totalPrice,
    cashReceived: totalPrice,   // assume exact cash
    changeDue: 0,
    status,
    placedAt: orderDate,
    paidAt,
    readyAt,
    completedAt,
    updatedAt: orderDate,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Main seeding function
// ────────────────────────────────────────────────────────────────────────────
async function seed13kOrders() {
  try {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/jonels_inasalan';
    await mongoose.connect(MONGO_URI);
    console.log('[Seed] Connected to MongoDB');

    // OPTIONAL: Drop the entire database for a completely fresh start
    // Uncomment the next line if you want to delete ALL existing data
    // await mongoose.connection.db.dropDatabase();
    // console.log('[Seed] Dropped entire database');

    // Alternatively, delete only old orders (keep today's real ones)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const deleteResult = await Order.deleteMany({ placedAt: { $lt: todayStart } });
    console.log(`[Seed] Deleted ${deleteResult.deletedCount} orders older than today`);

    const totalOrders = 13000;
    const orders = [];
    const batchSize = 500;

    const endDate = new Date();               // today
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 90); // 90 days ago

    for (let i = 0; i < totalOrders; i++) {
      let rawDate = randomDateBetween(startDate, endDate);
      if (rawDate > endDate) rawDate = endDate;
      const finalDate = getPeakBiasedTime(rawDate);
      const order = generateOrder(finalDate);
      orders.push(order);

      if (orders.length % batchSize === 0) {
        await Order.insertMany(orders.slice(-batchSize));
        console.log(`[Seed] Inserted ${orders.length} / ${totalOrders} orders`);
      }
    }

    // Insert any remaining orders
    const remaining = orders.length % batchSize;
    if (remaining > 0) {
      await Order.insertMany(orders.slice(-remaining));
    }

    console.log(`[Seed] Successfully seeded ${totalOrders} completed orders over 90 days.`);
    process.exit(0);
  } catch (err) {
    console.error('[Seed] Error:', err);
    process.exit(1);
  }
}

seed13kOrders();