/*
 * TuzataMan biznes mantiqi (buyurtma, komissiya, usta hamyoni).
 * Bitta fayl ham serverda (Node), ham brauzerdagi demo rejimda ishlaydi,
 * shuning uchun qoidalar ikki joyda farq qilib qolmaydi.
 *
 * db obyekti: { users:{}, masters:{}, orders:{}, ledger:[], withdrawals:{}, seq:1 }
 * Har bir amal { ok, error?, data?, notify:[...] } qaytaradi.
 * notify — kimga qanday xabar yuborish kerakligi (server uni Telegramga jo'natadi).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TzCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUS = {
    new: 'Usta qidirilmoqda',
    accepted: 'Usta yo\'lda',
    arrived: 'Usta yetib keldi',
    done: 'Tasdiqlashingiz kutilmoqda',
    confirmed: 'Yakunlandi',
    cancelled: 'Bekor qilindi',
  };

  function emptyDb() {
    return { users: {}, masters: {}, orders: {}, ledger: [], withdrawals: {}, seq: 1 };
  }

  function nextId(db, prefix) {
    db.seq = (db.seq || 1) + 1;
    return prefix + String(db.seq).padStart(5, '0');
  }

  function fmt(n) {
    return Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ') + ' so\'m';
  }

  function findService(catalog, serviceId) {
    for (const c of catalog.categories) {
      const s = c.services.find((x) => x.id === serviceId);
      if (s) return { category: c, service: s };
    }
    return null;
  }

  function ensureUser(db, tgUser) {
    const id = String(tgUser.id);
    let u = db.users[id];
    if (!u) {
      u = db.users[id] = {
        id, firstName: tgUser.first_name || '', lastName: tgUser.last_name || '',
        username: tgUser.username || '', phone: '', phoneVerified: false,
        addresses: [], cards: [], createdAt: Date.now(),
      };
    } else {
      u.firstName = tgUser.first_name || u.firstName;
      u.lastName = tgUser.last_name || u.lastName;
      u.username = tgUser.username || u.username;
    }
    return u;
  }

  function setPhone(db, userId, phone, verified) {
    const u = db.users[String(userId)];
    if (!u) return { ok: false, error: 'Foydalanuvchi topilmadi' };
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 9) return { ok: false, error: 'Telefon raqami noto\'g\'ri' };
    u.phone = '+' + (digits.length === 9 ? '998' + digits : digits);
    // Telegram kontakt orqali kelgan raqam "tasdiqlangan" hisoblanadi, qo'lda yozilgani emas
    u.phoneVerified = !!verified || (u.phoneVerified && u.phone === u._verifiedPhone);
    if (verified) u._verifiedPhone = u.phone;
    return { ok: true, data: u, notify: [] };
  }

  function saveAddress(db, userId, addr) {
    const u = db.users[String(userId)];
    if (!u) return { ok: false, error: 'Foydalanuvchi topilmadi' };
    if (!addr || !addr.text) return { ok: false, error: 'Manzil kiritilmagan' };
    const clean = {
      id: addr.id || nextId(db, 'A'),
      tag: addr.tag || 'Uy', text: String(addr.text).slice(0, 300),
      district: addr.district || '', lat: addr.lat || null, lng: addr.lng || null,
      entrance: addr.entrance || '', floor: addr.floor || '', apt: addr.apt || '',
      intercom: addr.intercom || '', comment: String(addr.comment || '').slice(0, 300),
    };
    const i = u.addresses.findIndex((a) => a.id === clean.id);
    if (i >= 0) u.addresses[i] = clean; else u.addresses.push(clean);
    return { ok: true, data: clean, notify: [] };
  }

  function deleteAddress(db, userId, addrId) {
    const u = db.users[String(userId)];
    if (!u) return { ok: false, error: 'Foydalanuvchi topilmadi' };
    u.addresses = u.addresses.filter((a) => a.id !== addrId);
    return { ok: true, notify: [] };
  }

  function addressLine(a) {
    const parts = [a.text];
    if (a.entrance) parts.push(a.entrance + '-podyezd');
    if (a.floor) parts.push(a.floor + '-qavat');
    if (a.apt) parts.push(a.apt + '-xonadon');
    if (a.intercom) parts.push('domofon: ' + a.intercom);
    return parts.join(', ');
  }

  function timeLabel(t) {
    if (!t || t.type === 'urgent') return 'Shoshilinch (45–60 daqiqada)';
    return [t.day, t.slot].filter(Boolean).join(', ');
  }

  async function createOrder(db, catalog, payments, userId, p) {
    const u = db.users[String(userId)];
    if (!u) return { ok: false, error: 'Avval tizimga kiring' };
    if (!p || !Array.isArray(p.items) || !p.items.length) return { ok: false, error: 'Xizmat tanlanmagan' };
    if (!p.address || !p.address.text) return { ok: false, error: 'Manzilni kiriting' };
    const phone = p.phone || u.phone;
    if (!phone) return { ok: false, error: 'Telefon raqamini kiriting' };

    // Narxni server o'zi katalogdan hisoblaydi, mijoz yuborgan narxga ishonmaydi
    const items = [];
    const cats = new Set();
    for (const it of p.items) {
      const f = findService(catalog, it.serviceId);
      const qty = Math.max(1, Math.min(20, parseInt(it.qty, 10) || 1));
      if (!f) return { ok: false, error: 'Noma\'lum xizmat: ' + it.serviceId };
      cats.add(f.category.id);
      items.push({ serviceId: f.service.id, name: f.service.name, price: f.service.price, qty, categoryId: f.category.id });
    }
    const urgent = !p.time || p.time.type === 'urgent';
    const subtotal = items.reduce((s, x) => s + x.price * x.qty, 0);
    const urgentFee = urgent && subtotal > 0 ? (catalog.urgentFee || 0) : 0;
    const total = subtotal + urgentFee;
    const commission = Math.round(total * catalog.commissionPercent / 100);

    const method = p.payment && p.payment.method === 'card' ? 'card' : 'cash';
    const order = {
      id: nextId(db, 'T'), clientId: u.id, items, categories: [...cats],
      subtotal, urgentFee, total, commission,
      address: Object.assign({}, p.address), phone,
      time: urgent ? { type: 'urgent' } : { type: 'scheduled', day: p.time.day || '', slot: p.time.slot || '' },
      comment: String(p.comment || '').slice(0, 500),
      payment: { method, cardId: null, holdId: null, status: method === 'card' ? 'pending' : 'cash' },
      status: 'new', masterId: null, rating: null,
      createdAt: Date.now(), history: [{ s: 'new', at: Date.now() }],
    };

    if (method === 'card') {
      const card = u.cards.find((c) => c.id === (p.payment.cardId || (u.cards[0] && u.cards[0].id)));
      if (!card) return { ok: false, error: 'Karta ulanmagan' };
      // Pul yechilmaydi, faqat muzlatiladi (hold). Ish tasdiqlangach yechiladi.
      if (total > 0) {
        const h = await payments.hold(card, total, order.id);
        if (!h.ok) return { ok: false, error: 'Kartadan to\'lovni muzlatib bo\'lmadi: ' + (h.error || '') };
        order.payment.holdId = h.holdId;
        order.payment.status = 'held';
      }
      order.payment.cardId = card.id;
      order.payment.cardMask = card.mask;
    }

    db.orders[order.id] = order;
    const notify = [{ to: 'admin', type: 'order_new', orderId: order.id }];
    for (const m of matchingMasters(db, order)) notify.push({ to: m.userId, type: 'order_offer', orderId: order.id });
    return { ok: true, data: order, notify };
  }

  function matchingMasters(db, order) {
    const district = order.address.district;
    return Object.values(db.masters).filter((m) =>
      m.status === 'active' &&
      order.categories.some((c) => m.specialties.includes(c)) &&
      (!district || !m.districts.length || m.districts.includes(district)));
  }

  function addLedger(db, masterId, type, amount, orderId, note) {
    db.ledger.push({ masterId, type, amount, orderId: orderId || null, note: note || '', at: Date.now() });
  }

  function masterWallet(db, catalog, masterId) {
    const m = db.masters[String(masterId)];
    if (!m) return null;
    const reserve = catalog.masterReserve;
    return {
      balance: m.balance, reserve,
      available: Math.max(0, m.balance - reserve),
      pendingWithdraw: Object.values(db.withdrawals).filter((w) => w.masterId === m.userId && w.status === 'pending').reduce((s, w) => s + w.amount, 0),
    };
  }

  function registerMaster(db, userId, p) {
    const u = db.users[String(userId)];
    if (!u) return { ok: false, error: 'Avval tizimga kiring' };
    if (!p.name || !p.specialties || !p.specialties.length) return { ok: false, error: 'Ism va mutaxassislikni kiriting' };
    const existing = db.masters[u.id];
    db.masters[u.id] = Object.assign(existing || { userId: u.id, balance: 0, jobs: 0, ratingSum: 0, ratingCount: 0, status: 'pending', createdAt: Date.now() }, {
      name: String(p.name).slice(0, 80), phone: p.phone || u.phone,
      specialties: p.specialties, districts: p.districts || [],
    });
    return { ok: true, data: db.masters[u.id], notify: existing ? [] : [{ to: 'admin', type: 'master_new', masterId: u.id }] };
  }

  function approveMaster(db, catalog, masterId, welcomeBonus) {
    const m = db.masters[String(masterId)];
    if (!m) return { ok: false, error: 'Usta topilmadi' };
    if (m.status === 'active') return { ok: false, error: 'Usta allaqachon faol' };
    m.status = 'active';
    // Yangi ustaga birinchi naqd buyurtma komissiyasini qoplash uchun bonus
    if (welcomeBonus > 0) { m.balance += welcomeBonus; addLedger(db, m.userId, 'bonus', welcomeBonus, null, 'Xush kelibsiz bonusi'); }
    return { ok: true, data: m, notify: [{ to: m.userId, type: 'master_approved' }] };
  }

  function acceptOrder(db, catalog, masterId, orderId) {
    const m = db.masters[String(masterId)];
    const o = db.orders[orderId];
    if (!m || m.status !== 'active') return { ok: false, error: 'Siz faol usta emassiz' };
    if (!o) return { ok: false, error: 'Buyurtma topilmadi' };
    if (o.status !== 'new') return { ok: false, error: 'Bu buyurtmani boshqa usta oldi' };
    if (!o.categories.some((c) => m.specialties.includes(c))) return { ok: false, error: 'Bu buyurtma sizning yo\'nalishingizda emas' };
    if (o.payment.method === 'cash') {
      // Naqd to'lovda komissiya ustaning balansidan oldindan yechiladi (Yandex modeli)
      if (m.balance < o.commission) return { ok: false, error: 'Balansingiz yetarli emas. Komissiya: ' + fmt(o.commission) + ', balans: ' + fmt(m.balance) };
      m.balance -= o.commission;
      addLedger(db, m.userId, 'commission', -o.commission, o.id, 'Naqd buyurtma komissiyasi');
    }
    o.status = 'accepted'; o.masterId = m.userId; o.history.push({ s: 'accepted', at: Date.now() });
    return { ok: true, data: o, notify: [{ to: o.clientId, type: 'client_status', orderId: o.id }, { to: 'admin', type: 'order_status', orderId: o.id }] };
  }

  function masterArrived(db, masterId, orderId) {
    const o = db.orders[orderId];
    if (!o || o.masterId !== String(masterId)) return { ok: false, error: 'Buyurtma sizga tegishli emas' };
    if (o.status !== 'accepted') return { ok: false, error: 'Holat noto\'g\'ri' };
    o.status = 'arrived'; o.history.push({ s: 'arrived', at: Date.now() });
    return { ok: true, data: o, notify: [{ to: o.clientId, type: 'client_status', orderId: o.id }] };
  }

  function masterDone(db, masterId, orderId, finalTotal) {
    const o = db.orders[orderId];
    if (!o || o.masterId !== String(masterId)) return { ok: false, error: 'Buyurtma sizga tegishli emas' };
    if (!['accepted', 'arrived'].includes(o.status)) return { ok: false, error: 'Holat noto\'g\'ri' };
    // To'liq ta'mirda (smeta) yakuniy narxni usta kiritadi, mijoz tasdiqlaydi
    if (o.total === 0 && finalTotal > 0) o.proposedTotal = Math.round(finalTotal);
    o.status = 'done'; o.history.push({ s: 'done', at: Date.now() });
    return { ok: true, data: o, notify: [{ to: o.clientId, type: 'client_confirm', orderId: o.id }] };
  }

  async function clientConfirm(db, catalog, payments, userId, orderId, rating) {
    const o = db.orders[orderId];
    if (!o || o.clientId !== String(userId)) return { ok: false, error: 'Buyurtma topilmadi' };
    if (o.status !== 'done') return { ok: false, error: 'Usta hali ishni yakunlamagan' };
    const m = db.masters[o.masterId];
    if (o.proposedTotal) {
      o.total = o.proposedTotal;
      o.commission = Math.round(o.total * catalog.commissionPercent / 100);
    }
    if (o.payment.method === 'card') {
      // Avto-split: kartadan yechiladi, komissiya kompaniyaga, qolgani usta hamyoniga
      const r = o.payment.holdId
        ? await payments.capture(o.payment.holdId, o.total)
        : await payments.charge(db.users[o.clientId].cards.find((c) => c.id === o.payment.cardId), o.total, o.id);
      if (!r.ok) return { ok: false, error: 'Kartadan yechib bo\'lmadi: ' + (r.error || '') };
      o.payment.status = 'captured';
      const share = o.total - o.commission;
      m.balance += share;
      addLedger(db, m.userId, 'earning', share, o.id, 'Karta orqali to\'lov (komissiya ' + catalog.commissionPercent + '% ushlandi)');
    } else if (o.proposedTotal) {
      // Smeta bo'yicha naqd ish: komissiya ish tasdiqlangach yechiladi (balans manfiy bo'lishi mumkin)
      m.balance -= o.commission;
      addLedger(db, m.userId, 'commission', -o.commission, o.id, 'Smeta bo\'yicha ish komissiyasi');
    }
    o.status = 'confirmed'; o.history.push({ s: 'confirmed', at: Date.now() });
    m.jobs += 1;
    if (rating >= 1 && rating <= 5) { o.rating = rating; m.ratingSum += rating; m.ratingCount += 1; }
    return { ok: true, data: o, notify: [{ to: m.userId, type: 'master_paid', orderId: o.id }, { to: 'admin', type: 'order_status', orderId: o.id }] };
  }

  async function cancelOrder(db, catalog, payments, actor, orderId, reason) {
    // actor: { role: 'client'|'master'|'admin', id }
    const o = db.orders[orderId];
    if (!o) return { ok: false, error: 'Buyurtma topilmadi' };
    if (['confirmed', 'cancelled'].includes(o.status)) return { ok: false, error: 'Buyurtmani bekor qilib bo\'lmaydi' };
    if (actor.role === 'client' && o.clientId !== String(actor.id)) return { ok: false, error: 'Ruxsat yo\'q' };
    if (actor.role === 'master' && o.masterId !== String(actor.id)) return { ok: false, error: 'Ruxsat yo\'q' };
    if (actor.role === 'client' && o.status === 'done') return { ok: false, error: 'Usta ishni bajardi. Muammo bo\'lsa yordam xizmatiga yozing' };

    if (o.payment.holdId && o.payment.status === 'held') {
      await payments.release(o.payment.holdId);
      o.payment.status = 'released';
    }
    const notify = [];
    // Naqd buyurtmada oldindan yechilgan komissiya ustaga qaytariladi
    if (o.masterId && o.payment.method === 'cash' && !o.proposedTotal) {
      const m = db.masters[o.masterId];
      const charged = db.ledger.some((l) => l.orderId === o.id && l.type === 'commission');
      const refunded = db.ledger.some((l) => l.orderId === o.id && l.type === 'refund');
      if (m && charged && !refunded) {
        m.balance += o.commission;
        addLedger(db, m.userId, 'refund', o.commission, o.id, 'Bekor qilingan buyurtma komissiyasi qaytarildi');
      }
    }
    o.status = 'cancelled'; o.cancelReason = reason || actor.role; o.history.push({ s: 'cancelled', by: actor.role, at: Date.now() });
    if (actor.role !== 'client') notify.push({ to: o.clientId, type: 'client_status', orderId: o.id });
    if (o.masterId && actor.role !== 'master') notify.push({ to: o.masterId, type: 'master_cancelled', orderId: o.id });
    notify.push({ to: 'admin', type: 'order_status', orderId: o.id });
    return { ok: true, data: o, notify };
  }

  function requestWithdraw(db, catalog, masterId, amount) {
    const m = db.masters[String(masterId)];
    if (!m) return { ok: false, error: 'Usta topilmadi' };
    const w = masterWallet(db, catalog, masterId);
    const free = w.available - w.pendingWithdraw;
    amount = Math.round(Number(amount) || 0);
    if (amount < 10000) return { ok: false, error: 'Eng kam yechish summasi 10 000 so\'m' };
    if (amount > free) return { ok: false, error: 'Yechish mumkin: ' + fmt(free) + ' (' + fmt(w.reserve) + ' zaxira hisobda qoladi)' };
    const id = nextId(db, 'W');
    db.withdrawals[id] = { id, masterId: m.userId, amount, status: 'pending', at: Date.now() };
    return { ok: true, data: db.withdrawals[id], notify: [{ to: 'admin', type: 'withdraw_new', withdrawId: id }] };
  }

  function completeWithdraw(db, withdrawId) {
    const w = db.withdrawals[withdrawId];
    if (!w || w.status !== 'pending') return { ok: false, error: 'So\'rov topilmadi' };
    const m = db.masters[w.masterId];
    w.status = 'paid'; w.paidAt = Date.now();
    m.balance -= w.amount;
    addLedger(db, m.userId, 'withdraw', -w.amount, null, 'Kartaga yechildi');
    return { ok: true, data: w, notify: [{ to: m.userId, type: 'withdraw_paid', withdrawId }] };
  }

  function topUp(db, masterId, amount, note) {
    const m = db.masters[String(masterId)];
    if (!m) return { ok: false, error: 'Usta topilmadi' };
    amount = Math.round(Number(amount) || 0);
    if (amount <= 0) return { ok: false, error: 'Summa noto\'g\'ri' };
    m.balance += amount;
    addLedger(db, m.userId, 'topup', amount, null, note || 'Balans to\'ldirildi');
    return { ok: true, data: m, notify: [{ to: m.userId, type: 'topup', amount }] };
  }

  async function linkCard(db, payments, userId, cardInfo) {
    const u = db.users[String(userId)];
    if (!u) return { ok: false, error: 'Foydalanuvchi topilmadi' };
    const r = await payments.linkCard(cardInfo, u);
    if (!r.ok) return { ok: false, error: r.error || 'Kartani ulab bo\'lmadi' };
    if (r.redirectUrl) return { ok: true, data: { redirectUrl: r.redirectUrl }, notify: [] };
    const card = { id: nextId(db, 'C'), mask: r.mask, brand: r.brand, token: r.token };
    u.cards.push(card);
    return { ok: true, data: { id: card.id, mask: card.mask, brand: card.brand }, notify: [] };
  }

  // Mijozga ko'rsatiladigan buyurtma (ichki maydonlarsiz)
  function publicOrder(db, o, forRole) {
    const m = o.masterId ? db.masters[o.masterId] : null;
    const out = {
      id: o.id, items: o.items, subtotal: o.subtotal, urgentFee: o.urgentFee, total: o.total,
      proposedTotal: o.proposedTotal || null, status: o.status, statusText: STATUS[o.status],
      time: o.time, timeText: timeLabel(o.time), payment: { method: o.payment.method, cardMask: o.payment.cardMask || null },
      createdAt: o.createdAt, rating: o.rating, comment: o.comment,
      master: m ? { name: m.name, phone: o.status === 'confirmed' || o.status === 'cancelled' ? null : m.phone, rating: m.ratingCount ? +(m.ratingSum / m.ratingCount).toFixed(1) : null, jobs: m.jobs } : null,
    };
    if (forRole === 'master') {
      const hidden = o.status === 'new';
      out.commission = o.commission;
      out.address = hidden ? { district: o.address.district, text: o.address.district || 'Toshkent' } : o.address;
      out.addressText = hidden ? (o.address.district || 'Toshkent') : addressLine(o.address);
      out.phone = hidden ? null : o.phone;
    } else {
      out.address = o.address; out.addressText = addressLine(o.address);
    }
    return out;
  }

  return {
    STATUS, emptyDb, fmt, findService, ensureUser, setPhone, saveAddress, deleteAddress,
    addressLine, timeLabel, createOrder, matchingMasters, masterWallet, registerMaster,
    approveMaster, acceptOrder, masterArrived, masterDone, clientConfirm, cancelOrder,
    requestWithdraw, completeWithdraw, topUp, linkCard, publicOrder,
  };
});
