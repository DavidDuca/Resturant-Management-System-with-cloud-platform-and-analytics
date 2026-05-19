/**
 * kiosk.js — Jonel's Inasalan Customer Kiosk
 * Features:
 *  - Real-time menu updates via socket (menu:updated)
 *  - Out-of-stock items show overlay, cannot be added to cart
 *  - Add-ons only shown for grills category
 */
(function () {
  'use strict';

  let MENU         = {};
  let ADD_ONS      = [];
  let BESTSELLERS  = []; // [{itemId,name,price,image,category,totalQty,...}]
  let activeCategory = 'bestsellers';
  let cart         = [];
  let modalItem    = null;
  let modalQty     = 1;
  let modalAddOns  = [];

  const CAT_FA_ICON = {
    bestsellers: 'fa-star',
    grills:      'fa-fire-flame-curved',
    nonGrilled:  'fa-utensils',
    drinks:      'fa-glass-water',
    sides:       'fa-bowl-rice'
  };

  const $ = id => document.getElementById(id);
  const socket = io();

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const welcomeScreen  = $('welcome-screen');
  const app            = $('app');
  const btnStart       = $('btn-start');
  const menuGrid       = $('menu-grid');
  const catBtns        = document.querySelectorAll('.cat-btn');
  const modalOverlay   = $('modal-overlay');
  const modalItemName  = $('modal-item-name');
  const modalBasePrice = $('modal-base-price');
  const qtyMinus       = $('qty-minus');
  const qtyPlus        = $('qty-plus');
  const qtyDisplay     = $('qty-display');
  const addonList      = $('addon-list');
  const modalTotalEl   = $('modal-total');
  const btnAddCart     = $('btn-add-cart');
  const cartOverlay    = $('cart-overlay');
  const cartItemsEl    = $('cart-items');
  const cartTotalEl    = $('cart-total');
  const cartBadge      = $('cart-badge');
  const btnOpenCart    = $('btn-open-cart');
  const btnCloseCart   = $('btn-close-cart');
  const btnPlaceOrder  = $('btn-place-order');
  const successOverlay = $('success-overlay');
  const successOrderId = $('success-orderid');
  const successCustNo  = $('success-custno');
  const btnNewOrder    = $('btn-new-order');

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    try {
      const [menuRes, bestRes] = await Promise.all([
        fetch('/api/orders/menu'),
        fetch('/api/orders/bestsellers?limit=10').catch(() => null)
      ]);
      const data = await menuRes.json();
      MENU    = data.menu;
      ADD_ONS = data.addOns;
      if (bestRes && bestRes.ok) {
        const bd = await bestRes.json();
        BESTSELLERS = bd.items || [];
      }
      renderMenuGrid(activeCategory);
    } catch (e) {
      console.error('[KIOSK] Failed to load menu:', e);
    }
  }

  // Refresh bestsellers periodically (every 60s) to reflect new orders
  setInterval(async () => {
    try {
      const r = await fetch('/api/orders/bestsellers?limit=10');
      if (r.ok) { BESTSELLERS = (await r.json()).items || []; if (activeCategory === 'bestsellers') renderMenuGrid('bestsellers'); }
    } catch (_) {}
  }, 60000);

  socket.on('menu:updated', data => {
    MENU    = data.menu;
    ADD_ONS = data.addOns || ADD_ONS;
    renderMenuGrid(activeCategory);
  });

  btnStart.addEventListener('click', () => {
    welcomeScreen.classList.add('hidden');
    app.style.display = 'flex';
    app.style.flexDirection = 'column';
    app.style.height = '100%';
    setTimeout(() => welcomeScreen.style.display = 'none', 500);
  });

  catBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      catBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeCategory = btn.dataset.cat;
      renderMenuGrid(activeCategory);
    });
  });

  // Resolve list of items to render for the current category. For "bestsellers"
  // we use the dynamic ranking; for everything else we use MENU[category].
  function getItemsForCategory(category) {
    if (category === 'bestsellers') {
      // Hydrate against current MENU so we always have fresh price/image/inStock
      const all = Object.values(MENU).flat();
      return BESTSELLERS
        .map(b => {
          const live = all.find(m => m.id === b.itemId);
          return live ? { ...live, _sold: b.totalQty, _category: b.category } : null;
        })
        .filter(Boolean);
    }
    return MENU[category] || [];
  }

  function renderMenuGrid(category) {
    const items        = getItemsForCategory(category);
    const fallbackIcon = CAT_FA_ICON[category] || 'fa-utensils';

    menuGrid.innerHTML = items.map(item => {
      const outOfStock = item.inStock === false;
      const imgSrc     = `/assets/menu/${item.image || ''}`;

      return `
        <div class="item-card ${outOfStock ? 'out-of-stock' : ''}" data-id="${item.id}" data-oos="${outOfStock}">
          <div class="item-photo">
            ${item.image
              ? `<img src="${imgSrc}" alt="${item.name}" loading="lazy"
                   onload="this.classList.add('loaded')"
                   onerror="this.style.display='none'">`
              : ''}
            <div class="item-photo-fallback">
              <i class="fa-solid ${fallbackIcon}"></i>
              <span>Photo coming soon</span>
            </div>
            <div class="item-photo-price">₱${item.price.toFixed(2)}</div>
            ${outOfStock ? `
              <div class="oos-overlay">
                <i class="fa-solid fa-ban"></i>
                <span>Out of Stock</span>
              </div>` : ''}
          </div>
          <div class="item-body">
            <div class="item-name">${item.name}</div>
            <div class="item-desc">${item.description || ''}</div>
            ${outOfStock
              ? `<div class="oos-label">Currently unavailable</div>`
              : ''}
          </div>
        </div>`;
    }).join('');

    menuGrid.querySelectorAll('.item-card').forEach(card => {
      card.addEventListener('click', () => {
        if (card.dataset.oos === 'true') return; // block OOS items
        const item = items.find(i => i.id === card.dataset.id);
        if (item) openModal(item);
      });
    });
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  function openModal(item) {
    modalItem   = item;
    modalQty    = 1;
    modalAddOns = [];

    modalItemName.textContent  = item.name;
    modalBasePrice.textContent = `Base price: ₱${item.price.toFixed(2)}`;
    qtyDisplay.textContent     = '1';

    const addonSection = $('addon-section');
    const isGrillItem = (modalItem && (modalItem.cookingArea === 'grill')) || activeCategory === 'grills';
    if (isGrillItem) {
      addonSection.classList.add('visible');
      addonList.innerHTML = ADD_ONS.map(ao => `
        <div class="addon-item" data-id="${ao.id}">
          <div class="addon-left">
            <div class="addon-check"><i class="fa-solid fa-check"></i></div>
            <span class="addon-name">${ao.name}</span>
          </div>
          <span class="addon-price">${ao.price > 0 ? '+₱' + ao.price.toFixed(2) : 'Free'}</span>
        </div>`).join('');
      addonList.querySelectorAll('.addon-item').forEach(el => {
        el.addEventListener('click', () => toggleAddon(el.dataset.id, el));
      });
    } else {
      addonSection.classList.remove('visible');
      addonList.innerHTML = '';
    }

    updateModalTotal();
    modalOverlay.classList.add('open');
  }

  function closeModal() {
    modalOverlay.classList.remove('open');
    modalItem   = null;
    modalAddOns = [];
  }

  modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

  qtyMinus.addEventListener('click', () => {
    if (modalQty > 1) { modalQty--; qtyDisplay.textContent = modalQty; updateModalTotal(); }
  });
  qtyPlus.addEventListener('click', () => {
    if (modalQty < 20) { modalQty++; qtyDisplay.textContent = modalQty; updateModalTotal(); }
  });

  function toggleAddon(id, el) {
    const idx = modalAddOns.indexOf(id);
    if (idx === -1) { modalAddOns.push(id); el.classList.add('selected'); }
    else            { modalAddOns.splice(idx, 1); el.classList.remove('selected'); }
    updateModalTotal();
  }

  function updateModalTotal() {
    if (!modalItem) return;
    const addonTotal = modalAddOns.reduce((sum, id) => {
      const ao = ADD_ONS.find(a => a.id === id);
      return sum + (ao ? ao.price : 0);
    }, 0);
    modalTotalEl.textContent = `₱${((modalItem.price + addonTotal) * modalQty).toFixed(2)}`;
  }

  btnAddCart.addEventListener('click', () => {
    if (!modalItem) return;
    const selectedAddOns = modalAddOns.map(id => ADD_ONS.find(a => a.id === id)).filter(Boolean);
    const addonTotal     = selectedAddOns.reduce((s, a) => s + a.price, 0);
    cart.push({
      itemId: modalItem.id, name: modalItem.name, category: activeCategory,
      basePrice: modalItem.price, quantity: modalQty,
      addOns: selectedAddOns.map(ao => ({ id: ao.id, name: ao.name, price: ao.price })),
      lineTotal: (modalItem.price + addonTotal) * modalQty
    });
    updateCartBadge();
    closeModal();
    btnOpenCart.style.background = '#27ae60';
    setTimeout(() => btnOpenCart.style.background = '', 600);
  });

  // ── Cart ───────────────────────────────────────────────────────────────────
  function updateCartBadge() {
    cartBadge.textContent  = cart.reduce((s, i) => s + i.quantity, 0);
    btnPlaceOrder.disabled = cart.length === 0;
  }

  function renderCart() {
    if (cart.length === 0) {
      cartItemsEl.innerHTML = `
        <div class="cart-empty">
          <i class="fa-solid fa-basket-shopping"></i>
          <p>Your order is empty.<br>Pick something delicious!</p>
        </div>`;
      cartTotalEl.textContent = '₱0.00';
      btnPlaceOrder.disabled  = true;
      return;
    }
    const total = cart.reduce((s, i) => s + i.lineTotal, 0);
    cartTotalEl.textContent = `₱${total.toFixed(2)}`;
    cartItemsEl.innerHTML = cart.map((line, idx) => {
      const fa = CAT_FA_ICON[line.category] || 'fa-utensils';
      return `
        <div class="cart-line">
          <div class="cart-line-icon"><i class="fa-solid ${fa}"></i></div>
          <div class="cart-line-body">
            <div class="cart-line-name">${line.quantity > 1 ? `${line.quantity}x ` : ''}${line.name}</div>
            ${line.addOns.length ? `<div class="cart-line-addons">+ ${line.addOns.map(a => a.name).join(', ')}</div>` : ''}
          </div>
          <div class="cart-line-price">₱${line.lineTotal.toFixed(2)}</div>
          <button class="btn-remove-line" data-idx="${idx}"><i class="fa-solid fa-trash"></i></button>
        </div>`;
    }).join('');
    cartItemsEl.querySelectorAll('.btn-remove-line').forEach(btn => {
      btn.addEventListener('click', () => {
        cart.splice(parseInt(btn.dataset.idx, 10), 1);
        updateCartBadge(); renderCart();
      });
    });
  }

  btnOpenCart.addEventListener('click', () => { renderCart(); cartOverlay.classList.add('open'); });
  btnCloseCart.addEventListener('click', () => cartOverlay.classList.remove('open'));
  cartOverlay.addEventListener('click', e => { if (e.target === cartOverlay) cartOverlay.classList.remove('open'); });

  // ── Place Order ────────────────────────────────────────────────────────────
  btnPlaceOrder.addEventListener('click', async () => {
    if (cart.length === 0) return;
    btnPlaceOrder.disabled  = true;
    btnPlaceOrder.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Placing Order...';
    try {
      const res  = await fetch('/api/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: cart.map(l => ({ itemId: l.itemId, quantity: l.quantity, addOns: l.addOns.map(a => ({ id: a.id })) })) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to place order');
      successOrderId.textContent = data.orderId;
      successCustNo.textContent  = String(data.customerNo).padStart(3, '0');
      cartOverlay.classList.remove('open');
      successOverlay.classList.add('open');
      cart = []; updateCartBadge();
    } catch (err) {
      alert('Could not place order. Please try again or see staff.');
      btnPlaceOrder.disabled  = false;
      btnPlaceOrder.innerHTML = '<i class="fa-solid fa-check" style="margin-right:.5rem"></i>Place Order';
    }
  });

  btnNewOrder.addEventListener('click', () => {
    successOverlay.classList.remove('open');
    welcomeScreen.style.display = '';
    app.style.display = 'none';
    setTimeout(() => welcomeScreen.classList.remove('hidden'), 50);
    activeCategory = 'grills';
    catBtns.forEach(b => b.classList.remove('active'));
    document.querySelector('[data-cat="grills"]').classList.add('active');
    renderMenuGrid('grills');
    btnPlaceOrder.innerHTML = '<i class="fa-solid fa-check" style="margin-right:.5rem"></i>Place Order';
  });

  init();
})();
