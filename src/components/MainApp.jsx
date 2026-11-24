import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { gsap } from 'gsap'
import FloodAlert from './FloodAlert.jsx'
import DebugConsole from './DebugConsole.jsx'
import { useSensor } from '../hooks/useSensor.js'
import { useWeather } from '../hooks/useWeather.js'
import { useDarkMode } from '../hooks/useDarkMode.js'
import WeatherCard from './WeatherCard.jsx'
import styles from './MainApp.module.css'

const FloodTerrain3D = lazy(() => import('./FloodTerrain3D.jsx'))
const MapModal = lazy(() => import('./MapModal.jsx'))
const CHANNEL_M = 12.6
const HISTORY_RANGES = [
  { hours: 1, label: '1h' },
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
]

function statusForLevel(level) {
  if (level >= 9.45) return 'DANGEROUS'
  if (level >= 6.30) return 'CRITICAL'
  if (level >= 3.15) return 'MODERATE'
  return 'SAFE'
}

function statusLabel(status) {
  if (status === 'MODERATE') return 'Advisory'
  if (status === 'CRITICAL') return 'Warning'
  if (status === 'DANGEROUS') return 'Critical'
  if (status === 'SAFE') return 'Normal'
  return 'Unknown'
}

function formatTime(timestamp, options = {}) {
  if (!Number.isFinite(timestamp)) return '—'
  return new Date(timestamp).toLocaleString([], options)
}

function getTrend(history) {
  if (history.length < 2) return { direction: 'steady', rate: null }
  const first = history[0]
  const last = history[history.length - 1]
  const elapsedMinutes = (last.timestamp - first.timestamp) / 60000
  if (elapsedMinutes <= 0) return { direction: 'steady', rate: null }
  const change = last.waterLevelM - first.waterLevelM
  return {
    direction: change > 0.005 ? 'rising' : change < -0.005 ? 'falling' : 'steady',
    rate: (change / elapsedMinutes) * 1000,
  }
}

