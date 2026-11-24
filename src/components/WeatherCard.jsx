import styles from './WeatherCard.module.css'
import { formatWeatherTime, getWeatherLighting } from '../hooks/useWeather.js'

const READINGS = [
  { key: 'temperature', label: 'Temperature', unit: '°C', digits: 1 },
  { key: 'humidity', label: 'Humidity', unit: '%', digits: 0 },
  { key: 'pressure', label: 'Pressure', unit: 'hPa', digits: 1 },
  { key: 'rainfall', label: 'Precipitation · weather', unit: 'mm / h', digits: 1 },
]

function weatherFailureMessage(error) {
  if (error === 'api-key-rejected') return 'The key is not accepted yet. Check OpenWeather activation.'
  if (error === 'server-key-missing') return 'The server is missing its OpenWeather configuration.'
  if (error === 'rate-limited') return 'OpenWeather rate limit reached. Try again shortly.'
  return 'OpenWeather feed unavailable'
}

function WeatherGlyph({ type, className }) {
  const condition = String(type ?? '').toLowerCase()
  let artwork

  if (condition === 'temperature') {
    artwork = <><path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0Z" /><path d="M12 17V8" /></>
  } else if (condition === 'humidity') {
    artwork = <><path d="M12 3.5S5.5 10.2 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 10.2 12 3.5 12 3.5Z" /><path d="M9 15.5a3 3 0 0 0 3 3" /></>
  } else if (condition === 'warning') {
    artwork = <><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4m0 3h.01" /></>
  } else if (condition === 'pressure') {
    artwork = <><circle cx="12" cy="12" r="8.5" /><path d="M12 12 16.5 8M7.5 16.5h9M12 3.5v2" /></>
  } else if (condition === 'rainfall' || condition === 'rain' || condition === 'drizzle') {
    artwork = <><path d="M7.5 15.5a4 4 0 0 1-.2-8A5.5 5.5 0 0 1 18 9a3.3 3.3 0 0 1-.3 6.5" /><path d="m9 18-1 2M13 18l-1 2M17 18l-1 2" /></>
  } else if (condition.includes('thunder')) {
    artwork = <><path d="M7.5 14.5a4 4 0 0 1-.2-8A5.5 5.5 0 0 1 18 8a3.3 3.3 0 0 1-.3 6.5" /><path d="m13 13-3 5h3l-1 3 4-6h-3l1-2" /></>
  } else if (condition === 'snow') {
    artwork = <><path d="M7.5 14a4 4 0 0 1-.2-8A5.5 5.5 0 0 1 18 7.5a3.3 3.3 0 0 1-.3 6.5" /><path d="M9 17v4M7.3 18l3.4 2M10.7 18l-3.4 2M16 17v4M14.3 18l3.4 2M17.7 18l-3.4 2" /></>
  } else if (condition === 'clear') {
    artwork = <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2.5 12h2m15 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>
  } else {
    artwork = <path d="M7.5 18a4.5 4.5 0 0 1-.4-9 6 6 0 0 1 11.5 1.5A3.8 3.8 0 0 1 18 18Z" />
  }

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {artwork}
    </svg>
  )
}

export default function WeatherCard({
  sensor,
  online,
  weather,
  forecast,
  weatherLoading,
  weatherError,
}) {
  const hasLiveSensor = online && sensor?._isMock !== true
  const lighting = getWeatherLighting(weather)

  return (
    <section className={styles.weatherCard} aria-label="Environmental readings and weather forecast">
      <header className={styles.cardHeader}>
        <div>
          <h2>Environmental readings</h2>
          <p>OpenWeather conditions and forecast</p>
        </div>
        <span className={styles.providerTag}>OpenWeather</span>
      </header>

      <div className={styles.currentWeather} aria-live="polite">
        <span className={styles.currentGlyph}>
          <WeatherGlyph type={weather?.main ?? 'clouds'} />
        </span>
        <div className={styles.currentDetails}>
          <span className={styles.currentEyebrow}>
            {weather ? `${weather.city} · Current weather` : 'Current weather'}
          </span>
          <strong>{weather ? `${weather.temp}°C` : weatherLoading ? 'Loading…' : 'Unavailable'}</strong>
          <span className={styles.currentDescription}>
            {weather
              ? `${weather.description} · feels like ${weather.feelsLike}°C`
              : weatherLoading ? 'Connecting to OpenWeather' : weatherError ? 'See forecast status below' : 'Weather details unavailable'}
          </span>
        </div>
        {weather && <span className={styles.currentPhase}>{lighting.phase}</span>}
      </div>

      <div className={styles.readings}>
        {READINGS.map(({ key, label, unit, digits }) => {
          const weatherKey = key === 'temperature' ? 'temp'
            : key === 'rainfall' ? 'precipitation'
              : key
          const rawValue = weather?.[weatherKey]
          const available = Number.isFinite(rawValue)
          const value = available ? rawValue.toFixed(digits) : '--'

          return (
            <div className={styles.reading} key={key}>
              <span className={styles.iconFrame}>
                <WeatherGlyph type={key} />
              </span>
              <span className={styles.readingLabel}>{label}</span>
              <span className={styles.readingValue}>
                {value}<span className={styles.readingUnit}>{unit}</span>
              </span>
            </div>
          )
        })}
      </div>

      {weather && (
        <div className={styles.weatherDetails}>
          <span>{weather.cloudCover}% cloud cover</span>
          <span>Wind {weather.windSpeed} m/s</span>
          <span>Observed {formatWeatherTime(weather.observedAt, weather.timezoneOffset)}</span>
        </div>
      )}

      <section className={styles.forecast} aria-label="Five-day weather forecast">
        <header className={styles.forecastHeader}>
          <h3>5-day forecast</h3>
          {forecast?.length > 0 && <span> Daily high / low · rain chance</span>}
        </header>
        {' '}
        {forecast?.length ? (
          <div className={styles.forecastGrid}>
            {forecast.map(day => (
              <article className={styles.forecastDay} key={day.day}>
                <span className={styles.forecastLabel}>{day.day}</span>
                <WeatherGlyph type={day.main} className={styles.forecastGlyph} />
                <strong>{day.high}°</strong>
                <span className={styles.forecastLow}>{day.low}°</span>
                <span className={styles.forecastChance}>{day.precipitationChance}%</span>
              </article>
            ))}
          </div>
        ) : (
          <div className={styles.forecastEmpty} role="status">
            <WeatherGlyph type={weatherError ? 'warning' : 'clouds'} className={styles.forecastStatusIcon} />
            <span>
              {weatherLoading
                ? 'Loading forecast…'
                : weatherError
                  ? `Forecast unavailable. ${weatherFailureMessage(weatherError)}`
                  : 'Forecast data unavailable'}
            </span>
          </div>
        )}
      </section>

      <footer className={styles.sensorStatus}>
        <span>On-site measurements</span>
        {' '}
        <span className={styles.statusText}>
          <i className={`${styles.statusDot} ${hasLiveSensor ? styles.statusOnline : ''}`} />
          {hasLiveSensor ? 'Sensor online' : 'Sensor offline'}
        </span>
      </footer>
    </section>
  )
}
