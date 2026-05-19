/**
 * Diagnostic: shows the local POS DB and sync queue counts.
 * Run from project root or server folder:
 *   node check-queue.js
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
  const names = (await db.listCollections().toArray()).map(c => c.name);
  console.log('envPath:', envPath || '(default dotenv lookup)');
  console.log('db:', db.databaseName);
  console.log('collections:', names);

  const queue = db.collection('syncqueues');
  console.log('\n=== syncqueues ===');
  console.log('total:', await queue.countDocuments({}));
  console.log('byStatus:', await queue.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray());
  console.log('sample:', JSON.stringify(await queue.find({}).sort({ _id: -1 }).limit(5).toArray(), null, 2));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
