// Weather data is fetched through the Express proxy; the API key stays server-side.

import { useState, useEffect } from 'react'

function normalizeCurrentWeather(weather) {
  const condition = weather.weather[0]
  return {
    temp: Math.round(weather.main.temp),
    feelsLike: Math.round(weather.main.feels_like),
    humidity: weather.main.humidity,
    pressure: weather.main.pressure,
    description: condition.description,
    main: condition.main,
    windSpeed: weather.wind.speed,
    visibility: weather.visibility,
    sunrise: weather.sys.sunrise,
    sunset: weather.sys.sunset,
    cloudCover: weather.clouds?.all ?? 0,
    precipitation: (weather.rain?.['1h'] ?? 0) + (weather.snow?.['1h'] ?? 0),
    observedAt: weather.dt,
    timezoneOffset: weather.timezone ?? 0,
    city: weather.name,
  }
}

function groupForecastByDay(items, timezoneOffset) {
  const days = new Map()
  for (const item of items) {
    const localDate = new Date((item.dt + timezoneOffset) * 1000)
    const dateKey = localDate.toISOString().slice(0, 10)
    const day = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: 'UTC',
    }).format(localDate)
    const localHour = localDate.getUTCHours() + localDate.getUTCMinutes() / 60
    const group = days.get(dateKey)
    const low = item.main.temp_min ?? item.main.temp
    const high = item.main.temp_max ?? item.main.temp
    const chance = Math.round((item.pop ?? 0) * 100)

    if (!group) {
      days.set(dateKey, {
        day,
        selected: item,
        middayDistance: Math.abs(localHour - 12),
        low,
        high,
        precipitationChance: chance,
      })
      continue
    }

    group.low = Math.min(group.low, low)
    group.high = Math.max(group.high, high)
    group.precipitationChance = Math.max(group.precipitationChance, chance)
    if (Math.abs(localHour - 12) < group.middayDistance) {
      group.selected = item
      group.middayDistance = Math.abs(localHour - 12)
    }
  }

  return [...days.values()].slice(0, 5).map(group => ({
    day: group.day,
    temp: Math.round(group.selected.main.temp),
    low: Math.round(group.low),
    high: Math.round(group.high),
    precipitationChance: group.precipitationChance,
    main: group.selected.weather[0].main,
    desc: group.selected.weather[0].description,
  }))
}

export function useWeather() {
  const [weather, setWeather] = useState(null)
  const [forecast, setForecast] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let retryTimer = null
    let refreshTimer = null
    let failedAttempts = 0
    let active = true
    const retryDelays = [3000, 6000, 12000, 20000]

    async function attempt() {
      try {
        const [wRes, fRes] = await Promise.all([
          fetch('/api/weather'),
          fetch('/api/forecast'),
        ])
        if (!wRes.ok || !fRes.ok) {
          const status = !wRes.ok ? wRes.status : fRes.status
          if (status === 401) throw new Error('api-key-rejected')
          if (status === 429) throw new Error('rate-limited')
          if (status === 503) throw new Error('server-key-missing')
          throw new Error('fetch-error')
        }
        const [w, f] = await Promise.all([wRes.json(), fRes.json()])
        if (!active) return
        const timezoneOffset = f.city?.timezone ?? w.timezone ?? 0
        setWeather(normalizeCurrentWeather(w))
        setForecast(groupForecastByDay(f.list ?? [], timezoneOffset))
        setError(null)
        setLoading(false)
        failedAttempts = 0
        clearTimeout(retryTimer)
        clearTimeout(refreshTimer)
        refreshTimer = setTimeout(attempt, 10 * 60 * 1000)
      } catch (requestError) {
        if (!active) return
        setLoading(false)
        const reason = requestError.message
        setError(['api-key-rejected', 'rate-limited', 'server-key-missing'].includes(reason)
          ? reason
          : 'fetch-error')
        if (reason === 'server-key-missing') return
        if (reason === 'api-key-rejected' || reason === 'rate-limited') {
          retryTimer = setTimeout(attempt, 5 * 60 * 1000)
          return
        }
        if (failedAttempts < retryDelays.length) {
          retryTimer = setTimeout(attempt, retryDelays[failedAttempts])
          failedAttempts++
        }
      }
    }

    attempt()

    return () => {
      active = false
      clearTimeout(retryTimer)
      clearTimeout(refreshTimer)
    }
  }, [])

  return { weather, forecast, loading, error }
}

export function getWeatherLighting(weather) {
  const sunrise = weather?.sunrise
  const sunset = weather?.sunset
  const observedAt = weather?.observedAt ?? Date.now() / 1000
  if (!Number.isFinite(sunrise) || !Number.isFinite(sunset) || sunset <= sunrise) {
    return { phase: 'Daylight', azimuth: 180, polar: 48, intensity: 0.6, goldenHour: false }
  }

  const progress = Math.max(0, Math.min(1, (observedAt - sunrise) / (sunset - sunrise)))
  const isDay = observedAt >= sunrise && observedAt <= sunset
  const goldenHour = isDay && (progress < 0.16 || progress > 0.84)
  const phase = !isDay
    ? 'Night'
    : progress < 0.25
      ? 'Morning'
      : progress > 0.78
        ? 'Sunset'
        : 'Daylight'
  const elevation = Math.sin(progress * Math.PI) * 58
  const clouds = Math.max(0, Math.min(100, weather?.cloudCover ?? 0))

  return {
    phase,
    azimuth: 90 + progress * 180,
    polar: isDay ? 90 - elevation : 112,
    intensity: isDay ? Math.max(0.18, 0.78 - clouds / 220) : 0.08,
    goldenHour,
  }
}

export function formatWeatherTime(unixSeconds, timezoneOffset = 0) {
  if (!Number.isFinite(unixSeconds)) return '--:--'
  return new Date((unixSeconds + timezoneOffset) * 1000).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  })
}

// Map OWM condition → icon
export function getWeatherIcon(main) {
  const map = {
    'Thunderstorm': '/icons/6.png',
    'Drizzle':      '/icons/1.png',
    'Rain':         '/icons/6.png',
    'Snow':         '/icons/1.png',
    'Clear':        '/icons/1.png',
    'Clouds':       '/icons/1.png',
  }
  return map[main] || '/icons/1.png'
}

// Short flood-risk line based on condition
export function getFloodDesc(main) {
  if (main === 'Thunderstorm') return 'Thunderstorm\nHigh Flood Risk'
  if (main === 'Rain')         return 'Raining\nModerate Flood Risk'
  if (main === 'Drizzle')      return 'Light Rain\nLow Flood Risk'
  if (main === 'Clouds')       return 'Cloudy\nLow Chances of Flood'
  if (main === 'Clear')        return 'Clear Sky\nNo Flood Risk'
  return 'Partly Cloudy\nMonitor Conditions'
}
