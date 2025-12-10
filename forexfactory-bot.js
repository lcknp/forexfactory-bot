import os
import time
import logging
from typing import List, Dict, Any
from datetime import datetime, timezone

import requests

# ======================================================
#                 KONFIGURATION
# ======================================================

# Discord-Webhook aus Replit-Secret lesen
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")

print("DEBUG DISCORD_WEBHOOK_URL:", repr(DISCORD_WEBHOOK_URL))

if DISCORD_WEBHOOK_URL is None or DISCORD_WEBHOOK_URL.strip() == "":
    raise SystemExit("❌ Environment-Variable DISCORD_WEBHOOK_URL ist nicht gesetzt!")

# ForexFactory JSON dieser Woche
FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"

# Polling-Intervalle
BASE_POLL_INTERVAL = 60          # Sekunden (Standard)
MAX_POLL_INTERVAL = 15 * 60      # Max. Wartezeit bei Backoff

# Logging einstellen
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# Merkt sich in dieser Laufzeit bereits gesendete Events
sent_events: set[str] = set()

# HTTP-Session wiederverwenden (effizienter als jedes Mal neue Verbindung)
session = requests.Session()


# ======================================================
#                 HILFSKLASSEN
# ======================================================

class RateLimitError(Exception):
    """Wird geworfen, wenn ForexFactory 429 zurückgibt."""

    def __init__(self, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.retry_after = retry_after


# ======================================================
#                 HILFSFUNKTIONEN
# ======================================================

def send_discord_message(content: str) -> None:
    """Sendet eine Nachricht an den Discord-Webhook."""
    data = {"content": content}

    try:
        resp = session.post(DISCORD_WEBHOOK_URL, json=data, timeout=10)
    except Exception as e:
        logger.error("Fehler beim Senden an Discord: %s", e)
        return

    if resp.status_code >= 400:
        logger.error(
            "Discord-Webhooks-Fehler: %s %s - %s",
            resp.status_code,
            resp.reason,
            resp.text[:200],
        )
    else:
        logger.info("📨 An Discord gesendet: %s", content.split("\n", 1)[0])


def fetch_calendar() -> List[Dict[str, Any]]:
    """Holt das ForexFactory-JSON."""
    try:
        resp = session.get(FF_URL, timeout=10)
    except Exception as e:
        logger.error("Fehler beim HTTP-Request an ForexFactory: %s", e)
        raise

    if resp.status_code == 429:
        # Falls "Retry-After" Header vorhanden ist, nutzen wir den
        retry_after_header = resp.headers.get("Retry-After")
        retry_after = None
        if retry_after_header and retry_after_header.isdigit():
            retry_after = int(retry_after_header)

        raise RateLimitError("429 Too Many Requests", retry_after=retry_after)

    if resp.status_code >= 400:
        raise RuntimeError(
            f"HTTP-Fehler von ForexFactory: {resp.status_code} {resp.text[:200]}"
        )

    try:
        return resp.json()
    except Exception as e:
        raise RuntimeError(
            f"Fehler beim Parsen des ForexFactory-JSON: {e}"
        ) from e


def parse_event_time(date_str: str) -> datetime:
    """Parst das Datum aus dem JSON nach UTC."""
    # Beispiel: "2025-11-20T13:30:00.000Z"
    if date_str.endswith("Z"):
        date_str = date_str.replace("Z", "+00:00")
    return datetime.fromisoformat(date_str).astimezone(timezone.utc)


def get_usd_high_events(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Filtert alle USD High-Impact-News heraus und hängt ein Datumsobjekt an."""
    result: List[Dict[str, Any]] = []
    for e in events:
        try:
            if e.get("country") != "USD":
                continue

            impact_raw = str(e.get("impact", "")).lower()
            # je nach API: "High", "high", oder 3
            if impact_raw not in ("high", "3"):
                continue

            e["_dt"] = parse_event_time(e["date"])
            result.append(e)
        except Exception:
            # wenn ein Eintrag spinnt, einfach ignorieren
            continue

    return result


def process_events(usd_high_events: List[Dict[str, Any]]) -> datetime | None:
    """
    Sendet neue Events an Discord und gibt die Zeit des nächsten
    zukünftigen USD-High-Impact-Events zurück.
    """
    now = datetime.now(timezone.utc)
    next_future_time: datetime | None = None

    for event in usd_high_events:
        try:
            event_time: datetime = event["_dt"]
            title = event.get("title", "Unbekanntes Event")

            # Key zur Erkennung von Duplikaten
            key = f"{event.get('country')}|{title}|{event.get('date')}"

            # Nur senden, wenn Zeit erreicht/vergangen & noch nicht gesendet
            if event_time <= now and key not in sent_events:
                sent_events.add(key)

                forecast = event.get("forecast")
                previous = event.get("previous")
                impact = event.get("impact")

                text_lines = [
                    "📣 **USD News (High Impact)**",
                    f"**{title}**",
                    f"🕒 Zeit (UTC): `{event_time.isoformat()}`",
                    f"📊 Impact: {impact}",
                ]
                if forecast:
                    text_lines.append(f"🔮 Forecast: {forecast}")
                if previous:
                    text_lines.append(f"📁 Previous: {previous}")

                content = "\n".join(text_lines)
                send_discord_message(content)

            # Merke nächstes Event in der Zukunft (für Sleep-Berechnung)
            if event_time > now and (next_future_time is None or event_time < next_future_time):
                next_future_time = event_time

        except Exception as e:
            logger.error("Fehler bei Event-Verarbeitung: %s", e)

    return next_future_time


# ======================================================
#                 HAUPT-LOOP
# ======================================================

def main() -> None:
    poll_interval = BASE_POLL_INTERVAL

    while True:
        try:
            logger.info("🔎 Prüfe USD High-Impact News ...")

            events = fetch_calendar()
            usd_high_events = get_usd_high_events(events)

            next_time = process_events(usd_high_events)
            logger.info("✅ High-Impact-Check abgeschlossen.")

            # Polling-Intervall je nach nächstem Event anpassen
            if next_time:
                now = datetime.now(timezone.utc)
                diff = (next_time - now).total_seconds()

                # je nach Abstand zum nächsten Event schlafen wir länger oder kürzer
                if diff > 60 * 60:          # > 1h
                    poll_interval = min(MAX_POLL_INTERVAL, 10 * 60)
                elif diff > 10 * 60:        # 10–60min
                    poll_interval = 5 * 60
                elif diff > 60:             # 1–10min
                    poll_interval = 60
                else:                       # < 1min
                    poll_interval = 30
            else:
                # keine zukünftigen Events -> wir können lange schlafen
                poll_interval = MAX_POLL_INTERVAL

        except RateLimitError as e:
            # Wenn ForexFactory uns sagt wie lange wir warten sollen -> halten wir uns dran
            if e.retry_after:
                poll_interval = max(e.retry_after, BASE_POLL_INTERVAL)
            else:
                # Exponentielles Backoff, aber mit Obergrenze
                poll_interval = min(poll_interval * 2, MAX_POLL_INTERVAL)

            logger.warning(
                "⚠️ Rate Limit erreicht. Warte %s Sekunden ...", poll_interval
            )

        except Exception as e:
            # Unerwartete Fehler nur loggen, damit der Loop weiterläuft
            logger.error("❌ Unerwarteter Fehler im Loop: %s", e)

        logger.info("⏱️ Schlafe %s Sekunden ...", poll_interval)
        time.sleep(poll_interval)


if __name__ == "__main__":
    main()