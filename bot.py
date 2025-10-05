# bot.py
"""
Telegram Weather Bot + OpenWeatherMap + Gemini (google.genai)
Features:
 - /search <city|lat,lon>
 - /perhour <city|lat,lon>         -> hourly notification (short AI recommendation)
 - /perhour_stop <city|lat,lon>
 - /perday <city|lat,lon>          -> daily notification at 08:00 local time (extended AI recommendation)
 - /perday_stop <city|lat,lon>
 - /subscriptions                  -> list all active subscriptions

Requirements:
 pip install pyTelegramBotAPI requests python-dotenv google-genai apscheduler
"""

import os
import json
import logging
from datetime import datetime, timedelta, timezone
import requests
import telebot
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.jobstores.base import JobLookupError

# dotenv
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# Gemini
try:
    from google import genai
except Exception:
    genai = None

# Config
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
OPENWEATHER_KEY = os.getenv("OPENWEATHER_KEY")
GENAI_KEY = os.getenv("GENAI_API_KEY") or os.getenv("GOOGLE_API_KEY")

if not TELEGRAM_TOKEN or not OPENWEATHER_KEY:
    raise SystemExit("Please set TELEGRAM_TOKEN and OPENWEATHER_KEY environment variables.")

SUBS_FILE = "subscriptions.json"
bot = telebot.TeleBot(TELEGRAM_TOKEN, parse_mode="HTML")
logging.basicConfig(level=logging.INFO)

# Scheduler (UTC)
scheduler = BackgroundScheduler(timezone=timezone.utc)
scheduler.start()


# ----------------- OpenWeather helpers -----------------
def geocode_city(city_name):
    url = "http://api.openweathermap.org/geo/1.0/direct"
    params = {"q": city_name, "limit": 1, "appid": OPENWEATHER_KEY}
    r = requests.get(url, params=params, timeout=20)
    r.raise_for_status()
    data = r.json()
    if not data:
        return None
    item = data[0]
    name = item.get("name")
    country = item.get("country")
    state = item.get("state")
    display = f"{name}{', ' + state if state else ''}, {country}"
    return item.get("lat"), item.get("lon"), display


