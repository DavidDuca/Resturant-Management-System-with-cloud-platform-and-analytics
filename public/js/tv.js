/**
 * tv.js — Jonel's Inasalan Customer TV Display
 *
 * Renders Preparing / Ready columns for ONE station (grill or kitchen),
 * decided by which column IDs are present in the DOM:
 *   tv.html          → list-grill-prep / list-grill-ready  → 'grill'
 *   nongrilledTv.html → list-kit-prep   / list-kit-ready    → 'kitchen'
 *
 * Voice: automatically announces when an order becomes ready (no button).
 * Voice unlocks itself on any first user interaction if the browser blocks
 * autoplay. window.VOICE_ENABLED = true is honored as an auto-on flag.
 */

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const socket = io();

  const AREAS = ['grill', 'kitchen'];
  const READY_TTL_MS = 5 * 60 * 1000;

  const HAS_GRILL_COLS   = !!document.getElementById('list-grill-prep');
  const HAS_KITCHEN_COLS = !!document.getElementById('list-kit-prep');
  const DISPLAY_AREAS = (HAS_GRILL_COLS && HAS_KITCHEN_COLS)
    ? ['grill', 'kitchen']
    : (HAS_GRILL_COLS ? ['grill'] : ['kitchen']);

  const orders = new Map(); // orderId → order

  // ── Voice announcements (auto-enabled) ─────────────────────────────────────
  const announced = new Set();
  let voice = null;
  const speechQueue = [];
  let speaking = false;

  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    return voices.find(v => /en[-_]/i.test(v.lang)) || voices[0] || null;
  }
  if ('speechSynthesis' in window) {
    voice = pickVoice();
    window.speechSynthesis.onvoiceschanged = () => { voice = pickVoice(); };
  }

  function processQueue() {
    if (speaking || speechQueue.length === 0) return;
    if (!('speechSynthesis' in window)) return;
    const text = speechQueue.shift();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = 0.95; u.pitch = 1.0; u.volume = 1.0;
    u.onend   = () => { speaking = false; processQueue(); };
    u.onerror = () => { speaking = false; processQueue(); };
    speaking = true;
    window.speechSynthesis.speak(u);
  }

  function announce(text) {
    if (!('speechSynthesis' in window)) return;
    // Always queue; auto-enabled by tv.html/nongrilledTv.html.
    speechQueue.push(text);
    processQueue();
  }

  function displayReady(order) {
    if (!order) return false;
    const stations = order.stations || {};
    const relevant = DISPLAY_AREAS.filter(a => stations[a]);
    if (relevant.length === 0) return order.status === 'ready';
    return relevant.every(a => stations[a] && stations[a].status === 'ready');
  }

  function maybeAnnounce(order) {
    if (!order) return;
    if (announced.has(order.orderId)) return;
    if (!displayReady(order)) return;
    announced.add(order.orderId);
    const num = String(order.customerNo).padStart(3, '0');
    announce(`Attention. Customer number ${num}, your order is now ready for pick up.`);
  }

  // ── Clock ──────────────────────────────────────────────────────────────────
  setInterval(() => {
    const el = $('tv-clock');
    if (!el) return;
    el.textContent = new Date().toLocaleTimeString('en-PH', {
      hour: '2-digit', minute: '2-digit', hour12: true
    });
  }, 1000);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function stationOf(order, area) {
    return order && order.stations && order.stations[area];
  }
  function stationVisible(order, area, wantStatus) {
    const s = stationOf(order, area);
    if (!s || s.status !== wantStatus) return false;
    if (wantStatus !== 'ready') return true;
    if (!s.readyAt) return true;
    return (Date.now() - new Date(s.readyAt).getTime()) <= READY_TTL_MS;
  }

  // ── Initial load ───────────────────────────────────────────────────────────
  async function loadDisplay() {
    try {
      const res  = await fetch('/api/orders/tv/display');
      const list = await res.json();
      list.forEach(o => {
        orders.set(o.orderId, o);
        // Seed announced so existing ready orders don't blast on reload.
        if (displayReady(o)) announced.add(o.orderId);
      });
      renderAll();
    } catch (e) {
      console.error('[TV] Load error:', e);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function tileHtml(o) {
    const num = String(o.customerNo).padStart(3, '0');
    return `
      <div class="order-tile" data-orderid="${o.orderId}">
        <div class="tile-label">Customer</div>
        <div class="tile-custno-big">${num}</div>
      </div>`;
  }

  function renderColumn(listId, list, emptyHtml) {
    const el = $(listId);
    if (!el) return;
    if (list.length === 0) {
      el.innerHTML = emptyHtml;
      return;
    }
    el.innerHTML = list.map(tileHtml).join('');
  }

  function renderAll() {
    const byNewest = (a, b) => new Date(b.paidAt || 0) - new Date(a.paidAt || 0);
    const all = [...orders.values()].sort(byNewest);

    const buckets = {
      'grill:preparing':   [],
      'grill:ready':       [],
      'kitchen:preparing': [],
      'kitchen:ready':     []
    };
    for (const o of all) {
      for (const area of AREAS) {
        for (const st of ['preparing', 'ready']) {
          if (stationVisible(o, area, st)) buckets[`${area}:${st}`].push(o);
        }
      }
    }

    const emptyPrep  = `<div class="empty-col"><div class="empty-icon">⏳</div><span>No orders preparing</span></div>`;
    const emptyReady = `<div class="empty-col"><div class="empty-icon">🛎</div><span>No orders ready yet</span></div>`;

    renderColumn('list-grill-prep',  buckets['grill:preparing'],  emptyPrep);
    renderColumn('list-grill-ready', buckets['grill:ready'],      emptyReady);
    renderColumn('list-kit-prep',    buckets['kitchen:preparing'], emptyPrep);
    renderColumn('list-kit-ready',   buckets['kitchen:ready'],     emptyReady);

    const setCount = (id, n) => { const e = $(id); if (e) e.textContent = n; };
    setCount('cnt-grill-prep',  buckets['grill:preparing'].length);
    setCount('cnt-grill-ready', buckets['grill:ready'].length);
    setCount('cnt-kit-prep',    buckets['kitchen:preparing'].length);
    setCount('cnt-kit-ready',   buckets['kitchen:ready'].length);
  }

  // ── Realtime ───────────────────────────────────────────────────────────────
  function ingest(order) {
    if (!order) return;
    if (order.status === 'completed' || order.status === 'cancelled') {
      orders.delete(order.orderId);
      announced.delete(order.orderId);
      return;
    }
    orders.set(order.orderId, order);
    maybeAnnounce(order);
  }

  socket.on('order:stationUpdated', ({ order }) => { ingest(order); renderAll(); });
  socket.on('order:statusUpdated', ({ orderId, status, order }) => {
    if (status === 'completed' || status === 'cancelled') {
      orders.delete(orderId); announced.delete(orderId);
    } else if (order) {
      ingest(order);
    }
    renderAll();
  });
  socket.on('order:cancelled', ({ orderId }) => {
    orders.delete(orderId); announced.delete(orderId); renderAll();
  });

  setInterval(renderAll, 30 * 1000);
  loadDisplay();
})();
