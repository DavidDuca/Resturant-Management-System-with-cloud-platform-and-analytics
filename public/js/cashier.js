/**
 * cashier.js — Jonel's Inasalan Cashier Dashboard
 * Analytics: Chart.js 4 — 5 interactive charts + linear regression forecast
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const socket = io();

  // ── Shared state ────────────────────────────────────────────────────────────
  let currentOrder  = null;
  let pendingOrders = [];
  let histPage = 1, histPages = 1, histDateFilter = '';
  let adminMenu = {}, adminActiveCat = 'grills', adminSelected = null, adminIsNew = false, adminDropFile = null;

  // Analytics state
  let analyticsRange = 30;      // active day range
  let analyticsData  = null;    // raw data from API
  let charts         = {};      // Chart.js instances keyed by canvas id

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const peso = v => `₱${Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
  const pesoK = v => v >= 1000 ? `₱${(v/1000).toFixed(1)}k` : `₱${Math.round(v)}`;

  // ── Clock ───────────────────────────────────────────────────────────────────
  setInterval(() => {
    $('clock').textContent = new Date().toLocaleTimeString('en-PH', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }, 1000);

  // ── Toast ───────────────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg, type = 'info') {
    clearTimeout(toastTimer);
    const icons  = { success:'fa-circle-check', error:'fa-circle-xmark', info:'fa-circle-info' };
    const colors = { success:'#2ECC71', error:'#E74C3C', info:'#4A9EFF' };
    $('toast').innerHTML = `<i class="fa-solid ${icons[type]||'fa-circle-info'}" style="color:${colors[type]||'#4A9EFF'}"></i> ${msg}`;
    $('toast').className = `toast show ${type}`;
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3500);
  }

  // ── Tab navigation ───────────────────────────────────────────────────────────
  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'analytics') loadAnalytics();
      if (btn.dataset.tab === 'admin')     loadAdminMenu();
      if (btn.dataset.tab === 'history')   loadHistory();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  POS TAB
  // ══════════════════════════════════════════════════════════════════════════
  $('lookup-input').addEventListener('keydown', e => { if (e.key === 'Enter') fetchOrder(); });
  $('btn-lookup').addEventListener('click', fetchOrder);

  async function fetchOrder() {
    const id = $('lookup-input').value.trim().toUpperCase();
    if (id.length !== 6) { showToast('Enter a valid 6-character Order ID.', 'error'); return; }
    $('btn-lookup').textContent = 'Loading...';
    try {
      const res  = await fetch(`/api/orders/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Order not found');
      displayOrder(data);
    } catch (err) {
      showToast(err.message, 'error'); resetOrderView();
    } finally { $('btn-lookup').textContent = 'Fetch'; }
  }

  function displayOrder(order) {
    currentOrder = order;
    const statusMap = { pending:'status-pending', paid:'status-paid', cancelled:'status-cancelled', preparing:'status-preparing', ready:'status-ready', completed:'status-completed' };
    const dt = new Date(order.placedAt).toLocaleString('en-PH', { dateStyle:'medium', timeStyle:'short' });
    const rows = order.items.map(item => `
      <tr>
        <td><div>${item.name}</div>${item.addOns.length ? `<div class="order-item-addons">+ ${item.addOns.map(a=>a.name).join(', ')}</div>` : ''}</td>
        <td>${item.quantity}</td><td>₱${item.basePrice.toFixed(2)}</td><td>₱${item.lineTotal.toFixed(2)}</td>
      </tr>`).join('');
    $('order-detail-area').innerHTML = `
      <div class="order-card">
        <div class="order-card-header">
          <div><div class="order-id-display">${order.orderId}</div><div class="order-meta">Customer No. ${String(order.customerNo).padStart(3,'0')} &bull; ${dt}</div></div>
          <span class="status-badge ${statusMap[order.status]||''}">${order.status.toUpperCase()}</span>
        </div>
        <table class="order-items-table">
          <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th style="text-align:right">Subtotal</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="order-card-footer"><span class="total-label">TOTAL</span><span class="total-amount">₱${order.totalPrice.toFixed(2)}</span></div>
      </div>`;
    $('pay-total').value = `₱${order.totalPrice.toFixed(2)}`;
    $('pay-cash').value = ''; $('pay-change').textContent = '₱0.00'; $('pay-change').style.color = '';
    $('btn-confirm').disabled = order.status !== 'pending';
    $('btn-cancel').disabled  = !['pending','paid'].includes(order.status);
    pendingOrders = pendingOrders.filter(o => o.orderId !== order.orderId);
    renderIncomingList();
  }

  function resetOrderView() {
    currentOrder = null;
    $('order-detail-area').innerHTML = `<div class="placeholder-msg"><i class="fa-regular fa-rectangle-list"></i><p>Enter the Order ID printed on the customer's receipt</p></div>`;
    $('pay-total').value = ''; $('pay-cash').value = '';
    $('pay-change').textContent = '₱0.00'; $('pay-change').style.color = '';
    $('btn-confirm').disabled = true; $('btn-cancel').disabled = true;
  }

  $('pay-cash').addEventListener('input', () => {
    if (!currentOrder) return;
    const c = parseFloat($('pay-cash').value) || 0;
    const change = c - currentOrder.totalPrice;
    $('pay-change').textContent = `₱${Math.max(0, change).toFixed(2)}`;
    $('pay-change').style.color = change >= 0 ? 'var(--green)' : 'var(--red)';
  });

  $('btn-confirm').addEventListener('click', async () => {
    if (!currentOrder) return;
    const cash = parseFloat($('pay-cash').value) || 0;
    if (cash < currentOrder.totalPrice) { showToast('Cash is less than total.', 'error'); return; }
    $('btn-confirm').disabled = true;
    $('btn-confirm').innerHTML = '<span class="spinner"></span> Processing...';
    try {
      const res  = await fetch(`/api/orders/${currentOrder.orderId}/pay`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ cashReceived: cash }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast(`Order ${currentOrder.orderId} confirmed.`, 'success');
      displayOrder(data.order);
    } catch (err) { showToast(err.message, 'error'); $('btn-confirm').disabled = false; }
    finally { $('btn-confirm').innerHTML = '<i class="fa-solid fa-check" style="margin-right:.4rem"></i>Confirm Payment'; }
  });

  $('btn-cancel').addEventListener('click', async () => {
    if (!currentOrder || !confirm(`Cancel Order #${currentOrder.orderId}?`)) return;
    try {
      const res = await fetch(`/api/orders/${currentOrder.orderId}/cancel`, { method:'PATCH' });
      if (!res.ok) throw new Error((await res.json()).error);
      showToast('Order cancelled.', 'info');
      resetOrderView(); $('lookup-input').value = '';
    } catch (err) { showToast(err.message, 'error'); }
  });

  function renderIncomingList() {
    const el = $('incoming-list');
    if (!pendingOrders.length) { el.innerHTML = `<div style="color:var(--muted);font-size:.8rem;padding:.5rem 0">No pending orders</div>`; return; }
    el.innerHTML = pendingOrders.map(o => `
      <div class="incoming-item" data-id="${o.orderId}">
        <div style="display:flex;justify-content:space-between">
          <div class="incoming-item-id">${o.orderId}</div>
          <div style="font-family:'IBM Plex Mono',monospace;color:var(--gold);font-size:.9rem">₱${o.totalPrice.toFixed(2)}</div>
        </div>
        <div class="incoming-item-meta">Cust. No. ${String(o.customerNo).padStart(3,'0')} &bull; ${o.items.length} item(s) &bull; ${new Date(o.placedAt).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'})}</div>
      </div>`).join('');
    el.querySelectorAll('.incoming-item').forEach(i => i.addEventListener('click', () => { $('lookup-input').value = i.dataset.id; fetchOrder(); }));
  }

  socket.on('order:new', o => {
    pendingOrders.unshift(o); if (pendingOrders.length > 20) pendingOrders.pop();
    renderIncomingList();
    showToast(`New order ${o.orderId} — Customer ${String(o.customerNo).padStart(3,'0')}`, 'info');
  });
  socket.on('order:statusUpdated', ({ orderId, status, order }) => {
    if (currentOrder && currentOrder.orderId === orderId) displayOrder(order);
    if (status !== 'pending') { pendingOrders = pendingOrders.filter(o => o.orderId !== orderId); renderIncomingList(); }
  });
  socket.on('order:cancelled', ({ orderId }) => { pendingOrders = pendingOrders.filter(o => o.orderId !== orderId); renderIncomingList(); });
  socket.on('menu:updated', ({ menu }) => { adminMenu = menu; renderAdminProductList(); });
  renderIncomingList();

  // ══════════════════════════════════════════════════════════════════════════
  //  HISTORY TAB
  // ══════════════════════════════════════════════════════════════════════════
  const todayLocal = new Date();
  todayLocal.setMinutes(todayLocal.getMinutes() - todayLocal.getTimezoneOffset());
  $('history-date').value = todayLocal.toISOString().slice(0, 10);

  $('history-date').addEventListener('change', () => {
    histDateFilter = $('history-date').value; histPage = 1; loadHistory();
  });
  $('btn-clear-date').addEventListener('click', () => {
    $('history-date').value = ''; histDateFilter = ''; histPage = 1; loadHistory();
  });
  $('hist-prev').addEventListener('click', () => { if (histPage > 1) { histPage--; loadHistory(); } });
  $('hist-next').addEventListener('click', () => { if (histPage < histPages) { histPage++; loadHistory(); } });

  async function loadHistory() {
    const tbody = $('history-tbody');
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2.5rem;color:var(--muted)"><span class="spinner"></span> Loading...</td></tr>`;
    try {
      let url = `/api/orders/history?page=${histPage}&limit=30`;
      if (histDateFilter) url += `&date=${encodeURIComponent(histDateFilter)}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      histPages = data.pages || 1;
      $('hist-page-info').textContent = `Page ${data.page} of ${histPages} — ${data.total} order(s)`;
      $('hist-prev').disabled = histPage <= 1;
      $('hist-next').disabled = histPage >= histPages;
      const income = data.orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.totalPrice, 0);
      $('history-summary').textContent = histDateFilter
        ? `${data.total} order(s) · ₱${income.toFixed(2)} income`
        : `${data.total} total order(s)`;
      if (!data.orders.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2.5rem;color:var(--muted)">No orders found${histDateFilter ? ' for '+histDateFilter : ''}</td></tr>`;
        return;
      }
      const sClr = { pending:'var(--gold)', paid:'var(--green)', cancelled:'var(--red)', preparing:'var(--accent)', ready:'var(--green)', completed:'var(--muted)' };
      tbody.innerHTML = data.orders.map(o => {
        const items = o.items.map(i => `${i.quantity}x ${i.name}`).join(', ');
        const dt    = new Date(o.placedAt).toLocaleString('en-PH', { month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:true });
        return `
          <tr data-orderid="${o.orderId}" title="Click to open in POS">
            <td class="mono" style="color:var(--accent);font-weight:600">${o.orderId}</td>
            <td class="mono">${String(o.customerNo).padStart(3,'0')}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${items}">${items}</td>
            <td class="mono" style="color:var(--gold)">₱${o.totalPrice.toFixed(2)}</td>
            <td style="color:${sClr[o.status]||'var(--muted)'};font-weight:600;text-transform:uppercase;font-size:.72rem">${o.status}</td>
            <td class="mono" style="color:var(--muted);font-size:.8rem">${dt}</td>
          </tr>`;
      }).join('');
      tbody.querySelectorAll('tr[data-orderid]').forEach(row => {
        row.addEventListener('click', () => {
          document.querySelector('[data-tab="pos"]').click();
          $('lookup-input').value = row.dataset.orderid;
          fetchOrder();
        });
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--red)">${err.message}</td></tr>`;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ANALYTICS TAB — Chart.js powered
  // ══════════════════════════════════════════════════════════════════════════

  // ── Chart.js global defaults ───────────────────────────────────────────────
  Chart.defaults.color           = '#6B7280';
  Chart.defaults.borderColor     = 'rgba(255,255,255,.06)';
  Chart.defaults.font.family     = 'IBM Plex Sans, sans-serif';
  Chart.defaults.font.size       = 11;
  Chart.defaults.plugins.tooltip.backgroundColor = '#222840';
  Chart.defaults.plugins.tooltip.borderColor     = 'rgba(255,255,255,.13)';
  Chart.defaults.plugins.tooltip.borderWidth     = 1;
  Chart.defaults.plugins.tooltip.padding         = 10;
  Chart.defaults.plugins.tooltip.titleColor      = '#E8EAF0';
  Chart.defaults.plugins.tooltip.bodyColor       = '#9CA3AF';
  Chart.defaults.plugins.legend.labels.color     = '#6B7280';
  Chart.defaults.plugins.legend.labels.boxWidth  = 12;

  const COLORS = {
    blue:   { line:'#4A9EFF', fill:'rgba(74,158,255,.15)' },
    green:  { line:'#2ECC71', fill:'rgba(46,204,113,.12)' },
    gold:   { line:'#F1C40F', fill:'rgba(241,196,15,.12)' },
    purple: { line:'#7C3AED', fill:'rgba(124,58,237,.15)' },
    orange: { line:'#F97316', fill:'rgba(249,115,22,.12)' },
    pink:   { line:'#EC4899', fill:'rgba(236,72,153,.12)' },
    red:    { line:'#E74C3C', fill:'rgba(231,76,60,.12)'  }
  };

  // ── Range selector ─────────────────────────────────────────────────────────
  document.querySelectorAll('.a-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.a-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      analyticsRange = parseInt(btn.dataset.range);
      loadAnalytics();
    });
  });

  $('btn-a-refresh').addEventListener('click', loadAnalytics);
  $('btn-forecast-refresh') && $('btn-forecast-refresh').addEventListener('click', loadAnalytics);

  // ── Chart type switcher ────────────────────────────────────────────────────
  document.querySelectorAll('.chart-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = document.querySelectorAll(`.chart-type-btn[data-chart="${btn.dataset.chart}"]`);
      group.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (analyticsData) switchChartType(btn.dataset.chart, btn.dataset.type);
    });
  });

  function switchChartType(chartId, newType) {
    const instance = charts[chartId];
    if (!instance) return;
    // For horizontal bar we use 'bar' with indexAxis: 'y'
    if (newType === 'horizontalBar') {
      instance.options.indexAxis = 'y';
      instance.config.type = 'bar';
    } else {
      instance.options.indexAxis = 'x';
      instance.config.type = newType;
    }
    instance.update('active');
  }

  // ── Destroy + recreate chart ──────────────────────────────────────────────
  function makeChart(id, config) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    const ctx = $(id);
    if (!ctx) return null;
    const instance = new Chart(ctx, config);
    charts[id] = instance;
    return instance;
  }

  // ── Fill sparse daily data so every day in range appears ──────────────────
  function fillDailyRange(data, days) {
    const map = {};
    data.forEach(d => { map[d.date] = d; });
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      result.push(map[key] || { date: key, total: 0, count: 0, avgOrder: 0 });
    }
    return result;
  }

  // ── Linear regression ──────────────────────────────────────────────────────
  function linearRegression(ys) {
    const n    = ys.length;
    if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
    const xs   = ys.map((_, i) => i);
    const mX   = xs.reduce((a,b) => a+b,0) / n;
    const mY   = ys.reduce((a,b) => a+b,0) / n;
    const num  = xs.reduce((s,x,i) => s + (x-mX)*(ys[i]-mY), 0);
    const den  = xs.reduce((s,x)   => s + (x-mX)**2, 0);
    const slope     = den === 0 ? 0 : num / den;
    const intercept = mY - slope * mX;
    // R² coefficient of determination
    const ssTot = ys.reduce((s,y) => s + (y-mY)**2, 0);
    const ssRes = ys.reduce((s,y,i) => { const yHat = intercept + slope*i; return s + (y-yHat)**2; }, 0);
    const r2    = ssTot === 0 ? 0 : 1 - ssRes/ssTot;
    return { slope, intercept, r2 };
  }

  // ── Category breakdown from bestsellers ────────────────────────────────────
  function categoryRevenue(bestsellers) {
    const cats = { grills:0, nonGrilled:0, drinks:0, sides:0 };
    bestsellers.forEach(b => { if (cats[b.category] !== undefined) cats[b.category] += b.totalRevenue; });
    return cats;
  }

  // ── Main load function ─────────────────────────────────────────────────────
  async function loadAnalytics() {
    $('btn-a-refresh').innerHTML = '<span class="spinner"></span>';
    try {
      const res = await fetch('/api/analytics/summary');
      if (!res.ok) throw new Error('Analytics fetch failed');
      analyticsData = await res.json();
      renderAnalytics(analyticsData);
    } catch (err) {
      showToast('Failed to load analytics.', 'error');
    } finally {
      $('btn-a-refresh').innerHTML = '<i class="fa-solid fa-rotate-right"></i> Refresh';
    }
  }

  function renderAnalytics(d) {
    // ── Fill daily data to full range ──────────────────────────────────────
    const daily = fillDailyRange(d.daily30 || [], analyticsRange);
    const labels = daily.map(r => {
      const dt = new Date(r.date + 'T00:00:00');
      return dt.toLocaleDateString('en-PH', { month:'short', day:'numeric' });
    });
    const revenueVals = daily.map(r => r.total);
    const orderVals   = daily.map(r => r.count);

    // ── KPI cards ──────────────────────────────────────────────────────────
    const periodTotal = revenueVals.reduce((a,b) => a+b, 0);
    const periodOrders = orderVals.reduce((a,b) => a+b, 0);
    const aov = periodOrders > 0 ? periodTotal / periodOrders : 0;

    $('kpi-today').textContent = peso(d.today.total);
    $('kpi-period').textContent = pesoK(periodTotal);
    $('kpi-period-sub').textContent = `${periodOrders} order(s) in ${analyticsRange} days`;
    $('kpi-aov').textContent = peso(aov);

    // Today vs yesterday trend
    const todayIdx     = daily.length - 1;
    const yesterdayRev = daily.length >= 2 ? daily[todayIdx - 1].total : 0;
    const todayRev     = d.today.total;
    const trendEl      = $('kpi-today-trend');
    if (yesterdayRev > 0) {
      const pct = ((todayRev - yesterdayRev) / yesterdayRev * 100).toFixed(1);
      trendEl.textContent  = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%`;
      trendEl.className    = `kpi-trend ${pct >= 0 ? 'up' : 'down'}`;
    } else {
      trendEl.textContent = 'No prev data'; trendEl.className = 'kpi-trend flat';
    }

    // Peak hour
    if (d.peakHour) {
      $('kpi-peak').textContent     = `${String(d.peakHour.hour).padStart(2,'0')}:00`;
      $('kpi-peak-sub').textContent = `₱${d.peakHour.total.toFixed(0)} · ${d.peakHour.count} orders`;
    } else {
      $('kpi-peak').textContent     = '—';
      $('kpi-peak-sub').textContent = 'No data today';
    }

    // ── Revenue Timeline Chart ─────────────────────────────────────────────
    $('rev-chart-sub').textContent = `Daily revenue — last ${analyticsRange} days`;
    makeChart('revenue-chart', {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Revenue',
          data: revenueVals,
          borderColor: COLORS.blue.line,
          backgroundColor: COLORS.blue.fill,
          fill: true,
          tension: 0.35,
          pointRadius: revenueVals.length > 20 ? 2 : 4,
          pointHoverRadius: 6,
          pointBackgroundColor: COLORS.blue.line,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: true, animation: { duration: 600 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${peso(ctx.raw)}`,
              afterLabel: ctx => {
                const o = orderVals[ctx.dataIndex];
                return o ? ` ${o} order(s)` : '';
              }
            }
          }
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
          y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { callback: v => pesoK(v) }, beginAtZero: true }
        }
      }
    });

    // ── Category Donut Chart ───────────────────────────────────────────────
    const catRev = categoryRevenue(d.bestsellers || []);
    makeChart('cat-chart', {
      type: 'doughnut',
      data: {
        labels: ['Grills', 'Non-Grilled', 'Drinks', 'Sides'],
        datasets: [{
          data: [catRev.grills, catRev.nonGrilled, catRev.drinks, catRev.sides],
          backgroundColor: [COLORS.orange.line, COLORS.purple ? COLORS.purple.line : '#7C3AED', COLORS.blue.line, COLORS.green.line],
          borderColor: '#1E2433', borderWidth: 3,
          hoverOffset: 8
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: true, cutout: '65%',
        animation: { animateRotate: true, duration: 700 },
        plugins: {
          legend: { position: 'bottom', labels: { padding: 12 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${peso(ctx.raw)}` } }
        }
      }
    });

    // ── Daily Order Count Chart ────────────────────────────────────────────
    makeChart('orders-chart', {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Orders',
          data: orderVals,
          backgroundColor: orderVals.map(v => v === 0 ? 'rgba(74,158,255,.08)' : COLORS.blue.fill),
          borderColor: COLORS.blue.line,
          borderWidth: 1.5, borderRadius: 4,
          hoverBackgroundColor: COLORS.blue.line
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: true, animation: { duration: 600 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ` ${ctx.raw} order(s)` } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
          y: { grid: { color: 'rgba(255,255,255,.04)' }, beginAtZero: true, ticks: { stepSize: 1 } }
        }
      }
    });

    // ── Hourly Today Chart ─────────────────────────────────────────────────
    const hourlyMap = {};
    (d.hourlyToday || []).forEach(h => { hourlyMap[h.hour] = h; });
    const hourLabels = Array.from({length:24}, (_, i) => `${String(i).padStart(2,'0')}:00`);
    const hourVals   = Array.from({length:24}, (_, i) => hourlyMap[i]?.total || 0);
    const peakIdx    = hourVals.indexOf(Math.max(...hourVals));

    makeChart('hourly-chart', {
      type: 'bar',
      data: {
        labels: hourLabels,
        datasets: [{
          label: 'Revenue',
          data: hourVals,
          backgroundColor: hourVals.map((v, i) =>
            i === peakIdx && v > 0 ? COLORS.gold.line : COLORS.green.fill
          ),
          borderColor: hourVals.map((v, i) =>
            i === peakIdx && v > 0 ? COLORS.gold.line : COLORS.green.line
          ),
          borderWidth: 1.5, borderRadius: 3,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: true, animation: { duration: 500 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${peso(ctx.raw)}`,
              afterLabel: ctx => {
                const h = hourlyMap[ctx.dataIndex];
                return h ? ` ${h.count} order(s)` : '';
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0 } },
          y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { callback: v => pesoK(v) }, beginAtZero: true }
        }
      }
    });

    // ── Bestsellers Bar Chart ──────────────────────────────────────────────
    const bs = d.bestsellers || [];
    const bsColors = [COLORS.gold.line, COLORS.orange.line, COLORS.blue.line, COLORS.green.line, COLORS.pink.line];
    makeChart('bs-chart', {
      type: 'bar',
      data: {
        labels: bs.map(b => b.name),
        datasets: [{
          label: 'Units Sold',
          data: bs.map(b => b.totalQty),
          backgroundColor: bs.map((_, i) => bsColors[i] + '33'),
          borderColor: bs.map((_, i) => bsColors[i]),
          borderWidth: 2, borderRadius: 5,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: true, animation: { duration: 700 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.raw} sold`,
              afterLabel: ctx => ` Revenue: ${peso(bs[ctx.dataIndex].totalRevenue)}`
            }
          }
        },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: 'rgba(255,255,255,.04)' }, beginAtZero: true, ticks: { stepSize: 1 } }
        }
      }
    });

    // ── Bestsellers detail list ────────────────────────────────────────────
    const maxQty = bs.length ? Math.max(...bs.map(b => b.totalQty)) : 1;
    const rankCls = ['gold','silver','bronze','',''];
    $('bs-list').innerHTML = bs.length === 0
      ? `<div style="padding:1.5rem;color:var(--muted);font-size:.82rem;text-align:center">No sales data for this period</div>`
      : bs.map((b, i) => `
          <div class="bs-item">
            <div class="bs-rank ${rankCls[i]||''}">#${i+1}</div>
            <div class="bs-bar-wrap">
              <div class="bs-name">${b.name}</div>
              <div class="bs-bar-track">
                <div class="bs-bar-fill" style="width:${(b.totalQty/maxQty*100).toFixed(1)}%;background:${bsColors[i]}"></div>
              </div>
              <div class="bs-meta">${b.category} &bull; avg ₱${(b.totalRevenue/b.totalQty).toFixed(0)} per unit</div>
            </div>
            <div class="bs-right">
              <div class="bs-qty">${b.totalQty}</div>
              <div class="bs-rev">${peso(b.totalRevenue)}</div>
            </div>
          </div>`).join('');

    // ── FORECASTING SECTION ────────────────────────────────────────────────
    // Use last 14 days (or all available) for regression
    const last14 = daily.slice(-14).filter(d => d.count > 0 || d.total > 0);
    const reg    = linearRegression(last14.map(d => d.total));

    // Project 7 future days
    const fDates = [], fVals = [], fLabels = [];
    for (let i = 1; i <= 7; i++) {
      const fd = new Date();
      fd.setDate(fd.getDate() + i);
      const projected = Math.max(0, reg.intercept + reg.slope * (last14.length - 1 + i));
      fDates.push(fd.toISOString().slice(0, 10));
      fVals.push(Math.round(projected));
      fLabels.push(fd.toLocaleDateString('en-PH', { month:'short', day:'numeric' }));
    }

    const fc7Total = fVals.reduce((a,b) => a+b, 0);
    $('fc-7d').textContent   = peso(fc7Total);
    $('fc-trend').textContent = reg.slope >= 0
      ? `▲ +${peso(reg.slope.toFixed(0))}/day`
      : `▼ ${peso(Math.abs(reg.slope).toFixed(0))}/day`;
    $('fc-trend').style.color = reg.slope >= 0 ? 'var(--green)' : 'var(--red)';
    const r2pct = (Math.max(0, Math.min(1, reg.r2)) * 100).toFixed(1);
    $('fc-r2').textContent   = `${r2pct}%`;
    $('fc-r2').style.color   = reg.r2 >= 0.7 ? 'var(--green)' : reg.r2 >= 0.4 ? 'var(--gold)' : 'var(--red)';

    // Combined actual + forecast chart
    const fActualLabels = last14.map(d => {
      const dt = new Date(d.date + 'T00:00:00');
      return dt.toLocaleDateString('en-PH', { month:'short', day:'numeric' });
    });
    const fActualVals = last14.map(d => d.total);

    makeChart('forecast-chart', {
      type: 'line',
      data: {
        labels: [...fActualLabels, ...fLabels],
        datasets: [
          {
            label: 'Actual Revenue',
            data: [...fActualVals, ...Array(fVals.length).fill(null)],
            borderColor: COLORS.purple.line,
            backgroundColor: COLORS.purple.fill,
            fill: true, tension: 0.3,
            pointRadius: 4, pointHoverRadius: 7,
            borderWidth: 2.5
          },
          {
            label: 'Projected Revenue',
            data: [...Array(fActualVals.length - 1).fill(null), fActualVals[fActualVals.length-1], ...fVals],
            borderColor: '#a78bfa',
            backgroundColor: 'rgba(167,139,250,.08)',
            borderDash: [6, 4],
            fill: true, tension: 0.3,
            pointRadius: 4, pointHoverRadius: 7,
            pointStyle: 'triangle',
            borderWidth: 2
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 800 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'top', labels: { color: '#9CA3AF', boxWidth: 20, padding: 16 } },
          tooltip: {
            callbacks: {
              label: ctx => ctx.raw !== null ? ` ${ctx.dataset.label}: ${peso(ctx.raw)}` : ''
            }
          }
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { maxRotation: 0 } },
          y: { grid: { color: 'rgba(255,255,255,.06)' }, ticks: { callback: v => pesoK(v) }, beginAtZero: false }
        }
      }
    });

    // Fix forecast-chart height after creation (Chart.js needs explicit px for non-aspect-ratio)
    const fcWrap = document.querySelector('.forecast-chart-wrap');
    if (fcWrap) fcWrap.style.height = '180px';
  }

  // expose for refresh button
  window.loadAnalytics = loadAnalytics;

  // ══════════════════════════════════════════════════════════════════════════
  //  ADMIN TAB
  // ══════════════════════════════════════════════════════════════════════════
  async function loadAdminMenu() {
    try {
      const res  = await fetch('/api/orders/menu');
      const data = await res.json();
      adminMenu  = data.menu;
      renderAdminProductList();
    } catch (e) { showToast('Failed to load menu.', 'error'); }
  }

  document.querySelectorAll('.admin-cat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-cat-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      adminActiveCat = tab.dataset.admincat;
      adminSelected  = null;
      renderAdminProductList();
      showAdminPlaceholder();
    });
  });

  $('btn-new-product').addEventListener('click', () => {
    adminIsNew = true; adminSelected = null; adminDropFile = null;
    renderAdminProductList();
    renderAdminForm(null);
  });

  function renderAdminProductList() {
    const list  = $('admin-product-list');
    const items = adminMenu[adminActiveCat] || [];
    if (!items.length) { list.innerHTML = `<div style="padding:1.2rem;text-align:center;color:var(--muted);font-size:.8rem">No products</div>`; return; }
    list.innerHTML = items.map(item => {
      const sel   = adminSelected && adminSelected.id === item.id;
      const imgH  = item.image ? `<img src="/assets/menu/${item.image}" onerror="this.style.display='none'" alt="">` : `<i class="fa-solid fa-image"></i>`;
      const stock = item.inStock === false ? `<span class="admin-product-stock stock-out">Out</span>` : `<span class="admin-product-stock stock-in">In Stock</span>`;
      return `
        <div class="admin-product-item ${sel?'selected':''}" data-id="${item.id}">
          <div class="admin-product-thumb">${imgH}</div>
          <div class="admin-product-info">
            <div class="admin-product-name">${item.name}</div>
            <div class="admin-product-price">₱${item.price.toFixed(2)} ${stock}</div>
          </div>
        </div>`;
    }).join('');
    list.querySelectorAll('.admin-product-item').forEach(el => {
      el.addEventListener('click', () => {
        adminSelected = items.find(i => i.id === el.dataset.id);
        adminIsNew = false; adminDropFile = null;
        renderAdminProductList(); renderAdminForm(adminSelected);
      });
    });
  }

  function showAdminPlaceholder() {
    $('admin-form-pane').innerHTML = `<div class="admin-form-placeholder"><i class="fa-solid fa-pen-to-square"></i><p>Select a product to edit, or click New</p></div>`;
  }

  function renderAdminForm(item) {
    const isNew = !item;
    $('admin-form-pane').innerHTML = `
      <div class="admin-form">
        <h3>${isNew ? 'Add New Product' : `Edit: ${item.name}`}</h3>
        ${isNew ? `<div class="form-row"><label>Category</label><select class="form-select" id="af-category">
          <option value="grills"     ${adminActiveCat==='grills'    ?'selected':''}>Grills</option>
          <option value="nonGrilled" ${adminActiveCat==='nonGrilled'?'selected':''}>Non-Grilled</option>
          <option value="drinks"     ${adminActiveCat==='drinks'    ?'selected':''}>Drinks</option>
          <option value="sides"      ${adminActiveCat==='sides'     ?'selected':''}>Sides</option>
        </select></div>` : ''}
        <div class="form-row"><label>Product Name</label><input type="text" class="form-input" id="af-name" value="${item?item.name:''}" placeholder="e.g. Chicken Inasal"></div>
        <div class="form-row"><label>Description</label><textarea class="form-textarea" id="af-desc" placeholder="Short description">${item?item.description||'':''}</textarea></div>
        <div class="form-row-2">
          <div class="form-row" style="margin:0"><label>Price (₱)</label><input type="number" class="form-input" id="af-price" value="${item?item.price:''}" placeholder="0.00" min="0" step="0.01"></div>
          <div class="form-row" style="margin:0;display:flex;flex-direction:column;justify-content:flex-end">
            <label>&nbsp;</label>
            <div class="form-check-row"><input type="checkbox" class="form-check" id="af-instock" ${(!item||item.inStock!==false)?'checked':''}><label for="af-instock">Available / In Stock</label></div>
          </div>
        </div>
        <div class="form-row"><label>Product Photo</label>
          <div class="drop-zone" id="af-dropzone">
            <input type="file" id="af-file" accept="image/jpeg,image/png,image/webp">
            ${item&&item.image?`<img src="/assets/menu/${item.image}" class="drop-zone-preview" id="af-preview" style="display:block">`:`<img class="drop-zone-preview" id="af-preview">`}
            <div class="drop-zone-icon" id="af-dz-icon" ${item&&item.image?'style="display:none"':''}><i class="fa-solid fa-cloud-arrow-up"></i></div>
            <div class="drop-zone-text" id="af-dz-text" ${item&&item.image?'style="display:none"':''}>Drag &amp; drop photo or click<br><span style="font-size:.72rem;color:var(--muted)">JPG, PNG, WebP · Max 5 MB</span></div>
          </div>
          <div style="font-size:.68rem;color:var(--muted);margin-top:.3rem">Auto-saved to <code style="color:var(--accent)">/public/assets/menu/</code> · updates kiosk live</div>
        </div>
        <div class="admin-form-actions">
          ${!isNew?`<button class="btn-delete" id="af-delete">Delete</button>`:''}
          <button class="btn-new-clear" id="af-cancel">${isNew?'Cancel':'Clear'}</button>
          <button class="btn-save" id="af-save">${isNew?'Add Product':'Save Changes'}</button>
        </div>
      </div>`;

    const dz = $('af-dropzone'), fi = $('af-file'), pv = $('af-preview'), icon = $('af-dz-icon'), txt = $('af-dz-text');
    function handleFile(f) {
      if (!f || !f.type.startsWith('image/')) return;
      adminDropFile = f;
      const r = new FileReader();
      r.onload = e => { pv.src = e.target.result; pv.style.display='block'; if(icon) icon.style.display='none'; if(txt) txt.style.display='none'; };
      r.readAsDataURL(f);
    }
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); handleFile(e.dataTransfer.files[0]); });
    fi.addEventListener('change', () => handleFile(fi.files[0]));
    $('af-save').addEventListener('click', () => isNew ? adminAdd() : adminSave(item));
    if ($('af-delete')) $('af-delete').addEventListener('click', () => adminDelete(item));
    $('af-cancel').addEventListener('click', () => { adminSelected=null; adminIsNew=false; adminDropFile=null; renderAdminProductList(); showAdminPlaceholder(); });
  }

  async function adminAdd() {
    const name = $('af-name').value.trim(), price = $('af-price').value.trim();
    const cat  = $('af-category') ? $('af-category').value : adminActiveCat;
    if (!name || !price) { showToast('Name and price are required.', 'error'); return; }
    const fd   = new FormData();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    fd.append('category', cat); fd.append('name', name); fd.append('description', $('af-desc').value.trim());
    fd.append('price', price); fd.append('imageFilename', `${cat[0]}xx-${slug}`);
    if (adminDropFile) fd.append('image', adminDropFile);
    try {
      const res  = await fetch('/api/orders/admin/products', { method:'POST', body:fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast(`"${name}" added.`, 'success');
      adminActiveCat = cat;
      document.querySelector(`[data-admincat="${cat}"]`).click();
      await loadAdminMenu(); showAdminPlaceholder();
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminSave(item) {
    const fd = new FormData();
    fd.append('name',        $('af-name').value.trim());
    fd.append('description', $('af-desc').value.trim());
    fd.append('price',       $('af-price').value.trim());
    fd.append('inStock',     $('af-instock').checked ? 'true' : 'false');
    if (adminDropFile) { fd.append('imageFilename', item.image ? item.image.replace(/\.[^.]+$/,'') : item.id); fd.append('image', adminDropFile); }
    try {
      const res  = await fetch(`/api/orders/admin/products/${item.id}`, { method:'PATCH', body:fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showToast(`"${data.item.name}" saved.`, 'success');
      await loadAdminMenu();
      adminSelected = (adminMenu[adminActiveCat]||[]).find(i => i.id === item.id) || null;
      renderAdminProductList();
      if (adminSelected) renderAdminForm(adminSelected);
    } catch (err) { showToast(err.message, 'error'); }
  }

  async function adminDelete(item) {
    if (!confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/orders/admin/products/${item.id}`, { method:'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error);
      showToast(`"${item.name}" deleted.`, 'info');
      adminSelected = null;
      await loadAdminMenu(); showAdminPlaceholder();
    } catch (err) { showToast(err.message, 'error'); }
  }

  // ── Resize charts on window resize ─────────────────────────────────────────
  window.addEventListener('resize', () => {
    Object.values(charts).forEach(c => c.resize());
  });

})();