def get_current_weather(lat, lon):
    url = "https://api.openweathermap.org/data/2.5/weather"
    params = {"lat": lat, "lon": lon, "appid": OPENWEATHER_KEY, "units": "metric", "lang": "en"}
    r = requests.get(url, params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def get_air_quality(lat, lon):
    url = "http://api.openweathermap.org/data/2.5/air_pollution"
    params = {"lat": lat, "lon": lon, "appid": OPENWEATHER_KEY}
    r = requests.get(url, params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def get_forecast_3h(lat, lon):
    url = "https://api.openweathermap.org/data/2.5/forecast"
    params = {"lat": lat, "lon": lon, "appid": OPENWEATHER_KEY, "units": "metric", "lang": "en"}
    r = requests.get(url, params=params, timeout=20)
    r.raise_for_status()
    return r.json()


# ----------------- Data processing -----------------
def map_aqi_to_label(aqi_value):
    mapping = {1: "Good", 2: "Fair", 3: "Moderate", 4: "Poor", 5: "Very Poor"}
    return mapping.get(aqi_value, "Unknown")


def pick_day_segments(forecast_json, tz_offset_seconds):
    entries = forecast_json.get("list", [])
    now_local = datetime.now(timezone.utc) + timedelta(seconds=tz_offset_seconds)
    target_date = now_local.date()
    if now_local.hour >= 21:
        target_date += timedelta(days=1)

    targets = {"Morning": 9, "Afternoon": 15, "Evening": 21}
    chosen = {}

    for seg_name, target_hour in targets.items():
        best, best_diff = None, None
        for e in entries:
            dt = datetime.fromtimestamp(e["dt"], timezone.utc) + timedelta(seconds=tz_offset_seconds)
            if dt.date() != target_date:
                continue
            diff = abs(dt.hour - target_hour)
            if best is None or diff < best_diff:
                best, best_diff = e, diff
        if best:
            dt_local = datetime.fromtimestamp(best["dt"], timezone.utc) + timedelta(seconds=tz_offset_seconds)
            chosen[seg_name] = {
                "time": dt_local.strftime("%Y-%m-%d %H:%M"),
                "temp": best["main"]["temp"],
                "desc": best.get("weather", [{}])[0].get("description", ""),
            }
    return chosen


def format_report(city_display, weather, aqi_data, forecast_segments):
    tz_seconds = weather.get("timezone", 0)
    local_time = datetime.now(timezone.utc) + timedelta(seconds=tz_seconds)
    local_time_str = local_time.strftime("%Y-%m-%d %H:%M")

    temp = weather.get("main", {}).get("temp")
    weather_desc = weather.get("weather", [{}])[0].get("description", "")
    aqi_list = aqi_data.get("list", [])
    if aqi_list:
        aqi_main = aqi_list[0].get("main", {}).get("aqi")
        components = aqi_list[0].get("components", {})
        pm25 = components.get("pm2_5")
        pm10 = components.get("pm10")
    else:
        aqi_main = pm25 = pm10 = None
    aqi_label = map_aqi_to_label(aqi_main)

    lines = [
        f"<b>🏙 City:</b> <i>{city_display}</i>",
        f"<b>🕒 Local time:</b> <i>{local_time_str}</i>",
        f"<b>🌡 Current temperature:</b> <i>{temp}°C — {weather_desc}</i>",
        f"<b>🌫 AQI:</b> <i>{aqi_label} ({aqi_main})</i>",
        f"<b>PM2.5:</b> <i>{pm25} µg/m³</i>",
        f"<b>PM10:</b> <i>{pm10} µg/m³</i>",
        "",
        "<b>📈 Forecast (next day):</b>",
    ]

    for seg in ["Morning", "Afternoon", "Evening"]:
        s = forecast_segments.get(seg)
        if s:
            lines.append(f"<i>{seg} ({s['time']}): {s['temp']}°C, {s['desc']}</i>")
        else:
            lines.append(f"<i>{seg}: no data</i>")

    report = "\n".join(lines)
    return report, {
        "city": city_display,
        "local_time": local_time_str,
        "temp": temp,
        "weather_desc": weather_desc,
        "aqi": aqi_main,
        "aqi_label": aqi_label,
        "pm25": pm25,
        "pm10": pm10,
        "forecast_segments": forecast_segments,
    }


# ----------------- Gemini helper -----------------
def gemini_recommendation(data_dict, verbosity="short"):
    if genai is None:
        return "<i>Gemini not available (module not installed).</i>"
    api_key = GENAI_KEY
    if not api_key:
        return "<i>GENAI_API_KEY not found.</i>"

    client = genai.Client(api_key=api_key)
    instr = (
        "Write one short English sentence with advice."
        if verbosity == "short"
        else "Write 2-4 sentences in English about weather and air quality advice."
    )

    prompt = (
        f"{instr}\nCity: {data_dict.get('city')}\n"
        f"Temp: {data_dict.get('temp')}°C — {data_dict.get('weather_desc')}\n"
        f"AQI: {data_dict.get('aqi_label')} ({data_dict.get('aqi')}); "
        f"PM2.5: {data_dict.get('pm25')} µg/m³; PM10: {data_dict.get('pm10')} µg/m³"
    )

    try:
        response = client.models.generate_content(model="gemini-2.0-flash", contents=prompt)
        return f"<i>{response.text.strip()}</i>"
    except Exception as e:
        return f"<i>(Gemini error: {e})</i>"


# ----------------- Scheduler + Notifications -----------------
def job_send_notification(chat_id, lat, lon, display, sub_type):
    try:
        weather = get_current_weather(lat, lon)
        aqi = get_air_quality(lat, lon)
        forecast = get_forecast_3h(lat, lon)
        tz_offset = weather.get("timezone", 0)
        segments = pick_day_segments(forecast, tz_offset)
        report_text, data_dict = format_report(display, weather, aqi, segments)
        ai_text = gemini_recommendation(data_dict, "short" if sub_type == "perhour" else "long")
        final_msg = f"{report_text}\n\n🤖 <b>AI Recommendation:</b>\n{ai_text}"
        bot.send_message(chat_id, final_msg)
    except Exception as e:
        bot.send_message(chat_id, f"<i>Error: {e}</i>")


# ----------------- Commands -----------------
@bot.message_handler(commands=["start", "help"])
def send_welcome(message):
    kb = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True)
    kb.add(telebot.types.KeyboardButton("📍 Send location", request_location=True))
    bot.send_message(
        message.chat.id,
        "<b>Hi! 🌤 I'm your Weather Bot.</b>\n\n"
        "<i>Use commands:</i>\n"
        "/search <city|lat,lon>\n"
        "/perhour <city|lat,lon>\n"
        "/perday <city|lat,lon>\n"
        "/subscriptions\n\n"
        "You can also send your location.",
        reply_markup=kb,
    )


@bot.message_handler(commands=["search"])
def handle_search(message):
    parts = message.text.split(maxsplit=1)
    if len(parts) < 2:
        bot.reply_to(message, "<i>Usage: /search London or /search 41.3,69.2</i>")
        return
    loc = parts[1]
    lat, lon, display = geocode_city(loc) if "," not in loc else (float(loc.split(",")[0]), float(loc.split(",")[1]), f"Coordinates: {loc}")
    weather = get_current_weather(lat, lon)
    aqi = get_air_quality(lat, lon)
    forecast = get_forecast_3h(lat, lon)
    tz_offset = weather.get("timezone", 0)
    segments = pick_day_segments(forecast, tz_offset)
    report_text, data_dict = format_report(display, weather, aqi, segments)
    ai = gemini_recommendation(data_dict, "long")
    bot.send_message(message.chat.id, report_text + "\n\n🤖 <b>AI Recommendation:</b>\n" + ai)


@bot.message_handler(content_types=["location"])
def handle_location(message):
    lat, lon = message.location.latitude, message.location.longitude
    display = f"Coordinates: {lat:.4f}, {lon:.4f}"
    weather = get_current_weather(lat, lon)
    aqi = get_air_quality(lat, lon)
    forecast = get_forecast_3h(lat, lon)
    tz_offset = weather.get("timezone", 0)
    segments = pick_day_segments(forecast, tz_offset)
    report_text, data_dict = format_report(display, weather, aqi, segments)
    ai = gemini_recommendation(data_dict, "long")
    bot.send_message(message.chat.id, report_text + "\n\n🤖 <b>AI Recommendation:</b>\n" + ai)


if __name__ == "__main__":
    logging.info("Bot started.")
    bot.infinity_polling(skip_pending=True)
