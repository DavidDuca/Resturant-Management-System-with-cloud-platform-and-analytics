// checkDB.js
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('./server/models/Order');

async function check() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/jonels_inasalan';
  await mongoose.connect(MONGO_URI);
  console.log('Connected to:', MONGO_URI);

  const count = await Order.countDocuments();
  console.log(`Total orders in database: ${count}`);

  if (count > 0) {
    const sample = await Order.findOne();
    console.log('Sample order:', {
      orderId: sample.orderId,
      totalPrice: sample.totalPrice,
      status: sample.status,
      placedAt: sample.placedAt
    });
  } else {
    console.log('No orders found. Database is empty.');
  }

  process.exit(0);
}
check();