const mongoose = require('mongoose');

const CounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});

/**
 * nextSeq(name) — generic increment, used for misc counters
 */
CounterSchema.statics.nextSeq = async function (name) {
  const doc = await this.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
};

/**
 * nextDailyCustomerNo()
 * Returns a daily sequential customer number that resets to 1 each calendar
 * day (Philippine Time, UTC+8).  The counter key is "custno-YYYY-MM-DD".
 * Tomorrow a new key is created automatically → starts at 1 again.
 */
CounterSchema.statics.nextDailyCustomerNo = async function () {
  // Get current date in PH time (UTC+8)
  const now   = new Date();
  const phNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const dateKey = phNow.toISOString().slice(0, 10); // "2025-06-15"
  const key     = `custno-${dateKey}`;

  const doc = await this.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq; // 1, 2, 3, …
};

module.exports = mongoose.model('Counter', CounterSchema);
