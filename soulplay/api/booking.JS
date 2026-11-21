// api/booking.js — приёмник заявок с отправкой SMS через SMS.ru

// Переменные окружения на Vercel (Settings → Environment Variables):
//   SMSRU_API_ID      — ваш API-ключ из личного кабинета SMS.ru
//   ADMIN_PHONE       — номер телефона администратора (например, 79276665751)

const LIMITS = { name: 60, phone: 20, comment: 300 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  }
  body = body || {};

  const { name, phone, hall, date, time, people, hours, comment, website } = body;

  // Honeypot (защита от спам-ботов)
  if (website) return res.status(200).json({ ok: true });

  // --- Валидация ---
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.length > LIMITS.name)
    return res.status(400).json({ error: 'Укажите имя' });

  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15)
    return res.status(400).json({ error: 'Укажите корректный телефон' });

  if (!hall || !date || !time)
    return res.status(400).json({ error: 'Выберите зал, дату и время' });

  if (comment && comment.length > LIMITS.comment)
    return res.status(400).json({ error: 'Комментарий слишком длинный' });

  // Простой rate-limit (6 заявок за 10 минут с одного IP)
  if (rateLimit(req)) {
    return res.status(429).json({ error: 'Слишком много заявок. Попробуйте позже.' });
  }

  // --- Формируем текст SMS ---
  // SMS имеет ограничение по длине (обычно 70–160 символов кириллицей).
  // Мы отправляем компактное сообщение, чтобы оно уложилось в один сегмент.
  const smsText = [
    `Новая бронь Soul Play`,
    `Имя: ${name}`,
    `Тел: ${phone}`,
    `Зал: ${hall}`,
    `Дата: ${date} ${time}`,
    people ? `Чел: ${people}` : '',
    hours ? `Длит: ${hours}` : '',
    comment ? `Комм: ${comment}` : ''
  ].filter(Boolean).join('\n');

  // --- Отправка SMS через SMS.ru ---
  const apiId = process.env.SMSRU_API_ID;
  const adminPhone = process.env.ADMIN_PHONE;

  if (!apiId || !adminPhone) {
    console.error('Не заданы SMSRU_API_ID или ADMIN_PHONE');
    return res.status(500).json({ error: 'Ошибка конфигурации сервера' });
  }

  try {
    // SMS.ru принимает GET-запросы на этот URL
    const url = new URL('https://sms.ru/sms/send');
    url.searchParams.set('api_id', apiId);
    url.searchParams.set('to', adminPhone);       // номер получателя
    url.searchParams.set('msg', smsText);
    url.searchParams.set('json', '1');            // ответ в JSON
    // url.searchParams.set('from', 'SoulPlay');  // если отправитель одобрен
    // url.searchParams.set('translit', '1');     // если нужна транслитерация

    const smsRes = await fetch(url.toString());
    const smsData = await smsRes.json();

    // SMS.ru возвращает status === "OK" при успехе
    if (smsData.status !== 'OK') {
      console.error('SMS.ru error:', smsData);
      return res.status(502).json({
        error: smsData.status_text || 'Не удалось отправить SMS'
      });
    }

    // Опционально: проверяем статус конкретного номера
    const phoneStatus = smsData.sms?.[adminPhone]?.status;
    if (phoneStatus && phoneStatus !== 'OK') {
      console.error('SMS delivery status:', phoneStatus);
      // Сообщение принято, но может быть не доставлено (например, неверный номер).
      // Всё равно возвращаем успех, чтобы клиент не видел ошибку.
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('SMS send error:', e);
    return res.status(500).json({ error: 'Внутренняя ошибка' });
  }
}

// --- Простой in-memory rate limit ---
const hits = new Map();
function rateLimit(req) {
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 минут
  const max = 6;

  const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);

  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    }
  }
  return arr.length > max;
}
