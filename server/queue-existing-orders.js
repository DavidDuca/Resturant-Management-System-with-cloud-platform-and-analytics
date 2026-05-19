/**
 * Optional one-time backfill: queues existing local orders that were saved
 * before the sync hook was fixed.
 *
 * Copy into the server folder, then run:
 *   node queue-existing-orders.js
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  path.resolve(__dirname, '..', '.env'),
];
const envPath = envCandidates.find(p => fs.existsSync(p));
dotenv.config(envPath ? { path: envPath } : undefined);

const Order = require('./models/Order');
const syncService = require('./sync/syncService');

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/jonels_inasalan';
  await mongoose.connect(uri);
  console.log(`Connected to Mongo DB: ${mongoose.connection.db.databaseName}`);

  const orders = await Order.find({
    status: { $in: ['paid', 'preparing', 'partially-ready', 'ready', 'completed', 'cancelled'] }
  }).sort({ updatedAt: 1 }).limit(10000);

  for (const order of orders) {
    await syncService.enqueueOrder(order);
  }

  console.log(`Queued ${orders.length} existing orders for cloud sync.`);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