function HistoryChart({ history, rangeHours, onRangeChange }) {
  const rangeMs = rangeHours * 60 * 60 * 1000
  const now = Date.now()
  const cutoff = now - rangeMs
  const points = history.filter(point => point.timestamp >= cutoff && point.timestamp <= now)
  const stats = points.map(point => point.waterLevelM)
  const average = stats.length ? stats.reduce((sum, value) => sum + value, 0) / stats.length : null
  const min = stats.length ? Math.min(...stats) : null
  const max = stats.length ? Math.max(...stats) : null
  const trend = getTrend(points)

  const chartTop = 18
  const chartHeight = 155
  const chartLeft = 52
  const chartWidth = 636
  const yForLevel = level => chartTop + chartHeight * (1 - level / CHANNEL_M)
  const linePoints = points.map(point => {
    const x = chartLeft + ((point.timestamp - cutoff) / rangeMs) * chartWidth
    const y = yForLevel(point.waterLevelM)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const lastPoint = points[points.length - 1]

  return (
    <section className={styles.panel} id="history">
      <header className={styles.panelHeader}>
        <div>
          <h2>Water-level history</h2>
          <p>Measured readings · saved on this device</p>
        </div>
        <div className={styles.rangeSwitch} role="group" aria-label="History range">
          {HISTORY_RANGES.map(range => (
            <button
              type="button"
              key={range.hours}
              aria-pressed={rangeHours === range.hours}
              onClick={() => onRangeChange(range.hours)}
            >
              {range.label}
            </button>
          ))}
        </div>
      </header>

      <div className={styles.chartWrap}>
        <svg className={styles.historyChart} viewBox="0 0 720 198" role="img"
          aria-label={`Water-level history over ${rangeHours} hours`}>
          {[0, 3.15, 6.3, 9.45, 12.6].map((level, index) => {
            const y = yForLevel(level)
            return (
              <g key={level}>
                <line
                  x1={chartLeft}
                  x2={chartLeft + chartWidth}
                  y1={y}
                  y2={y}
                  className={index === 0 ? styles.chartAxis : styles.thresholdLine}
                />
                <text x="0" y={y + 4} className={styles.chartLabel}>{level === 0 ? '0 m' : level.toFixed(2)}</text>
              </g>
            )
          })}
          {points.length > 1 && (
            <polyline points={linePoints} className={styles.historyLine} />
          )}
          {lastPoint && (
            <circle
              cx={chartLeft + ((lastPoint.timestamp - cutoff) / rangeMs) * chartWidth}
              cy={yForLevel(lastPoint.waterLevelM)}
              r="4"
              className={styles.historyPoint}
            />
          )}
          <text x={chartLeft} y="193" className={styles.chartLabel}>
            {formatTime(cutoff, { hour: 'numeric', minute: '2-digit' })}
          </text>
          <text x={chartLeft + chartWidth} y="193" textAnchor="end" className={styles.chartLabel}>Now</text>
        </svg>
        {points.length === 0 && <div className={styles.chartEmpty}>No readings in this time range</div>}
      </div>

      <div className={styles.statsRow}>
        <div><span>Lowest</span><strong>{min == null ? '—' : `${min.toFixed(2)} m`}</strong></div>
        <div><span>Highest</span><strong>{max == null ? '—' : `${max.toFixed(2)} m`}</strong></div>
        <div><span>Average</span><strong>{average == null ? '—' : `${average.toFixed(2)} m`}</strong></div>
        <div><span>Rate of change</span><strong>{trend.rate == null ? '—' : `${trend.rate >= 0 ? '+' : ''}${trend.rate.toFixed(1)} cm / 10 min`}</strong></div>
      </div>
    </section>
  )
}

function getStatusChanges(history) {
  const changes = []
  for (let index = 1; index < history.length; index++) {
    const previous = statusForLevel(history[index - 1].waterLevelM)
    const current = statusForLevel(history[index].waterLevelM)
    if (previous !== current) {
      changes.push({ ...history[index], status: current })
    }
  }
  return changes.slice(-6).reverse()
}

function SensorDetails({ sensor, online, lastUpdated, onCalibrate, calibrationState, canCalibrate }) {
  const latitude = Number(sensor?.latitude)
  const longitude = Number(sensor?.longitude)
  const hasLocation = online && Number.isFinite(latitude) && Number.isFinite(longitude)
  const fields = [
    ['Connection', online ? 'Online' : 'Offline'],
    ['GPS position', hasLocation ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` : 'Unavailable'],
    ['Water distance', online && Number.isFinite(sensor?.distance) ? `${sensor.distance.toFixed(2)} m` : 'Unavailable'],
    ['Mount height', online && Number.isFinite(sensor?.sensorHeightM) ? `${sensor.sensorHeightM.toFixed(2)} m` : 'Unavailable'],
    ['Last reading', formatTime(lastUpdated, { hour: 'numeric', minute: '2-digit', second: '2-digit' })],
  ]

  return (
    <section className={styles.panel} id="device">
      <header className={styles.panelHeader}>
        <div><h2>Device</h2><p>Live sensor connection</p></div>
        <span className={`${styles.connectionTag} ${online ? styles.connectionOnline : ''}`}>
          <i />{online ? 'Online' : 'Offline'}
        </span>
      </header>
      <dl className={styles.deviceList}>
        {fields.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
      {canCalibrate && (
        <button type="button" className={styles.secondaryButton} onClick={onCalibrate} disabled={!online}>
          {calibrationState === 'pending' ? 'Calibrating…'
            : calibrationState === 'done' ? 'Calibration saved'
              : calibrationState === 'error' ? 'Calibration failed' : 'Calibrate sensor'}
        </button>
      )}
    </section>
  )
}

function AlertLog({ history }) {
  const changes = getStatusChanges(history)
  return (
    <section className={styles.panel} id="alerts">
      <header className={styles.panelHeader}>
        <div><h2>Alert log</h2><p>Threshold changes from recorded readings</p></div>
        <span className={styles.quietLabel}>{changes.length ? 'Latest first' : 'No events'}</span>
      </header>
      {changes.length ? (
        <ol className={styles.alertList}>
          {changes.map((change, index) => (
            <li key={`${change.timestamp}-${index}`}>
              <span className={`${styles.alertMark} ${styles[`alert_${change.status.toLowerCase()}`]}`} />
              <time>{formatTime(change.timestamp, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
              <strong>{statusLabel(change.status)}</strong>
              <span>{change.waterLevelM.toFixed(2)} m</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className={styles.emptyPanel}>No threshold changes recorded</div>
      )}
    </section>
  )
}

function AnimatedLevel({ value }) {
  const numberRef = useRef(null)
  const displayedRef = useRef(value)

  useEffect(() => {
    const node = numberRef.current
    if (!node || value == null) return undefined
    if (displayedRef.current == null || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      displayedRef.current = value
      node.textContent = value.toFixed(2)
      return undefined
    }

    const counter = { value: displayedRef.current }
    const tween = gsap.to(counter, {
      value,
      duration: 0.55,
      ease: 'power2.out',
      overwrite: 'auto',
      onUpdate: () => {
        displayedRef.current = counter.value
        node.textContent = counter.value.toFixed(2)
      },
    })
    return () => tween.kill()
  }, [value])

  return <span className={styles.levelNumber} ref={numberRef}>{value == null ? '--.--' : value.toFixed(2)}</span>
}

function ThresholdLadder({ waterLevelM, status }) {
  const markerRef = useRef(null)
  const percent = waterLevelM == null
    ? null
    : Math.min(100, Math.max(0, waterLevelM / CHANNEL_M * 100))
  const marks = [
    { level: CHANNEL_M, value: '12.60', label: 'Channel top' },
    { level: 9.45, value: '9.45', label: 'Critical' },
    { level: 6.30, value: '6.30', label: 'Warning' },
    { level: 3.15, value: '3.15', label: 'Advisory' },
    { level: 0, value: '0', label: 'Channel floor' },
  ]

  useEffect(() => {
    const marker = markerRef.current
    if (!marker || percent == null) return undefined
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      gsap.set(marker, { bottom: `${percent}%` })
      return undefined
    }

    const tween = gsap.to(marker, {
      bottom: `${percent}%`,
      duration: 0.55,
      ease: 'power2.out',
      overwrite: 'auto',
    })
    return () => tween.kill()
  }, [percent])

  return (
    <div
      className={styles.thresholdLadder}
      role="meter"
      aria-label="Channel water level"
      aria-valuemin={0}
      aria-valuemax={CHANNEL_M}
      aria-valuenow={waterLevelM ?? 0}
      aria-valuetext={waterLevelM == null ? 'No live sensor reading' : `${waterLevelM.toFixed(2)} meters, ${statusLabel(status)}`}
    >
      <div className={styles.ladderTrack} aria-hidden="true">
        {percent != null && <span ref={markerRef} className={styles.ladderMarker} />}
      </div>
      <div className={styles.ladderLabels} aria-hidden="true">
        {marks.map((mark, index) => (
          <span
            key={mark.level}
            className={`${styles.ladderLabel} ${index === 0 ? styles.ladderTop : ''} ${index === marks.length - 1 ? styles.ladderBottom : ''}`}
            style={{ top: `${(1 - mark.level / CHANNEL_M) * 100}%` }}
          >
            <strong>{mark.value}</strong>
            <small>{mark.label}</small>
          </span>
        ))}
      </div>
    </div>
  )
}

export default function MainApp({ visible }) {
  const [debugVisible, setDebugVisible] = useState(false)
  const [rangeHours, setRangeHours] = useState(24)
  const [calibrationState, setCalibrationState] = useState('idle')
  const [activePanel, setActivePanel] = useState('live')
  const [emergencyMapOpen, setEmergencyMapOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches)
  const { sensor, history, online: sensorOnline, lastUpdated, calibrate } = useSensor()
  const { weather, forecast, loading: weatherLoading, error: weatherError } = useWeather()
  const { dark, toggle: toggleDark } = useDarkMode()
  const mapActionsRef = useRef(null)
  const panelStackRef = useRef(null)

  const setMapActions = useCallback(actions => {
    mapActionsRef.current = actions
  }, [])
  const closeEmergencyMap = useCallback(() => setEmergencyMapOpen(false), [])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 700px)')
    const updateLayout = event => {
      setIsMobile(event.matches)
      if (event.matches) mapActionsRef.current = null
    }
    query.addEventListener('change', updateLayout)
    updateLayout(query)
    return () => query.removeEventListener('change', updateLayout)
  }, [])

  useEffect(() => {
    const fn = event => {
      if (event.key === 'd' || event.key === 'D') setDebugVisible(value => !value)
    }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [])

  useEffect(() => {
    const panel = panelStackRef.current?.firstElementChild
    if (!visible || !panel || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    const tween = gsap.fromTo(panel,
      { autoAlpha: 0, y: 12, scale: 0.985 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.32, ease: 'power2.out', clearProps: 'transform,opacity,visibility' },
    )
    return () => tween.kill()
  }, [activePanel, visible])

  if (!visible) return null

  const hasLiveSensor = sensorOnline && sensor?._isStale !== true
  const waterLevelM = hasLiveSensor ? sensor?.waterLevelM ?? null : null
  const floodStatus = waterLevelM == null ? 'UNKNOWN' : sensor?.floodStatus ?? 'UNKNOWN'
  const status = waterLevelM == null ? 'UNKNOWN' : floodStatus
  const statusClass = status.toLowerCase()
  const trend = getTrend(hasLiveSensor ? history : [])

  async function handleCalibrate() {
    setCalibrationState('pending')
    try {
      const result = await calibrate()
      setCalibrationState(result.ok ? 'done' : 'error')
    } catch (error) {
      console.error('[dashboard] calibration failed:', error)
      setCalibrationState('error')
    }
    window.setTimeout(() => setCalibrationState('idle'), 3000)
  }

  const panelTabs = [
    { id: 'live', label: 'Live' },
    { id: 'history', label: 'History' },
    { id: 'alerts', label: 'Alerts' },
    { id: 'device', label: 'Device' },
  ]

  return (
    <div className={`${styles.hud} ${isMobile ? '' : styles.desktopLayout}`}>
      {!isMobile && (
        <div className={styles.mapCanvas}>
          <Suspense fallback={<div className={styles.mapLoading}>Loading 3D terrain…</div>}>
            <FloodTerrain3D
              sensor={sensor}
              sensorOnline={hasLiveSensor}
              waterLevelM={waterLevelM}
              weather={weather}
              onMapReady={setMapActions}
            />
          </Suspense>
        </div>
      )}
      <FloodAlert floodStatus={floodStatus} waterLevelM={waterLevelM} />
      <DebugConsole lines={[]} visible={debugVisible} />

      <header className={styles.appHeader}>
        <nav className={styles.navLinks} aria-label="Monitoring panels">
          {panelTabs.map(tab => (
            <button
              type="button"
              key={tab.id}
              aria-pressed={activePanel === tab.id}
              onClick={() => setActivePanel(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.emergencyButton}
            onClick={() => setEmergencyMapOpen(true)}
            aria-haspopup="dialog"
            aria-label="Open emergency map"
            title="Find nearby hospitals and shelters"
          >
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18.1A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
            <span>Evac map</span>
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={toggleDark}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={dark ? 'Light mode' : 'Dark mode'}
          >
            {dark ? '☼' : '☾'}
          </button>
        </div>
      </header>

      <main className={styles.panelDock}>
        <div className={styles.panelStack} ref={panelStackRef}>
          {activePanel === 'live' && (
            <section className={`${styles.panel} ${styles.livePanel}`} id="live-monitor">
              <header className={styles.panelHeader}>
                <div>
                  <h2>Live water level</h2>
                  <p>{hasLiveSensor ? `Updated ${formatTime(lastUpdated, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'Waiting for a live sensor reading'}</p>
                </div>
                {waterLevelM != null && (
                  <span className={`${styles.statusBadge} ${styles[`status_${statusClass}`]}`}>
                    <i />{statusLabel(status)}
                  </span>
                )}
              </header>

              <div className={styles.liveLevelLayout}>
                <div className={styles.readoutColumn}>
                  <div className={styles.levelReadout} aria-live="polite">
                    <AnimatedLevel value={waterLevelM} />
                    <span className={styles.levelUnit}>m</span>
                  </div>
                  {hasLiveSensor && (
                    <div className={`${styles.levelTrend} ${styles[`trend_${trend.direction}`]}`}>
                      <span aria-hidden="true">{trend.direction === 'rising' ? '↑' : trend.direction === 'falling' ? '↓' : '→'}</span>
                      <span>{trend.direction}</span>
                      {trend.rate != null && <small>{Math.abs(trend.rate).toFixed(1)} cm / 10 min</small>}
                    </div>
                  )}
                  <div className={styles.channelDepth}>of {CHANNEL_M.toFixed(2)} m channel depth</div>
                </div>
                <ThresholdLadder waterLevelM={waterLevelM} status={status} />
              </div>
              <div className={styles.livePanelFooter}>
                <span><i className={hasLiveSensor ? styles.dotOnline : ''} />{hasLiveSensor ? 'Live sensor data' : 'No live data'}</span>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => isMobile
                    ? setEmergencyMapOpen(true)
                    : mapActionsRef.current?.focusOnSensor?.()}
                  disabled={!isMobile && !hasLiveSensor}
                >
                  {isMobile ? 'Open evacuation map' : 'Center map'}
                </button>
              </div>
            </section>
          )}

          {activePanel === 'history' && (
            <HistoryChart history={history} rangeHours={rangeHours} onRangeChange={setRangeHours} />
          )}

          {activePanel === 'alerts' && <AlertLog history={history} />}

          {activePanel === 'device' && (
            <SensorDetails
              sensor={sensor}
              online={hasLiveSensor}
              lastUpdated={lastUpdated}
              onCalibrate={handleCalibrate}
              calibrationState={calibrationState}
              canCalibrate={import.meta.env.DEV}
            />
          )}
          <WeatherCard
            sensor={sensor}
            online={hasLiveSensor}
            weather={weather}
            forecast={forecast}
            weatherLoading={weatherLoading}
            weatherError={weatherError}
          />
        </div>
      </main>
      <Suspense fallback={null}>
        {emergencyMapOpen && (
          <MapModal
            open
            onClose={closeEmergencyMap}
            sensor={sensor}
            dark={dark}
          />
        )}
      </Suspense>
    </div>
  )
}
