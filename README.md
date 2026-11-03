# TuzataMan — Telegram Mini App va bot

Toshkent bo'ylab uy ustasi xizmati: mijoz Telegram ichida usta chaqiradi, buyurtma tumandagi ustalarga boradi, birinchi qabul qilgan usta oladi, komissiya avtomatik hisoblanadi.

## 1. Gemini suhbati tahlili

**Nima qilingan edi**
- Yo'nalish tanlangan: nol byudjet bilan "Handyman" (uy ustasi) vositachilik xizmati. Ustalar tayyor (tanish ustalar), asosiy muammo — mijoz topish.
- Brend: **TuzataMan**, kanal `@tuzataman_uz` ochilgan, logotip, tavsif va birinchi post tayyor.
- Narxlar ro'yxati, e'lon matnlari (mahalla guruhlari, OLX, podyezd), qo'ng'iroq skripti.
- Biznes modeli: mijoz kartasi ulanadi, pul ish tasdiqlangach avtomatik yechiladi, 20% komissiya kompaniyaga, 80% usta hamyoniga. Ustaning hisobida doim **25 000 so'm** zaxira qoladi.
- Gemini Canvas'da Mini App **prototipi** qilingan: xizmatlar, savat, "Meni top", xarita, vaqt tanlash, manzil detallari, profil, usta hamyoni.

**Nima yetishmas edi (shu loyiha to'ldirdi)**
- Gemini prototipi faqat ko'rinish edi: server yo'q, buyurtma hech qayerga saqlanmaydi, ustalarga bormaydi, hamyon raqamlari qo'lda yozilgan.
- "Meni top" noto'g'ri manzil ko'rsatgan: kodda test manzil yozilgan edi. Bu yerda haqiqiy GPS (Telegram LocationManager yoki brauzer), aniqlik past bo'lsa xarita ochilib pinni to'g'rilash so'raladi.
- Gemini "Telegram raqami avtomatik olinadi" degan, aslida Telegram raqamni o'zi bermaydi. Bu yerda `requestContact` ishlatilgan: foydalanuvchi bir marta "Raqamni ulashish"ni bosadi, raqam botga keladi va tasdiqlangan deb saqlanadi.
- Kartadan SMS'siz avtomatik yechish faqat to'lov tizimi bilan shartnoma bo'lgandagina ishlaydi (pastda, 5-bo'lim).

## 2. Nima tayyor

| Qism | Nima qiladi |
|---|---|
| `webapp/index.html` | Mini App: 6 toifa, 27 xizmat, savat, manzil (qidiruv, "Meni top", xaritadan tanlash, podyezd/qavat/xonadon/domofon/yo'l-yo'riq), shoshilinch yoki kun+soat, karta yoki naqd, buyurtmalar va baholash, profil, usta kabineti (ariza, hamyon, yechish, buyurtma olish) |
| `webapp/core.js` | Barcha qoidalar: narx hisobi, 20% komissiya, 25 000 zaxira, bekor qilinganda qaytarish. Server ham, demo ham shu bitta faylni ishlatadi |
| `webapp/catalog.json` | Xizmatlar, narxlar, tumanlar, komissiya foizi, zaxira, shoshilinch narxi. Narxni o'zgartirish uchun faqat shu faylni tahrirlang |
| `server/index.js` | Bot + API. Tashqi kutubxona kerak emas (Node 18+) |
| `server/payments.js` | To'lov qatlami. Hozir sinov rejimi, Octo uchun shablon tayyor |

**Buyurtma qanday yuradi**
1. Mijoz buyurtma beradi. Karta tanlansa summa muzlatiladi (yechilmaydi).
2. Bot shu tuman va yo'nalishdagi ustalarga yuboradi: tuman, ishlar, narx, komissiya. Aniq manzil va telefon yashirin.
3. Birinchi "Qabul qilish"ni bosgan usta oladi, unga manzil, telefon va lokatsiya ochiladi. Naqd buyurtmada komissiya shu payt balansidan yechiladi (balans yetmasa ololmaydi).
4. Usta: "Yetib keldim" → "Ish bajarildi" (to'liq ta'mirda yakuniy narxni yozadi: `/yakun T00012 1500000`).
5. Mijoz baholaydi va tasdiqlaydi. Karta bo'lsa summa yechiladi: 20% sizga, 80% usta hamyoniga.
6. Usta "Kartaga yechish" so'rovini yuboradi: `balans − 25 000` gacha. So'rov sizga keladi, pulni o'tkazib "To'landi"ni bosasiz.
7. Bekor bo'lsa: muzlatilgan summa qaytadi, naqd buyurtma komissiyasi ustaga qaytariladi.

