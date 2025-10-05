"use strict";

// 🌍 OpenWeather config
const apiKey = "f17cf39a84e70e760b06d5ad4ceae310";
const apiUrl = "https://api.openweathermap.org/data/2.5/";
const WAQI_TILE_TOKEN = "aa62c304b08d1f7f5d8f536a3ae6061424eb01cf";

// 🤖 Gemini API config (рабочий)
const GEMINI_API_KEY = "AIzaSyBQO89TC_kEQwSt7lqQJIwy7m5yaCw3y2g";
const GEMINI_MODEL = "gemini-2.0-flash";

const AQI_RANGES = {
  1: { status: "Good", color: "#38a169" },
  2: { status: "Fair", color: "#d69e2e" },
  3: { status: "Moderate", color: "#dd6b20" },
  4: { status: "Poor", color: "#e53e3e" },
  5: { status: "Very Poor", color: "#805ad5" },
};

let hourlyChart, map, marker;

// 🌤 Get weather by city
async function getWeather(city) {
  const url = `${apiUrl}weather?q=${city}&appid=${apiKey}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather fetch failed: ${res.status}`);
  return await res.json();
}

// 💨 Get air pollution
async function getAQI(lat, lon) {
  const url = `${apiUrl}air_pollution?lat=${lat}&lon=${lon}&appid=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AQI fetch failed: ${res.status}`);
  return await res.json();
}
async function getForecast(lat, lon) {
  const url = `${apiUrl}forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast fetch failed: ${res.status}`);
  return await res.json();
}

// 🗺️ Map setup
function initMap() {
  map = L.map("map").setView([41.3123, 69.2787], 6);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors & CartoDB',}).addTo(map);


  L.tileLayer(
    `https://tiles.waqi.info/tiles/usepa-aqi/{z}/{x}/{y}.png?token=${WAQI_TILE_TOKEN}`,
    {
      attribution: 'Air Quality Tiles © <a href="https://waqi.info">waqi.info</a>',
      opacity: 0.7,
    }
  ).addTo(map);

  marker = L.marker([41.3123, 69.2787]).addTo(map);

  map.on("click", async (e) => {
    const { lat, lng } = e.latlng;
    marker.setLatLng([lat, lng]);
    document.getElementById("input").value = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    await showWeatherByCoords(lat, lng);
  });
}

// 🌍 Show weather (by city or coords)
async function showWeather() {
  const city = document.getElementById("input").value.trim() || "Tashkent";
  if (!city) return;
  try {
    const data = await getWeather(city);
    await renderWeather(data);
  } catch (err) {
    alert("Could not fetch weather data for " + city);
  }
}

