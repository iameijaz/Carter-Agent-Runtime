/**
 * Weather tool — uses wttr.in (free, no API key).
 * Returns current conditions + 3-day forecast as structured data.
 * The frontend renders it as a weather card via the ```weather block.
 */

export interface WeatherCondition {
  location: string;
  temp_c: number;
  feels_like_c: number;
  description: string;
  humidity: number;
  wind_kmh: number;
  wind_dir: string;
  visibility_km: number;
  uv_index: number;
  icon: string;
}

export interface ForecastDay {
  date: string;
  max_c: number;
  min_c: number;
  description: string;
  rain_mm: number;
  icon: string;
}

export interface WeatherData {
  current: WeatherCondition;
  forecast: ForecastDay[];
  source: string;
}

const ICON_MAP: Record<string, string> = {
  "Sunny": "☀️", "Clear": "🌙", "Partly cloudy": "⛅", "Cloudy": "☁️",
  "Overcast": "☁️", "Mist": "🌫️", "Fog": "🌫️", "Light rain": "🌦️",
  "Moderate rain": "🌧️", "Heavy rain": "⛈️", "Light snow": "🌨️",
  "Moderate snow": "❄️", "Heavy snow": "❄️", "Thunderstorm": "⛈️",
  "Blizzard": "🌨️", "Light drizzle": "🌦️", "Freezing drizzle": "🌧️",
  "Patchy rain possible": "🌦️", "Blowing snow": "❄️",
};

function icon(desc: string): string {
  for (const [k, v] of Object.entries(ICON_MAP)) {
    if (desc.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return "🌡️";
}

export async function getWeather(location: string): Promise<WeatherData> {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Carter/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`wttr.in HTTP ${res.status}`);
  const d = await res.json() as any;

  const cur = d.current_condition?.[0];
  const area = d.nearest_area?.[0];
  const locName = [
    area?.areaName?.[0]?.value,
    area?.country?.[0]?.value,
  ].filter(Boolean).join(", ") || location;

  const current: WeatherCondition = {
    location:      locName,
    temp_c:        Number(cur?.temp_C ?? 0),
    feels_like_c:  Number(cur?.FeelsLikeC ?? 0),
    description:   cur?.weatherDesc?.[0]?.value ?? "",
    humidity:      Number(cur?.humidity ?? 0),
    wind_kmh:      Number(cur?.windspeedKmph ?? 0),
    wind_dir:      cur?.winddir16Point ?? "",
    visibility_km: Number(cur?.visibility ?? 0),
    uv_index:      Number(cur?.uvIndex ?? 0),
    icon:          icon(cur?.weatherDesc?.[0]?.value ?? ""),
  };

  const forecast: ForecastDay[] = (d.weather ?? []).slice(0, 3).map((day: any) => ({
    date:        day.date,
    max_c:       Number(day.maxtempC),
    min_c:       Number(day.mintempC),
    description: day.hourly?.[4]?.weatherDesc?.[0]?.value ?? "",
    rain_mm:     Number(day.hourly?.[4]?.precipMM ?? 0),
    icon:        icon(day.hourly?.[4]?.weatherDesc?.[0]?.value ?? ""),
  }));

  return { current, forecast, source: "wttr.in" };
}
