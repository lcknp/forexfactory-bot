// ===============================
// ForexFactory USD News -> Telegram (Render-Version)
// ===============================

// Token & Chat-ID aus Umgebungsvariablen lesen
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // als String ok

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('TELEGRAM_TOKEN oder TELEGRAM_CHAT_ID ist nicht gesetzt!');
  process.exit(1);
}

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const POLL_INTERVAL_MS = 60 * 1000;

const sentEvents = new Set();

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML'
    })
  });

  const data = await resp.json();
  if (!data.ok) {
    console.error('Fehler beim Senden an Telegram:', data);
  } else {
    console.log('Telegram-Nachricht gesendet.');
  }
}

async function fetchCalendar() {
  const resp = await fetch(FF_URL);
  if (!resp.ok) {
    throw new Error(`Fehler beim Laden von ForexFactory: ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json();
  return data;
}

async function checkUsdNews() {
  try {
    console.log('Prüfe ForexFactory USD-News ...');
    const events = await fetchCalendar();
    const now = new Date();
    const usdEvents = events.filter(e => e.country === 'USD');

    for (const event of usdEvents) {
      const eventTime = new Date(event.date);
      const key = `${event.country}|${event.title}|${event.date}`;

      if (eventTime <= now && !sentEvents.has(key)) {
        sentEvents.add(key);

        const localTime = eventTime.toISOString(); // neutrale Darstellung

        let text = `📢 <b>USD News</b>\n`;
        text += `<b>${event.title}</b>\n`;
        text += `🕒 Zeit (UTC): ${localTime}\n`;
        text += `📊 Impact: ${event.impact}\n`;
        if (event.forecast) text += `🔮 Forecast: ${event.forecast}\n`;
        if (event.previous) text += `📁 Previous: ${event.previous}`;

        await sendTelegramMessage(text);
      }
    }

    console.log('Check fertig.');
  } catch (err) {
    console.error('Fehler in checkUsdNews():', err);
  }
}

// Direkt einmal starten
checkUsdNews();

// Und dann regelmäßig
setInterval(checkUsdNews, POLL_INTERVAL_MS);