**Admin (siz) botda oladi:** har bir yangi buyurtma, usta arizasi (Tasdiqlash / Rad etish), pul yechish so'rovi, "Muammo bor" shikoyatlari.
Buyruqlar: `/stats`, `/ustalar`, `/topup USTA_ID SUMMA` (usta naqd pul tashlab balansini to'ldirsa).

## 3. Ishga tushirish

1. **GitHub.** github.com/new da bo'sh `tuzataman` repozitoriy oching. Kod shu yerga yuklanadi.
2. **Render.** render.com ga GitHub orqali kiring → New → Blueprint → `tuzataman` repo. `render.yaml` hamma narsani o'zi sozlaydi. So'raladigan 4 ta qiymat:
   - `BOT_TOKEN` — @BotFather bergan token
   - `ADMIN_ID` — @userinfobot ko'rsatgan raqamingiz
   - `BOT_USERNAME` — botning username'i, @ belgisisiz
   - `WEBAPP_URL` — Render bergan manzil, masalan `https://tuzataman.onrender.com/` (birinchi deploydan keyin ko'rinadi, keyin qo'shib "Manual Deploy" bosing)
   - Tarif: Starter (oyiga ~7$) — ma'lumotlar diskda saqlanadi. Bepul tarifda server qayta ishga tushganda buyurtma va balanslar o'chadi, shuning uchun faqat sinash uchun.
3. **@BotFather.** `/mybots` → bot → Bot Settings → Configure Mini App → Enable → `WEBAPP_URL`. Shundan keyin `t.me/BOT?startapp` havolasi ilovani to'g'ridan-to'g'ri ochadi.
4. **Kanal.** `@tuzataman_uz` → Administratorlar → botni qo'shing ("Xabar yuborish" va "Xabarni qadash" ruxsati). Botga `/kanal` yozing: tugmali post kanalga joylanadi va qadaladi.
5. **Sinov.** Botga `/start` → "Usta chaqirish". Ikkinchi akkauntdan "Usta bo'lib ishlash", o'zingiz tasdiqlang, buyurtma bering.

Kompyuterda sinash: `cd server && DEV_MODE=1 node index.js`, brauzerda `http://localhost:8080` (Telegram'siz demo rejimi).

## 4. Narx va qoidalarni o'zgartirish
`webapp/catalog.json`: `commissionPercent` (20), `masterReserve` (25000), `urgentFee` (20000), xizmatlar va narxlar. Server qayta ishga tushirilgach kuchga kiradi.

## 5. Haqiqiy pul bilan ishlash uchun nima kerak
Hozir karta to'lovi **sinov rejimida**: hamma hisob-kitob to'g'ri yuradi, lekin kartadan haqiqiy pul yechilmaydi. Naqd buyurtmalar va usta balansi esa hozirning o'zida ishlaydi.

Kartani ulash, summani muzlatish va keyin SMS'siz yechish uchun:
1. **YaTT yoki MChJ** ochish va korporativ hisob raqam.
2. To'lov tizimi bilan shartnoma: **Octo** (marketpleyslar uchun split va ustalarga payout qulay), yoki Click / Payme. Ulardan "karta tokenizatsiyasi" va "hold/capture" (muzlatib keyin yechish) imkonini so'rang.
3. Ular bergan kalitlar bilan `server/payments.js` dagi 5 ta funksiya to'ldiriladi, `PAYMENTS=octo`. Boshqa kod o'zgarmaydi.

Ungacha tavsiya: ishni **naqd + usta balansi** modeli bilan boshlang. Ustalar sizga Click/Payme orqali depozit tashlaydi, siz `/topup` bilan balansini to'ldirasiz, komissiya avtomatik yechiladi.

## 6. Keyingi qadamlar
- Ko'p foydalanuvchida manzil qidiruvini Yandex Geocoder yoki 2GIS kalitiga o'tkazish (hozirgi OpenStreetMap bepul, lekin sekundiga 1 so'rov chegarasi bor).
- JSON fayl o'rniga ma'lumotlar bazasi (SQLite/PostgreSQL), buyurtmalar yuzlab bo'lganda.
- Usta yaqin atrofda bo'lmasa buyurtmani 10 daqiqadan keyin qo'shni tumanlarga ham yuborish.
- Rus tili.
