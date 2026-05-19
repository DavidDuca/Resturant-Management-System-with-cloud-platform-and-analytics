/**
 * kitchen.js — Jonel's Inasalan Kitchen Display
 * BUG FIXES:
 *  - On initial load, orders that are already "ready" for >5 min are excluded
 *    (server query uses readyAt >= cutoff, so they never arrive here)
 *  - readyAt is stored in the order object; timer is based on real readyAt,
 *    not "time since page load", so refresh doesn't reset the countdown
 *  - Server auto-completes after 5 min; client also hides locally as backup
 */

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const socket = io();

  // ── Area selection ─────────────────────────────────────────────────────────
  // Read ?area=grill or ?area=kitchen (default kitchen). Each dashboard only
  // shows orders whose items are routed to its station. Add window.__AREA__
  // override is also supported for tests.
  const AREA = (window.__AREA__
    || new URLSearchParams(location.search).get('area')
    || (document.body && document.body.dataset.area)
    || 'kitchen').toLowerCase() === 'grill' ? 'grill' : 'kitchen';
  const AREA_LABEL = AREA === 'grill' ? 'Grill' : 'Kitchen';
  // Update header label if a placeholder exists
  document.title = `Jonel's Inasalan — ${AREA_LABEL} Display`;
  const areaLabelEl = document.querySelector('[data-area-label]');
  if (areaLabelEl) areaLabelEl.textContent = `${AREA_LABEL} Display System`;

  // Filter an order's items down to lines routed to this area. Falls back to
  // category-based defaults so legacy orders keep showing up correctly.
  const CAT_FALLBACK_AREA = { grills: 'grill', sides: 'kitchen', drinks: 'kitchen', nonGrilled: 'kitchen' };
  function itemsForArea(order) {
    return (order.items || []).filter(it => {
      const a = it.cookingArea || CAT_FALLBACK_AREA[it.category] || 'kitchen';
      return a === AREA;
    });
  }

  // Read THIS station's status from the order. Falls back to the legacy
  // top-level status for orders saved before stations existed.
  function stationStatus(order) {
    const s = order && order.stations && order.stations[AREA];
    if (s && s.status) return s.status;
    // Legacy mapping
    if (order && order.status === 'paid')      return 'pending';
    if (order && order.status === 'preparing') return 'preparing';
    if (order && order.status === 'ready')     return 'ready';
    return 'pending';
  }
  function stationReadyAt(order) {
    const s = order && order.stations && order.stations[AREA];
    if (s && s.readyAt) return new Date(s.readyAt);
    if (order && order.readyAt) return new Date(order.readyAt);
    return null;
  }

  const READY_TTL_MS = 5 * 60 * 1000;
  // orderId → { order, timerId }
  const orders = new Map();
  const intervalIds = new Map(); // orderId / "ready-orderId" → setInterval id

  // ── Clock ──────────────────────────────────────────────────────────────────
  setInterval(() => {
    $('clock').textContent = new Date().toLocaleTimeString('en-PH', { hour12: false });
  }, 1000);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function clearIntervalById(key) {
    if (intervalIds.has(key)) {
      clearInterval(intervalIds.get(key));
      intervalIds.delete(key);
    }
  }

  function removeOrder(orderId) {
    orders.delete(orderId);
    clearIntervalById(orderId);
    clearIntervalById(`ready-${orderId}`);
    renderAll();
    updateCounters();
  }

  // ── Initial Load ───────────────────────────────────────────────────────────
  // The server already excludes orders where readyAt < (now - 5min),
  // so anything returned here is safe to display.
  async function loadActive() {
    try {
      const res  = await fetch(`/api/orders/kitchen/active?area=${AREA}`);
      const list = await res.json();
      list.forEach(order => {
        orders.set(order.orderId, { order, timerId: null });
      });
      renderAll();
      // Start timers for orders whose station is already in ready state
      orders.forEach(({ order }) => {
        const ra = stationReadyAt(order);
        if (stationStatus(order) === 'ready' && ra) {
          scheduleAutoRemove(order.orderId, ra);
          startReadyBar(order.orderId, ra);
        }
        if (order.paidAt) startElapsedTimer(order.orderId, new Date(order.paidAt));
      });
    } catch (e) {
      console.error('[KITCHEN] Load error:', e);
    }
  }

  // ── Schedule auto-remove based on real readyAt ────────────────────────────
  function scheduleAutoRemove(orderId, readyAt) {
    const entry = orders.get(orderId);
    if (!entry) return;
    if (entry.timerId) clearTimeout(entry.timerId);

    const elapsed   = Date.now() - readyAt.getTime();
    const remaining = Math.max(0, READY_TTL_MS - elapsed);

    entry.timerId = setTimeout(() => removeOrder(orderId), remaining);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderAll() {
    const grid = $('kitchen-grid');
    if (orders.size === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-fire-burner"></i>
          <p>No active orders</p>
        </div>`;
      updateCounters();
      return;
    }

    const statusOrder = { pending: 0, paid: 0, preparing: 1, ready: 2 };
    const sorted = [...orders.values()].sort((a, b) => {
      const sd = (statusOrder[stationStatus(a.order)] || 0) - (statusOrder[stationStatus(b.order)] || 0);
      if (sd !== 0) return sd;
      return new Date(a.order.paidAt) - new Date(b.order.paidAt);
    });

    grid.innerHTML = sorted.map(({ order }) => buildCardHtml(order)).join('');

    grid.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const { action, orderid } = btn.dataset;
        if (action === 'preparing' || action === 'ready') setStatus(orderid, action);
      });
    });

    // Card body click → open details modal (items + addons + quantity)
    grid.querySelectorAll('.order-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.orderid;
        const entry = orders.get(id);
        if (entry) openDetailModal(entry.order);
      });
    });

    // Re-attach ready bars
    orders.forEach(({ order }) => {
      const ra = stationReadyAt(order);
      if (stationStatus(order) === 'ready' && ra) {
        startReadyBar(order.orderId, ra);
      }
    });

    updateCounters();
  }

  function buildCardHtml(order) {
    const st          = stationStatus(order);
    const isPaid      = st === 'pending';
    const isPreparing = st === 'preparing';
    const isReady     = st === 'ready';

    const itemsCount = itemsForArea(order).reduce((n, it) => n + (it.quantity || 1), 0);
    const orderShort = String(order.orderId).slice(-6).toUpperCase();
    const custNo     = String(order.customerNo).padStart(3, '0');

    return `
      <div class="order-card" id="card-${order.orderId}" data-status="${st}" data-orderid="${order.orderId}">
        <div class="card-top">
          <div class="card-left">
            <div class="card-orderno">#${orderShort}</div>
            <div class="card-custno">Customer <b>${custNo}</b></div>
            <div class="card-items-count"><i class="fa-solid fa-bowl-food"></i> ${itemsCount} item${itemsCount === 1 ? '' : 's'}</div>
          </div>
          <div class="card-right">
            <div class="card-elapsed" id="elapsed-${order.orderId}">0:00</div>
            <div class="card-elapsed-label">Elapsed</div>
          </div>
        </div>
        ${isReady
          ? `<div class="ready-bar-wrap"><div class="ready-bar" id="readybar-${order.orderId}" style="width:100%"></div></div>`
          : ''}
        <div class="card-actions">
          <button class="btn-action btn-preparing ${isPreparing ? 'active' : ''}"
            data-action="preparing" data-orderid="${order.orderId}"
            ${isReady ? 'disabled' : ''}>
            <i class="fa-solid fa-fire"></i> Preparing
          </button>
          <button class="btn-action btn-ready ${isReady ? 'active' : ''}"
            data-action="ready" data-orderid="${order.orderId}"
            ${isPaid ? 'disabled' : ''}>
            <i class="fa-solid fa-bell"></i> Ready
          </button>
        </div>
      </div>`;
  }

  // ── Detail modal ──────────────────────────────────────────────────────────
  function openDetailModal(order) {
    const modal = document.getElementById('order-modal');
    if (!modal) return;
    const orderShort = String(order.orderId).slice(-6).toUpperCase();
    const custNo     = String(order.customerNo).padStart(3, '0');
    const placedAt   = new Date(order.paidAt || order.placedAt);
    const timeStr    = placedAt.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
    const st         = stationStatus(order);

    document.getElementById('modal-orderno').textContent = `Order #${orderShort}`;
    document.getElementById('modal-subtitle').textContent = `Customer ${custNo} · ${AREA_LABEL}`;
    document.getElementById('modal-time').textContent = timeStr;
    document.getElementById('modal-status').textContent = st.toUpperCase();
    // Sync the modal's top accent strip color to the order status (light-theme modal)
    const modalCard = document.getElementById('modal-card');
    if (modalCard) modalCard.setAttribute('data-status', st);

    const itemsHtml = itemsForArea(order).map(item => `
      <div class="modal-item">
        <div>
          <div class="modal-item-name">${item.name}</div>
          ${item.addOns && item.addOns.length
            ? `<div class="modal-item-addons">+ ${item.addOns.map(a => a.name).join(', ')}</div>`
            : ''}
        </div>
        <div class="modal-item-qty">×${item.quantity}</div>
      </div>`).join('') || '<div class="modal-item"><div class="modal-item-name" style="color:#5B6573">No items routed to this station.</div></div>';
    document.getElementById('modal-items').innerHTML = itemsHtml;

    modal.classList.add('open');
  }

  function closeDetailModal() {
    const modal = document.getElementById('order-modal');
    if (modal) modal.classList.remove('open');
  }
  function bindModalControls() {
    const closeBtn = document.getElementById('modal-close');
    const modal    = document.getElementById('order-modal');
    if (closeBtn) closeBtn.addEventListener('click', closeDetailModal);
    if (modal)    modal.addEventListener('click', (e) => { if (e.target === modal) closeDetailModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetailModal(); });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindModalControls);
  } else {
    bindModalControls();
  }

  // ── Elapsed timer ──────────────────────────────────────────────────────────
  function startElapsedTimer(orderId, paidAt) {
    if (intervalIds.has(orderId)) return;
    const tick = () => {
      const el = document.getElementById(`elapsed-${orderId}`);
      if (!el) return clearIntervalById(orderId);
      const secs = Math.floor((Date.now() - paidAt.getTime()) / 1000);
      el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    };
    tick();
    intervalIds.set(orderId, setInterval(tick, 1000));
  }

  // ── Ready bar — based on real readyAt, survives refresh ───────────────────
  function startReadyBar(orderId, readyAt) {
    const key = `ready-${orderId}`;
    if (intervalIds.has(key)) return; // already running
    const tick = () => {
      const barEl = document.getElementById(`readybar-${orderId}`);
      if (!barEl) return clearIntervalById(key);
      const elapsed = Date.now() - readyAt.getTime();
      const pct     = Math.max(0, 100 - (elapsed / READY_TTL_MS) * 100);
      barEl.style.width = `${pct}%`;
    };
    tick();
    intervalIds.set(key, setInterval(tick, 1000));
  }

  // ── Set status ─────────────────────────────────────────────────────────────
  // Always send our area so the server only mutates THIS station — the other
  // station is never touched by us. Each dashboard owns its own queue.
  function setStatus(orderId, status) {
    socket.emit('kitchen:updateStatus', { orderId, area: AREA, status });
  }

  // ── Socket events ──────────────────────────────────────────────────────────
  socket.on('order:paid', order => {
    // Smart routing: only show this order if it has items for our area.
    if (itemsForArea(order).length === 0) return;
    orders.set(order.orderId, { order, timerId: null });
    renderAll();
    setTimeout(() => startElapsedTimer(order.orderId, new Date(order.paidAt)), 50);
  });

  // Per-station updates (new) — only react if it's OUR area.
  socket.on('order:stationUpdated', ({ orderId, area, status, order }) => {
    if (area !== AREA) return; // another station — ignore for our queue
    if (status === 'completed') { removeOrder(orderId); return; }
    if (!orders.has(orderId)) {
      // First time we see it (e.g. legacy hydration) — add if relevant
      if (itemsForArea(order).length === 0) return;
      orders.set(orderId, { order, timerId: null });
    } else {
      orders.get(orderId).order = order;
    }
    if (status === 'ready') {
      const ra = stationReadyAt(order) || new Date();
      scheduleAutoRemove(orderId, ra);
      renderAll();
      setTimeout(() => startReadyBar(orderId, ra), 50);
    } else {
      renderAll();
      setTimeout(() => startElapsedTimer(orderId, new Date(order.paidAt)), 50);
    }
    updateCounters();
  });

  // Legacy event — kept for completed/cancelled overall transitions.
  socket.on('order:statusUpdated', ({ orderId, status, order }) => {
    if (status === 'completed' || status === 'cancelled') {
      removeOrder(orderId);
      return;
    }
    // Re-sync local copy if we already have it (lets us pick up the latest
    // hydrated stations map for re-renders).
    if (orders.has(orderId) && order) {
      orders.get(orderId).order = order;
      renderAll();
    }
  });

  socket.on('order:cancelled', ({ orderId }) => removeOrder(orderId));

  // ── Counters ───────────────────────────────────────────────────────────────
  function updateCounters() {
    let prep = 0, rdy = 0;
    orders.forEach(({ order }) => {
      const st = stationStatus(order);
      if (st === 'preparing') prep++;
      if (st === 'ready')     rdy++;
    });
    $('cnt-preparing').textContent = prep;
    $('cnt-ready').textContent     = rdy;
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  loadActive();
})();
