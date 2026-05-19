/**
 * Run once against the LOCAL POS Mongo to revive rows parked as `dead` or
 * stuck as `uploading`.
 *
 * You can run this from either the project root or the server folder:
 *   node server/revive-dead-queue.js
 *   node revive-dead-queue.js
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

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/jonels_inasalan';
  await mongoose.connect(uri);

  const db = mongoose.connection.db;
  console.log(`Connected to Mongo DB: ${db.databaseName}`);

  const SyncQueue = db.collection('syncqueues');
  const before = await SyncQueue.countDocuments({});
  const res = await SyncQueue.updateMany(
    { status: { $in: ['dead', 'uploading', 'failed'] } },
    { $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null } }
  );

  console.log(`Sync rows before: ${before}`);
  console.log(`Revived ${res.modifiedCount} sync rows.`);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
