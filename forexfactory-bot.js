// ===============================
// ForexFactory USD High-Impact News -> Telegram Bot
// Für Render.com (24/7 Betrieb) mit Auto-Cooldown bei 429
// ===============================

// --- Konfiguration über Environment Variablen ---
// Diese musst du in Render setzen:
// TELEGRAM_TOKEN   = dein Bot-Token
// TELEGRAM_CHAT_ID = deine Chat-ID

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ TELEGRAM_TOKEN oder TELEGRAM_CHAT_ID ist nicht gesetzt!");
  process.exit(1);
}

// ForexFactory JSON dieser Woche
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

// Standard-Abfrageintervall (z.B. 1 Minute)
const BASE_POLL_INTERVAL_MS = 60 * 1000;

// Cooldown, wenn 429 (Too Many Requests) auftritt (z.B. 5 Minuten)
const COOLDOWN_INTERVAL_MS = 5 * 60 * 1000;

// Merkt sich Events, die schon gesendet wurden
const sentEvents = new Set();

/**
 * Telegram Nachricht senden
 */
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  });

  const data = await resp.json();
  if (!data.ok) {
    console.error("❌ Telegram-Fehler:", data);
  } else {
    console.log("📨 Nachricht gesendet:", text.split("\n")[0]);
  }
}

/**
 * ForexFactory-Kalender laden
 */
async function fetchCalendar() {
  const resp = await fetch(FF_URL);

  if (resp.status === 429) {
    // Rate Limit
    throw new Error("RATE_LIMIT_429");
  }

  if (!resp.ok) {
    throw new Error(`HTTP_${resp.status}`);
  }

  const data = await resp.json();
  return data;
}

/**
 * USD High-Impact News prüfen & senden
 */
async function checkUsdNews() {
  console.log("🔎 Prüfe USD High-Impact News ...");

  const events = await fetchCalendar();
  const now = new Date();

  // Filtere nur USD + High Impact
  const usdHighImpact = events.filter((e) => {
    if (e.country !== "USD") return false;

    // Impact als String normalisieren
    const impact = String(e.impact).toLowerCase();
    // Je nach API: "High", "high", oder Zahl "3"
    return impact === "high" || impact === "3";
  });

  for (const event of usdHighImpact) {
    const eventTime = new Date(event.date);
    const key = `${event.country}|${event.title}|${event.date}`;

    // Nur senden, wenn die Zeit erreicht/vergangen ist und wir es noch nicht geschickt haben
    if (eventTime <= now && !sentEvents.has(key)) {
      sentEvents.add(key);

      let text = `📣 <b>USD News (High Impact)</b>\n`;
      text += `<b>${event.title}</b>\n`;
      text += `🕒 Zeit (UTC): ${eventTime.toISOString()}\n`;
      text += `📊 Impact: ${event.impact}\n`;

      if (event.forecast) text += `🔮 Forecast: ${event.forecast}\n`;
      if (event.previous) text += `📁 Previous: ${event.previous}\n`;

      await sendTelegramMessage(text);
    }
  }

  console.log("✅ High-Impact-Check abgeschlossen.");
}

/**
 * Sicherer Loop mit flexiblem Intervall (Auto-Cooldown bei 429)
 */
let currentInterval = BASE_POLL_INTERVAL_MS;

async function loop() {
  try {
    await checkUsdNews();
    // Wenn es geklappt hat → wieder normales Intervall
    if (currentInterval !== BASE_POLL_INTERVAL_MS) {
      console.log("⏱️ Zurück auf normales Intervall:", BASE_POLL_INTERVAL_MS, "ms");
    }
    currentInterval = BASE_POLL_INTERVAL_MS;
  } catch (err) {
    const msg = String(err.message || err);

    if (msg.includes("RATE_LIMIT_429")) {
      console.error("⚠️ ForexFactory Rate Limit (429) erreicht! Warte jetzt 5 Minuten...");
      currentInterval = COOLDOWN_INTERVAL_MS;
    } else {
      console.error("❌ Fehler in loop()/checkUsdNews():", err);
      // Bei anderen Fehlern lassen wir das Intervall gleich, damit er weiter versucht
    }
  }

  // Nächsten Durchlauf planen
  setTimeout(loop, currentInterval);
}

// Beim Start direkt einmal ausführen
loop();
