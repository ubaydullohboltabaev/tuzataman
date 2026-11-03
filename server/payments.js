/*
 * To'lov provayderi.
 *
 * Hozir "mock" (sinov) rejimi ishlaydi: karta ulash, muzlatish (hold),
 * yechish (capture) va bekor qilish (release) haqiqiy pulsiz bajariladi.
 *
 * Haqiqiy pul bilan ishlash uchun YaTT yoki MChJ, korporativ hisob raqami
 * va to'lov tizimi bilan shartnoma kerak (Octo, Click yoki Payme).
 * Shartnoma tuzilgach, quyidagi 5 ta funksiyani provayder API'siga ulash kifoya.
 * Qolgan kod (core.js) o'zgarmaydi.
 */
'use strict';

function mockProvider() {
  const holds = new Map();
  let n = 1;
  return {
    name: 'mock',
    // Haqiqiy provayderda: karta ulash sahifasiga yo'naltirish (redirectUrl) qaytariladi,
    // karta tokeni esa provayder callback'i orqali keladi.
    async linkCard(info) {
      const digits = String((info && info.number) || '').replace(/\D/g, '');
      if (digits.length !== 16) return { ok: false, error: 'Karta raqami 16 ta raqam bo\'lishi kerak' };
      const brand = digits.startsWith('9860') ? 'Humo' : digits.startsWith('8600') || digits.startsWith('5614') ? 'Uzcard' : 'Karta';
      return { ok: true, token: 'mock_' + digits.slice(-4) + '_' + Date.now(), mask: brand + ' •••• ' + digits.slice(-4), brand };
    },
    async hold(card, amount, orderId) {
      const holdId = 'H' + n++;
      holds.set(holdId, { card: card.id, amount, orderId, status: 'held' });
      return { ok: true, holdId };
    },
    async capture(holdId, amount) {
      const h = holds.get(holdId);
      if (h) { h.status = 'captured'; h.captured = amount; }
      return { ok: true };
    },
    async release(holdId) {
      const h = holds.get(holdId);
      if (h) h.status = 'released';
      return { ok: true };
    },
    async charge(card, amount, orderId) {
      return { ok: true, txId: 'X' + n++ };
    },
  };
}

/*
 * Octo uchun shablon. Octo hujjatlari: https://help.octo.uz
 * (Endpoint va maydon nomlarini shartnoma tuzilgach Octo bergan hujjat bo'yicha tekshiring.)
 *
 *   linkCard  -> karta bog'lash sahifasi (redirect), callback'da token saqlanadi
 *   hold      -> prepare_payment, auto_capture: false
 *   capture   -> set_accept (to'liq yoki qisman summa)
 *   release   -> set_accept bilan bekor qilish / refund
 *   charge    -> saqlangan token bilan to'lov
 *
 * Ustalarga pul o'tkazish (payout) ham Octo/Click orqali avtomatlashtiriladi.
 * Ungacha "Kartaga yechish" so'rovlari adminga keladi va qo'lda o'tkaziladi.
 */
function octoProvider() {
  throw new Error('Octo hali ulanmagan. Shartnoma va OCTO_SHOP_ID / OCTO_SECRET olingach, server/payments.js ni to\'ldiring.');
}

module.exports = function createPayments(name) {
  if (name === 'octo') return octoProvider();
  return mockProvider();
};
