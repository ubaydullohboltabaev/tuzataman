/*
 * TuzataMan server: Telegram bot + Mini App uchun API + Mini App fayllari.
 * Hech qanday tashqi kutubxona kerak emas (Node 18+).
 *
 * Ishga tushirish:  cp .env.example .env  (to'ldiring)  &&  node index.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- Sozlamalar ----------
loadEnv(path.join(__dirname, '.env'));
const CFG = {
  token: process.env.BOT_TOKEN || '',
  adminId: String(process.env.ADMIN_ID || ''),
  webappUrl: process.env.WEBAPP_URL || '',
  port: parseInt(process.env.PORT || '8080', 10),
  dev: process.env.DEV_MODE === '1',
  welcomeBonus: parseInt(process.env.WELCOME_BONUS || '25000', 10),
  payments: process.env.PAYMENTS || 'mock',
  channel: process.env.CHANNEL || '@tuzataman_uz',
  botUsername: (process.env.BOT_USERNAME || '').replace(/^@/, ''),
  webhook: process.env.WEBHOOK === '1',
  dbFile: process.env.DB_FILE || path.join(__dirname, 'data', 'db.json'),
};
const WEBAPP_DIR = path.join(__dirname, '..', 'webapp');
const core = require(path.join(WEBAPP_DIR, 'core.js'));
const catalog = JSON.parse(fs.readFileSync(path.join(WEBAPP_DIR, 'catalog.json'), 'utf8'));
const payments = require('./payments')(CFG.payments);

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

// ---------- Ma'lumotlar bazasi (JSON fayl) ----------
let db = core.emptyDb();
if (fs.existsSync(CFG.dbFile)) db = JSON.parse(fs.readFileSync(CFG.dbFile, 'utf8'));
function save() {
  fs.mkdirSync(path.dirname(CFG.dbFile), { recursive: true });
  const tmp = CFG.dbFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, CFG.dbFile);
}
// O'zgartiruvchi amallar navbat bilan bajariladi (ikki usta bir buyurtmani bir vaqtda ololmaydi)
let queue = Promise.resolve();
function run(fn) {
  const p = queue.then(async () => {
    const r = await fn();
    if (r && r.ok) save();
    if (r && r.notify) for (const n of r.notify) notify(n).catch((e) => console.error('notify', e.message));
    return r;
  });
  queue = p.catch(() => {});
  return p;
}

// ---------- Telegram ----------
async function tg(method, params) {
  if (!CFG.token) return null;
  const res = await fetch(`https://api.telegram.org/bot${CFG.token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}),
  });
  const j = await res.json();
  if (!j.ok) console.error('TG', method, j.description);
  return j.result;
}

function validateInitData(initData) {
  if (!initData || !CFG.token) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(CFG.token).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - parseInt(p.get('auth_date') || '0', 10) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

const send = (chatId, text, extra) => tg('sendMessage', Object.assign({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const appBtn = (text, hash) => ({ text, web_app: { url: CFG.webappUrl + (hash || '') } });

function itemsText(o) {
  return o.items.map((i) => `• ${esc(i.name)}${i.qty > 1 ? ' ×' + i.qty : ''}${i.price ? ' — ' + core.fmt(i.price * i.qty) : ''}`).join('\n');
}
function totalText(o) {
  if (o.total === 0) return 'Narx: smeta asosida';
  return `Jami: <b>${core.fmt(o.total)}</b>${o.urgentFee ? ' (shoshilinch +' + core.fmt(o.urgentFee) + ')' : ''}`;
}
function payText(o) { return o.payment.method === 'card' ? `Karta (${esc(o.payment.cardMask)}), avtomatik yechiladi` : 'Naqd ustaga'; }

async function notify(n) {
  const o = n.orderId ? db.orders[n.orderId] : null;
  const to = n.to === 'admin' ? CFG.adminId : n.to;
  if (!to) return;
  switch (n.type) {
    case 'order_new': {
      const c = db.users[o.clientId];
      const cnt = core.matchingMasters(db, o).length;
      return send(to, `🆕 <b>Buyurtma ${o.id}</b>\n${itemsText(o)}\n${totalText(o)}\n\n📍 ${esc(core.addressLine(o.address))}\n🕒 ${esc(core.timeLabel(o.time))}\n💳 ${payText(o)}\n👤 ${esc(c.firstName)} ${c.username ? '@' + esc(c.username) : ''} ${esc(o.phone)}${o.comment ? '\n💬 ' + esc(o.comment) : ''}\n\nMos ustalar: ${cnt}${cnt ? '' : ' ⚠️ hech kim yo\'q, qo\'lda biriktiring'}`,
        kb([[{ text: '❌ Bekor qilish', callback_data: 'acancel:' + o.id }]]));
    }
    case 'order_offer':
      return send(to, `🛠 <b>Yangi buyurtma (${esc(o.address.district || 'Toshkent')})</b>\n${itemsText(o)}\n${totalText(o)}\n🕒 ${esc(core.timeLabel(o.time))}\n💳 ${payText(o)}\n📉 Komissiya: ${core.fmt(o.commission)}${o.payment.method === 'cash' ? ' (balansdan yechiladi)' : ' (to\'lovdan avtomatik ushlanadi)'}\n\nAniq manzil va telefon qabul qilgandan keyin ochiladi.`,
        kb([[{ text: '✅ Qabul qilish', callback_data: 'acc:' + o.id }]]));
    case 'client_status': {
      const m = o.masterId ? db.masters[o.masterId] : null;
      const lines = { accepted: `👷 Ustangiz yo'lda: <b>${esc(m && m.name)}</b>\n📞 ${esc(m && m.phone)}`, arrived: '🚪 Usta manzilga yetib keldi.', cancelled: '❌ Buyurtma bekor qilindi.' + (o.payment.status === 'released' ? ' Kartadagi muzlatilgan summa qaytarildi.' : '') };
      return send(to, `Buyurtma <b>${o.id}</b>\n${lines[o.status] || core.STATUS[o.status]}`, CFG.webappUrl ? kb([[appBtn('Buyurtmani ko\'rish', '#orders')]]) : undefined);
    }
    case 'client_confirm': {
      const sum = o.proposedTotal || o.total;
      return send(to, `✅ Usta <b>${o.id}</b> buyurtmani bajardi.\nSumma: <b>${core.fmt(sum)}</b>${o.payment.method === 'card' ? ' (kartadan yechiladi)' : ' (ustaga naqd)'}\n\nIsh ma'qul bo'ldimi? Baholang:`,
        kb([[1, 2, 3, 4, 5].map((r) => ({ text: r + '⭐', callback_data: `conf:${o.id}:${r}` })), [{ text: '⚠️ Muammo bor', callback_data: 'problem:' + o.id }]]));
    }
    case 'master_paid': {
      const w = core.masterWallet(db, catalog, to);
      const got = o.payment.method === 'card' ? `💰 Hamyoningizga +${core.fmt(o.total - o.commission)} tushdi.` : 'Mijoz ishni tasdiqladi.';
      return send(to, `🎉 <b>${o.id}</b> yakunlandi${o.rating ? ', baho: ' + o.rating + '⭐' : ''}.\n${got}\nBalans: ${core.fmt(w.balance)} (yechish mumkin: ${core.fmt(w.available)})`);
    }
    case 'master_cancelled':
      return send(to, `❌ <b>${o.id}</b> bekor qilindi.${o.payment.method === 'cash' ? ' Komissiya balansingizga qaytarildi.' : ''}`);
    case 'master_new': {
      const m = db.masters[n.masterId];
      const u = db.users[n.masterId];
      const sp = m.specialties.map((s) => (catalog.categories.find((c) => c.id === s) || {}).name).join(', ');
      return send(to, `👷 <b>Yangi usta arizasi</b>\n${esc(m.name)} ${u.username ? '@' + esc(u.username) : ''}\n📞 ${esc(m.phone)}\n🛠 ${esc(sp)}\n📍 ${esc(m.districts.join(', ') || 'Barcha tumanlar')}\nID: <code>${m.userId}</code>`,
        kb([[{ text: '✅ Tasdiqlash', callback_data: 'appr:' + m.userId }, { text: '🚫 Rad etish', callback_data: 'rej:' + m.userId }]]));
    }
    case 'master_approved':
      return send(to, `✅ Arizangiz tasdiqlandi! Endi yangi buyurtmalar shu yerga keladi.${CFG.welcomeBonus ? `\n🎁 Balansingizga ${core.fmt(CFG.welcomeBonus)} bonus qo'shildi.` : ''}`, CFG.webappUrl ? kb([[appBtn('Usta kabineti', '#master')]]) : undefined);
    case 'withdraw_new': {
      const w = db.withdrawals[n.withdrawId];
      const m = db.masters[w.masterId];
      return send(to, `💸 <b>Pul yechish so'rovi ${w.id}</b>\n${esc(m.name)} (<code>${m.userId}</code>)\nSumma: <b>${core.fmt(w.amount)}</b>\n\nUstaning kartasiga o'tkazgach "To'landi"ni bosing.`, kb([[{ text: '✅ To\'landi', callback_data: 'wd:' + w.id }]]));
    }
    case 'withdraw_paid': {
      const w = db.withdrawals[n.withdrawId];
      return send(to, `💸 ${core.fmt(w.amount)} kartangizga o'tkazildi.`);
    }
    case 'topup':
      return send(to, `➕ Balansingiz ${core.fmt(n.amount)} ga to'ldirildi.`);
  }
}

async function sendMasterOrderDetails(chatId, o) {
  const doneBtn = o.total === 0 ? { text: '✅ Yakunlash (narx yozish)', callback_data: 'donep:' + o.id } : { text: '✅ Ish bajarildi', callback_data: 'done:' + o.id };
  await send(chatId, `✅ <b>${o.id}</b> sizniki!\n${itemsText(o)}\n${totalText(o)}\n\n📍 ${esc(core.addressLine(o.address))}${o.address.comment ? '\n🧭 ' + esc(o.address.comment) : ''}\n📞 ${esc(o.phone)}\n🕒 ${esc(core.timeLabel(o.time))}\n💳 ${payText(o)}${o.comment ? '\n💬 ' + esc(o.comment) : ''}`,
    kb([[{ text: '🚪 Yetib keldim', callback_data: 'arr:' + o.id }], [doneBtn], [{ text: '❌ Mijoz bekor qildi', callback_data: 'mcancel:' + o.id }]]));
  if (o.address.lat && o.address.lng) await tg('sendLocation', { chat_id: chatId, latitude: o.address.lat, longitude: o.address.lng });
}

const CHANNEL_POST = `<b>TuzataMan endi ilovada!</b> 🛠

Kran oqyaptimi, svet o'chdimi yoki ta'mir kerakmi? Endi usta chaqirish 1 daqiqa:

1️⃣ Xizmatni tanlang, narxni darhol ko'rasiz
2️⃣ Manzilni xaritadan belgilang yoki "Meni top"ni bosing
3️⃣ Shoshilinch (45–60 daqiqa) yoki qulay soatni tanlang

✅ Tekshirilgan ustalar
✅ Narx oldindan aytiladi
✅ Ish ma'qul bo'lsagina to'laysiz
✅ 3 kunlik kafolat

Pastdagi tugmani bosing 👇`;

const isAdmin = (id) => CFG.adminId && String(id) === CFG.adminId;

async function onCallback(q) {
  const [act, id, extra] = String(q.data || '').split(':');
  const uid = String(q.from.id);
  core.ensureUser(db, q.from);
  let r = { ok: false, error: 'Noma\'lum amal' };
  if (act === 'acc') {
    r = await run(() => core.acceptOrder(db, catalog, uid, id));
    if (r.ok) await sendMasterOrderDetails(uid, r.data);
  } else if (act === 'arr') r = await run(() => core.masterArrived(db, uid, id));
  else if (act === 'done') r = await run(() => core.masterDone(db, uid, id));
  else if (act === 'donep') { await send(uid, `Yakuniy narxni shunday yozing:\n<code>/yakun ${esc(id)} 1500000</code>`); r = { ok: true }; }
  else if (act === 'mcancel') r = await run(() => core.cancelOrder(db, catalog, payments, { role: 'master', id: uid }, id, 'Usta: mijoz bekor qildi'));
  else if (act === 'conf') r = await run(() => core.clientConfirm(db, catalog, payments, uid, id, parseInt(extra, 10)));
  else if (act === 'problem') {
    await send(CFG.adminId, `⚠️ Mijoz <b>${esc(id)}</b> buyurtma bo'yicha muammo bildirdi. Mijoz: <code>${uid}</code> ${q.from.username ? '@' + esc(q.from.username) : ''}`);
    await send(uid, 'Rahmat, administrator tez orada siz bilan bog\'lanadi.');
    r = { ok: true };
  } else if (isAdmin(uid)) {
    if (act === 'appr') r = await run(() => core.approveMaster(db, catalog, id, CFG.welcomeBonus));
    else if (act === 'rej') { if (db.masters[id]) { db.masters[id].status = 'blocked'; save(); await send(id, 'Afsuski, arizangiz hozircha qabul qilinmadi.'); } r = { ok: true }; }
    else if (act === 'wd') r = await run(() => core.completeWithdraw(db, id));
    else if (act === 'acancel') r = await run(() => core.cancelOrder(db, catalog, payments, { role: 'admin', id: uid }, id, 'Admin'));
  }
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: r.ok ? 'Bajarildi ✅' : r.error, show_alert: !r.ok });
  if (r.ok && q.message && ['acc', 'arr', 'done', 'conf', 'mcancel', 'appr', 'rej', 'wd', 'acancel'].includes(act)) {
    await tg('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
  }
}

async function onMessage(msg) {
  const uid = String(msg.from.id);
  core.ensureUser(db, msg.from);
  const text = (msg.text || '').trim();

  // Mini App'dagi "Telegram raqamim bilan kirish" tugmasi kontaktni shu yerga yuboradi
  if (msg.contact) {
    if (String(msg.contact.user_id) !== uid) return send(uid, 'Iltimos, o\'zingizning raqamingizni yuboring.');
    await run(() => core.setPhone(db, uid, msg.contact.phone_number, true));
    return send(uid, '✅ Raqamingiz saqlandi: ' + db.users[uid].phone, { reply_markup: { remove_keyboard: true } });
  }
  if (text === '/start' || text.startsWith('/start ')) {
    save();
    return send(uid, `Assalomu alaykum, ${esc(msg.from.first_name)}!\n\n<b>TuzataMan</b> — uyingizdagi har qanday ta'mirga bitta tugma.\n🛠 Santexnika, elektr, mebel, mayda va to'liq ta'mir\n⏱ Toshkent bo'ylab 45–60 daqiqada\n\nUsta chaqirish uchun pastdagi tugmani bosing.`,
      CFG.webappUrl ? kb([[appBtn('🛠 Usta chaqirish')], [appBtn('👷 Usta bo\'lib ishlash', '#master')]]) : undefined);
  }
  let m;
  if ((m = text.match(/^\/yakun\s+(\S+)\s+(\d+)/))) {
    const r = await run(() => core.masterDone(db, uid, m[1], parseInt(m[2], 10)));
    return send(uid, r.ok ? 'Mijozga tasdiqlash uchun yuborildi.' : '⚠️ ' + r.error);
  }
  if (text === '/balans' && db.masters[uid]) {
    const w = core.masterWallet(db, catalog, uid);
    return send(uid, `💼 Balans: <b>${core.fmt(w.balance)}</b>\n🔒 Zaxira: ${core.fmt(w.reserve)}\n💸 Yechish mumkin: ${core.fmt(w.available)}`);
  }
  if (!isAdmin(uid)) return send(uid, 'Buyurtma berish yoki holatni ko\'rish uchun ilovani oching.', CFG.webappUrl ? kb([[appBtn('Ilovani ochish')]]) : undefined);

  // ----- Admin buyruqlari -----
  if ((m = text.match(/^\/topup\s+(\d+)\s+(\d+)/))) {
    const r = await run(() => core.topUp(db, m[1], m[2], 'Admin tomonidan to\'ldirildi'));
    return send(uid, r.ok ? `✅ ${esc(r.data.name)} balansi: ${core.fmt(r.data.balance)}` : '⚠️ ' + r.error);
  }
  if (text === '/kanal') {
    // Kanalga tugmali post. Bot kanalda admin bo'lishi kerak.
    if (!CFG.botUsername) return send(uid, '⚠️ BOT_USERNAME sozlanmagan');
    const link = `https://t.me/${CFG.botUsername}?startapp`;
    const r = await tg('sendMessage', { chat_id: CFG.channel, parse_mode: 'HTML', text: CHANNEL_POST,
      reply_markup: { inline_keyboard: [[{ text: '🛠 Usta chaqirish', url: link }], [{ text: '👷 Usta bo\'lib ishlash', url: link + '=master' }]] } });
    if (!r) return send(uid, `⚠️ Kanalga yuborilmadi. Botni ${esc(CFG.channel)} kanaliga admin qilib qo'shing ("Xabar yuborish" va "Xabarni qadash" ruxsati bilan).`);
    await tg('pinChatMessage', { chat_id: CFG.channel, message_id: r.message_id, disable_notification: true });
    return send(uid, '✅ Post kanalga joylandi va qadab qo\'yildi.');
  }
  if (text === '/stats') {
    const os = Object.values(db.orders);
    const done = os.filter((o) => o.status === 'confirmed');
    const income = done.reduce((s, o) => s + o.commission, 0);
    return send(uid, `📊 Buyurtmalar: ${os.length}\n✅ Yakunlangan: ${done.length}\n🆕 Kutilmoqda: ${os.filter((o) => o.status === 'new').length}\n💰 Komissiya daromadi: ${core.fmt(income)}\n👷 Faol ustalar: ${Object.values(db.masters).filter((x) => x.status === 'active').length}\n👤 Mijozlar: ${Object.keys(db.users).length}`);
  }
  if (text === '/ustalar') {
    const list = Object.values(db.masters).map((x) => `${x.status === 'active' ? '🟢' : x.status === 'pending' ? '🟡' : '🔴'} ${esc(x.name)} <code>${x.userId}</code> — ${core.fmt(x.balance)}, ${x.jobs} ish`);
    return send(uid, list.join('\n') || 'Ustalar yo\'q');
  }
  return send(uid, 'Admin buyruqlari:\n/kanal — kanalga tugmali post joylash\n/stats — statistika\n/ustalar — ustalar ro\'yxati\n/topup ID SUMMA — usta balansini to\'ldirish');
}

async function handleUpdate(u) {
  try {
    if (u.message) await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
  } catch (e) { console.error('update', e); }
}

// Webhook rejimi: Telegram yangilanishlarni o'zi serverga yuboradi (Render kabi uxlab qoladigan hostinglar uchun)
const HOOK_PATH = '/tg/' + crypto.createHash('sha256').update(CFG.token || 'x').digest('hex').slice(0, 24);
async function setupBot() {
  if (CFG.webappUrl) await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Usta chaqirish', web_app: { url: CFG.webappUrl } } });
  await tg('setMyCommands', { commands: [{ command: 'start', description: 'Usta chaqirish' }, { command: 'balans', description: 'Usta balansi' }] });
  if (CFG.webhook) {
    const url = CFG.webappUrl.replace(/\/$/, '') + HOOK_PATH;
    await tg('setWebhook', { url, allowed_updates: ['message', 'callback_query'] });
    console.log('Webhook o\'rnatildi');
  } else poll();
}

async function poll() {
  let offset = 0;
  await tg('deleteWebhook', {});
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const u of ups || []) {
        offset = u.update_id + 1;
        await handleUpdate(u);
      }
    } catch (e) { console.error('poll', e.message); await new Promise((r) => setTimeout(r, 3000)); }
  }
}

// ---------- HTTP: Mini App API ----------
function authUser(req) {
  const tgUser = validateInitData(req.headers['x-telegram-init-data']);
  if (tgUser) return tgUser;
  if (CFG.dev && req.headers['x-dev-user']) { try { return JSON.parse(req.headers['x-dev-user']); } catch {} }
  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

function me(uid) {
  const u = db.users[uid];
  const m = db.masters[uid];
  return {
    user: { id: u.id, firstName: u.firstName, lastName: u.lastName, username: u.username, phone: u.phone, phoneVerified: u.phoneVerified },
    addresses: u.addresses,
    cards: u.cards.map((c) => ({ id: c.id, mask: c.mask, brand: c.brand })),
    master: m ? Object.assign({ name: m.name, status: m.status, specialties: m.specialties, districts: m.districts, jobs: m.jobs, rating: m.ratingCount ? +(m.ratingSum / m.ratingCount).toFixed(1) : null }, core.masterWallet(db, catalog, uid)) : null,
  };
}

async function api(req, res, url) {
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const out = (r) => json(r.ok ? 200 : 400, r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error });
  const tgUser = authUser(req);
  if (!tgUser) return json(401, { ok: false, error: 'Ilovani Telegram ichida oching' });
  const uid = String(tgUser.id);
  const isNew = !db.users[uid];
  core.ensureUser(db, tgUser);
  if (isNew) save();
  const body = req.method === 'POST' || req.method === 'DELETE' ? await readBody(req) : {};
  const p = url.pathname;
  let m;

  if (p === '/api/me' && req.method === 'GET') return json(200, { ok: true, data: me(uid) });
  if (p === '/api/phone' && req.method === 'POST') return out(await run(() => core.setPhone(db, uid, body.phone, false)));
  if (p === '/api/addresses' && req.method === 'POST') return out(await run(() => core.saveAddress(db, uid, body)));
  if ((m = p.match(/^\/api\/addresses\/([\w-]+)$/)) && req.method === 'DELETE') return out(await run(() => core.deleteAddress(db, uid, m[1])));
  if (p === '/api/cards' && req.method === 'POST') return out(await run(() => core.linkCard(db, payments, uid, body)));
  if (p === '/api/orders' && req.method === 'POST') {
    const r = await run(() => core.createOrder(db, catalog, payments, uid, body));
    return r.ok ? json(200, { ok: true, data: core.publicOrder(db, r.data) }) : out(r);
  }
  if (p === '/api/orders' && req.method === 'GET') {
    const list = Object.values(db.orders).filter((o) => o.clientId === uid).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
    return json(200, { ok: true, data: list.map((o) => core.publicOrder(db, o)) });
  }
  if ((m = p.match(/^\/api\/orders\/(\w+)\/cancel$/))) return out(await run(() => core.cancelOrder(db, catalog, payments, { role: 'client', id: uid }, m[1], 'Mijoz')));
  if ((m = p.match(/^\/api\/orders\/(\w+)\/confirm$/))) return out(await run(() => core.clientConfirm(db, catalog, payments, uid, m[1], parseInt(body.rating, 10))));

  if (p === '/api/master/register' && req.method === 'POST') return out(await run(() => core.registerMaster(db, uid, body)));
  if (p === '/api/master/orders' && req.method === 'GET') {
    const mine = Object.values(db.orders).filter((o) => o.masterId === uid).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
    const master = db.masters[uid];
    const open = master && master.status === 'active' ? Object.values(db.orders).filter((o) => o.status === 'new' && core.matchingMasters(db, o).some((x) => x.userId === uid)) : [];
    const ledger = db.ledger.filter((l) => l.masterId === uid).slice(-30).reverse();
    return json(200, { ok: true, data: { open: open.map((o) => core.publicOrder(db, o, 'master')), mine: mine.map((o) => core.publicOrder(db, o, 'master')), ledger } });
  }
  if ((m = p.match(/^\/api\/master\/orders\/(\w+)\/(accept|arrived|done|cancel)$/))) {
    const [, oid, act] = m;
    let r;
    if (act === 'accept') { r = await run(() => core.acceptOrder(db, catalog, uid, oid)); if (r.ok) sendMasterOrderDetails(uid, r.data).catch(() => {}); }
    else if (act === 'arrived') r = await run(() => core.masterArrived(db, uid, oid));
    else if (act === 'done') r = await run(() => core.masterDone(db, uid, oid, parseInt(body.finalTotal, 10)));
    else r = await run(() => core.cancelOrder(db, catalog, payments, { role: 'master', id: uid }, oid, 'Usta: mijoz bekor qildi'));
    return r.ok ? json(200, { ok: true, data: core.publicOrder(db, r.data, 'master') }) : out(r);
  }
  if (p === '/api/master/withdraw' && req.method === 'POST') return out(await run(() => core.requestWithdraw(db, catalog, uid, body.amount)));
  return json(404, { ok: false, error: 'Topilmadi' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    if (CFG.webhook && req.method === 'POST' && url.pathname === HOOK_PATH) {
      const u = await readBody(req);
      res.writeHead(200); res.end('ok');
      return handleUpdate(u);
    }
    let f = path.normalize(path.join(WEBAPP_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(WEBAPP_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    if (f.endsWith('index.html')) {
      // index.html qobiqsiz yozilgan (artifact ko'rinishi bilan bir xil), shu yerda to'liq hujjatga o'raymiz
      return res.end('<!doctype html><html lang="uz"><head><meta charset="utf-8"></head><body>' + fs.readFileSync(f, 'utf8') + '</body></html>');
    }
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Server xatosi' }));
  }
});

if (require.main === module) {
  server.listen(CFG.port, () => console.log(`TuzataMan server: http://localhost:${CFG.port}  (to'lov: ${payments.name}${CFG.dev ? ', DEV_MODE' : ''})`));
  if (CFG.token) setupBot(); else console.log('BOT_TOKEN yo\'q — bot o\'chiq, faqat API ishlaydi');
}
module.exports = { server, validateInitData, CFG };