async function showWeatherByCoords(lat, lon) {
  const url = `${apiUrl}weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;
  const res = await fetch(url);
  const data = await res.json();
  await renderWeather(data);
}

// 🧩 Render UI
async function renderWeather(data) {
  const lat = data.coord.lat;
  const lon = data.coord.lon;
  const temperature = Math.round(data.main.temp);
  const humidity = data.main.humidity;
  if (map && marker) {
    marker.setLatLng([lat, lon]);
    map.setView([lat, lon], 10); // zoom = 10 (можно изменить)
  }

  const aqiData = await getAQI(lat, lon);
  const aqi = aqiData.list[0].main.aqi;
  const aqiInfo = AQI_RANGES[aqi];

  document.querySelector(".city__title").textContent = data.name;
  document.querySelector(".city__coordinates").textContent = `${lat.toFixed(2)}°N, ${lon.toFixed(2)}°E`;
  document.getElementById("temp").textContent = `${temperature}°C`;
  document.getElementById("humidity").textContent = `${humidity}%`;
  document.getElementById("so2").textContent = `PM2.5: ${aqiData.list[0].components.pm2_5} μg/m³`;
  document.getElementById("pm10").textContent = `PM10: ${aqiData.list[0].components.pm10} μg/m³`;
  document.getElementById("aqi-value").textContent = aqi;
  document.getElementById("aqi-status").textContent = aqiInfo.status;

  const aqiColumn = document.getElementById("aqiColumn");
  aqiColumn.style.backgroundColor = aqiInfo.color;

  await updateChart(lat, lon);
  await explainWeather(data.name, temperature, humidity, aqi, aqiInfo.status);
}

// ---------- Исправленная и надёжная инициализация графика ----------
function initializeChart() {
  const canvas = document.getElementById('myChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (hourlyChart) {
    try { hourlyChart.destroy(); } catch (e) {}
    hourlyChart = null;
  }

  const labels = [ "00:00","02:00","04:00","06:00","08:00","10:00","12:00","14:00","16:00","18:00","20:00","22:00" ];

  const config = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Temperature (°C)",
          data: Array(labels.length).fill(0),
          borderColor: "#2563eb",
          backgroundColor: "rgba(37,99,235,0.12)",
          yAxisID: "y1",
          tension: 0.3,
          fill: false,
          pointRadius: 2,
        },
        {
          label: "AQI",
          data: Array(labels.length).fill(0),
          borderColor: "#10b981",
          backgroundColor: "rgba(16,185,129,0.12)",
          yAxisID: "y2",
          tension: 0.3,
          fill: false,
          pointRadius: 2,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom" } },
      scales: {
        x: { title: { display: true, text: "Time" } },
        y1: {
          type: "linear",
          position: "left",
          title: { display: true, text: "Temperature (°C)" },
          ticks: { precision: 0 }
        },
        y2: {
          type: "linear",
          position: "right",
          grid: { drawOnChartArea: false },
          title: { display: true, text: "AQI" },
          ticks: { precision: 0 }
        }
      }
    }
  };

  hourlyChart = new Chart(ctx, config);
}

// ---------- Исправленное обновление графика ----------
// 📊 Update chart with real data from OpenWeather
async function updateChart(lat, lon) {
  try {
    const forecast = await getForecast(lat, lon);

    const labels = [];
    const temps = [];
    const humidities = [];

    // Берём первые 12 интервалов (≈ 36 часов)
    forecast.list.slice(0, 12).forEach((f) => {
      const time = new Date(f.dt * 1000);
      const hour = time.getHours().toString().padStart(2, "0") + ":00";
      labels.push(hour);
      temps.push(Math.round(f.main.temp));
      humidities.push(f.main.humidity);
    });

    // если график не создан — создаём новый
    if (!hourlyChart) {
      const ctx = document.getElementById("myChart").getContext("2d");
      hourlyChart = new Chart(ctx, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Temperature (°C)",
              data: temps,
              borderColor: "#2563eb",
              backgroundColor: "rgba(37,99,235,0.12)",
              yAxisID: "y1",
              tension: 0.3,
            },
            {
              label: "Humidity (%)",
              data: humidities,
              borderColor: "#10b981",
              backgroundColor: "rgba(16,185,129,0.12)",
              yAxisID: "y2",
              tension: 0.3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { position: "bottom" } },
          scales: {
            x: { title: { display: true, text: "Time" } },
            y1: {
              type: "linear",
              position: "left",
              title: { display: true, text: "Temperature (°C)" },
              ticks: { precision: 0 },
            },
            y2: {
              type: "linear",
              position: "right",
              grid: { drawOnChartArea: false },
              title: { display: true, text: "Humidity (%)" },
              ticks: { precision: 0 },
            },
          },
        },
      });
    } else {
      // просто обновляем данные
      hourlyChart.data.labels = labels;
      hourlyChart.data.datasets[0].data = temps;
      hourlyChart.data.datasets[1].data = humidities;
      hourlyChart.update();
    }
  } catch (err) {
    console.warn("Chart update failed:", err);
  }
}


// 🕒 Time
function getTime() {
  const now = new Date();
  document.getElementById("time").textContent = now.toISOString().split("T")[0];
}

// 🤖 Gemini AI (из твоего рабочего кода)
function parseGeminiText(resp) {
  if (!resp) return null;
  const paths = [
    () => resp?.candidates?.[0]?.content?.parts?.[0]?.text,
    () => resp?.candidates?.[0]?.output_text,
    () => resp?.candidates?.[0]?.text,
  ];
  for (const p of paths) {
    try {
      const v = p();
      if (v && typeof v === "string" && v.trim()) return v.trim();
    } catch {}
  }
  return null;
}

async function queryGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gemini API error");
  const text = parseGeminiText(data);
  if (!text) throw new Error("Empty response");
  return text;
}

// 🧠 Ask AI manually
async function askAI(prompt) {
  const aiSend = document.getElementById("ai-send");
  const aiOut = document.getElementById("ai-output");
  aiSend.disabled = true;
  aiOut.textContent = "⌛ Thinking...";
  try {
    aiOut.textContent = await queryGemini(prompt);
  } catch (err) {
    aiOut.textContent = "Error: " + err.message;
  } finally {
    aiSend.disabled = false;
  }
}

// 🧩 Auto explanation when weather updates
async function explainWeather(city, temp, humidity, aqi, status) {
  const prompt = `
    City: ${city}.
    Temperature: ${temp}°C.
    Humidity: ${humidity}%.
    Air Quality Index: ${aqi} (${status}).
    Give short health recommendation — can people exercise outdoors, and any precautions to take.
  `;
  document.getElementById("ai-output").textContent = "Thinking...";
  try {
    const explanation = await queryGemini(prompt);
    document.getElementById("ai-output").textContent = explanation;
  } catch (err) {
    document.getElementById("ai-output").textContent = "AI Error: " + err.message;
  }
}

// 💬 Event listeners for AI chat
document.getElementById("ai-send")?.addEventListener("click", async () => {
  const input = document.getElementById("ai-input").value.trim();
  if (!input) return;
  await askAI(input);
});

document.getElementById("ai-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("ai-send").click();
  }
});

// 🚀 Initialize
window.onload = function () {
  getTime();
  initializeChart();
  initMap();
  document.getElementById("search-button").addEventListener("click", showWeather);
  document.getElementById("input").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      showWeather();
    }
  });
  // document.getElementById("input").value = "Tashkent";
  showWeather();
};
