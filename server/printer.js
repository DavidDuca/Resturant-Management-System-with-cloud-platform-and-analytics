/**
 * printer.js — GrillSync thermal receipt printer helper
 * Uses: node-thermal-printer
 * Install: npm install node-thermal-printer
 *
 * Assumes a USB thermal printer. Adjust `interface` to your system path:
 *   Windows: 'printer:PrinterName'  (share name from Windows Print & Scan)
 *   Linux:   '/dev/usb/lp0'
 */

const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');

const PRINTER_INTERFACE = process.env.PRINTER_INTERFACE || 'printer:GrillSyncPrinter';
const STORE_NAME        = process.env.STORE_NAME        || 'GRILLSYNC GRILL HOUSE';
const STORE_ADDRESS     = process.env.STORE_ADDRESS     || '123 Rizal St., Calamba City';
const STORE_TEL         = process.env.STORE_TEL         || 'Tel: (049) 000-0000';

/**
 * Formats a peso amount: ₱1,234.00
 */
function peso(amount) {
  return `P${Number(amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
}

/**
 * Pads a string to `width` with spaces (left or right).
 */
function pad(str, width, right = false) {
  str = String(str);
  if (str.length >= width) return str.substring(0, width);
  const spaces = ' '.repeat(width - str.length);
  return right ? spaces + str : str + spaces;
}

/**
 * printOrderReceipt(order)
 * Prints a customer receipt for the given order object.
 *
 * @param {Object} order — Mongoose Order document (plain object OK)
 * @returns {Promise<void>}
 */
async function printOrderReceipt(order) {
  const printer = new ThermalPrinter({
    type:         PrinterTypes.EPSON,   // or PrinterTypes.STAR
    interface:    PRINTER_INTERFACE,
    characterSet: CharacterSet.PC852_LATIN2,
    removeSpecialCharacters: false,
    lineCharacter: '-',
    width: 42                            // Characters per line (58mm paper)
  });

  const isConnected = await printer.isPrinterConnected();
  if (!isConnected) {
    console.warn('[PRINTER] Printer not connected. Skipping receipt print.');
    return;
  }

  const line = '-'.repeat(42);
  const now  = new Date(order.placedAt || Date.now());
  const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: '2-digit' });
  const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true });

  // --- Header ---
  printer.alignCenter();
  printer.bold(true);
  printer.setTextSize(1, 1);
  printer.println(STORE_NAME);
  printer.bold(false);
  printer.setTextSize(0, 0);
  printer.println(STORE_ADDRESS);
  printer.println(STORE_TEL);
  printer.drawLine();

  // --- Order Info ---
  printer.alignLeft();
  printer.println(`Date   : ${dateStr}  ${timeStr}`);
  printer.println(`Order# : ${order.orderId}`);
  printer.bold(true);
  printer.setTextSize(1, 1);
  printer.alignCenter();
  printer.println(`CUSTOMER NO. ${String(order.customerNo).padStart(3, '0')}`);
  printer.setTextSize(0, 0);
  printer.bold(false);
  printer.drawLine();

  // --- Items ---
  printer.alignLeft();
  printer.bold(true);
  printer.println(`${pad('ITEM', 26)}${pad('QTY', 4, true)}${pad('TOTAL', 10, true)}`);
  printer.bold(false);
  printer.drawLine();

  for (const item of order.items) {
    // Main item line
    const itemName  = pad(item.name, 26);
    const itemQty   = pad(`x${item.quantity}`, 4, true);
    const itemTotal = pad(peso(item.lineTotal), 10, true);
    printer.println(`${itemName}${itemQty}${itemTotal}`);

    // Unit price if quantity > 1
    if (item.quantity > 1) {
      const unitLine = `  @ ${peso(item.basePrice)} ea.`;
      printer.println(unitLine);
    }

    // Add-ons
    for (const addon of (item.addOns || [])) {
      printer.println(`  + ${pad(addon.name, 22)}${pad('+' + peso(addon.price), 12, true)}`);
    }
  }

  printer.drawLine();

  // --- Totals ---
  printer.alignRight();
  printer.bold(true);
  printer.println(`TOTAL        ${peso(order.totalPrice)}`);
  printer.bold(false);

  if (order.cashReceived && order.cashReceived > 0) {
    printer.println(`CASH         ${peso(order.cashReceived)}`);
    printer.println(`CHANGE       ${peso(order.changeDue || 0)}`);
  }

  printer.drawLine();

  // --- Footer ---
  printer.alignCenter();
  printer.println('Present this receipt at the cashier.');
  printer.bold(true);
  printer.println('THANK YOU! ENJOY YOUR MEAL!');
  printer.bold(false);
  printer.println('');
  printer.println('');
  printer.cut();

  try {
    await printer.execute();
    console.log(`[PRINTER] Receipt printed for Order #${order.orderId}`);
  } catch (err) {
    console.error('[PRINTER] Print execute error:', err.message);
  }
}

module.exports = { printOrderReceipt };
