import express from 'express'
import path    from 'path'
import fs      from 'fs'
import dotenv  from 'dotenv'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

// ── Config ────────────────────────────────────────────────────────────────────
const PORT    = Number(process.env.PORT) || 8000
const IS_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT)
const IS_PUBLIC_SERVER = IS_RAILWAY || process.env.NODE_ENV === 'production'
const HOST    = process.env.HOST || (IS_RAILWAY ? '0.0.0.0' : '127.0.0.1')
const API_KEY = process.env.OPENWEATHER_API_KEY || ''
const CITY    = 'Naga,PH'
const UNITS   = 'metric'
const ESP32   = process.env.ESP32_URL || ''
// ─────────────────────────────────────────────────────────────────────────────

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '16kb' }))
if (IS_RAILWAY) app.set('trust proxy', 1)
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.set('X-Frame-Options', 'DENY')
  next()
})

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin')
  if (!origin && IS_PUBLIC_SERVER) {
    return res.status(403).json({ error: 'Origin header required' })
  }
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ error: 'Cross-origin request rejected' })
      }
    } catch {
      return res.status(403).json({ error: 'Invalid request origin' })
    }
  }
  next()
}

function localOnly(req, res, next) {
  if (IS_PUBLIC_SERVER) {
    return res.status(404).json({ error: 'Endpoint unavailable on hosted server' })
  }
  next()
}

function rateLimitByIp(maxRequests, windowMs) {
  const clients = new Map()
  return (req, res, next) => {
    const now = Date.now()
    const ip = req.ip
    let window = clients.get(ip)
    if (!window || window.expiresAt <= now) {
      if (clients.size >= 10000) {
        for (const [clientIp, clientWindow] of clients) {
          if (clientWindow.expiresAt <= now) clients.delete(clientIp)
        }
        if (clients.size >= 10000) {
          return res.status(503).json({ error: 'Rate limiter capacity reached' })
        }
      }
      window = { count: 0, expiresAt: now + windowMs }
      clients.set(ip, window)
    }
    if (window.count >= maxRequests) {
      res.set('Retry-After', Math.ceil((window.expiresAt - now) / 1000))
      return res.status(429).json({ error: 'Too many requests' })
    }
    window.count++
    next()
  }
}

const sensorRateLimit = rateLimitByIp(120, 60_000)
const weatherRateLimit = rateLimitByIp(20, 60_000)
const overpassRateLimit = rateLimitByIp(10, 60_000)

// ── Serve built frontend assets ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'dist')))
// ─────────────────────────────────────────────────────────────────────────────

// ── Calibration — persisted to calibration.json ───────────────────────────────
// SENSOR_HEIGHT_M = the DIST reading (metres) when the channel is completely dry.
// Default: 14.75 m (from first real reading). Override via POST /api/calibrate.
const CALIB_FILE = path.join(__dirname, 'calibration.json')

function loadCalibration() {
  try {
    if (fs.existsSync(CALIB_FILE)) {
      const c = JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8'))
      console.log(`[calib] loaded sensorHeightM=${c.sensorHeightM}`)
      return c
    }
  } catch (e) {
    console.warn('[calib] failed to load, using default:', e.message)
  }
  return { sensorHeightM: 14.75 }
}

function saveCalibration(data) {
  fs.writeFileSync(CALIB_FILE, JSON.stringify(data, null, 2))
  console.log('[calib] saved:', JSON.stringify(data))
}

let calibration = loadCalibration()

// GET /api/calibrate — return current calibration
app.get('/api/calibrate', (req, res) => {
  res.json(calibration)
})

// POST /api/calibrate — set sensorHeightM manually or auto from current reading
// Body: { sensorHeightM: 14.75 }  OR  { auto: true }  (uses current DIST)
app.post('/api/calibrate', requireSameOrigin, localOnly, (req, res) => {
  let sensorHeightM
  if (req.body?.auto === true) {
    if (!Number.isFinite(sensorCache?.distance)
      || sensorCache.distance < 0
      || sensorCache.distance > 50) {
      return res.status(503).json({ error: 'No valid sensor reading available yet' })
    }
    sensorHeightM = sensorCache.distance
  } else if (Number.isFinite(req.body?.sensorHeightM)
    && req.body.sensorHeightM >= 0
    && req.body.sensorHeightM <= 50) {
    sensorHeightM = req.body.sensorHeightM
  } else {
    return res.status(400).json({ error: 'Provide sensorHeightM from 0 to 50 or auto: true' })
  }
  const nextCalibration = { sensorHeightM }
  try {
    saveCalibration(nextCalibration)
  } catch (error) {
    console.error('[calib] failed to persist calibration:', error.message)
    return res.status(500).json({ error: 'Failed to persist calibration' })
  }
  calibration = nextCalibration
  if (req.body.auto === true) console.log(`[calib] auto-calibrated to ${sensorHeightM} m`)
  res.json({ ok: true, calibration })
})
// ─────────────────────────────────────────────────────────────────────────────

// ── Scrape sensor HTML ────────────────────────────────────────────────────────
async function fetchSensorData() {
  if (!ESP32) throw new Error('ESP32_URL is not configured')
  const r = await fetch(ESP32, { signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`ESP32 returned status ${r.status}`)
  const html = await r.text()

  const match = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)
  if (!match) throw new Error('No <pre> tag found in sensor HTML')

  const raw = match[1].trim()
  const obj = {}
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=')
    if (k && v !== undefined) obj[k.trim()] = isNaN(v) ? v.trim() : parseFloat(v)
  }

  return {
    temperature : obj.TEMP   ?? null,
    humidity    : obj.HUM    ?? null,
    pressure    : obj.PRESS  ?? null,
    distance    : obj.DIST   ?? null,
    latitude    : obj.LAT    ?? null,
    longitude   : obj.LON    ?? null,
    gps         : obj.GPS    ?? null,
    relay       : obj.RELAY  ?? null,
    raw,
  }
}

// ── Sensor cache ──────────────────────────────────────────────────────────────
let sensorCache    = null
let sensorLastUpdate = 0

async function pollSensor() {
  if (!ESP32) return
  try {
    sensorCache = await fetchSensorData()
    sensorLastUpdate = Date.now()
    console.log('[sensor]', JSON.stringify(sensorCache))
  } catch (e) {
    console.warn('[sensor] poll failed:', e.message)
  }
}
if (ESP32) {
  pollSensor()
  setInterval(pollSensor, 3000)
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Phone location — phone opens /locate, pushes coords here ─────────────────
let phoneLocation = null
let phoneLocationAge = 0

// Phone posts its coords here
app.post('/api/location', requireSameOrigin, localOnly, (req, res) => {
  const { lat, lng, accuracy } = req.body || {}
  if (!Number.isFinite(lat) || lat < -90 || lat > 90
    || !Number.isFinite(lng) || lng < -180 || lng > 180
    || (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000))) {
    return res.status(400).json({ error: 'Valid latitude, longitude, and optional accuracy are required' })
  }
  phoneLocation = { lat, lng, accuracy: accuracy ?? null, source: 'phone' }
  phoneLocationAge = Date.now()
  console.log(`[location] phone → lat=${lat.toFixed(5)} lng=${lng.toFixed(5)} acc=±${accuracy}m`)
  res.json({ ok: true })
})

// Main webapp reads phone location
app.get('/api/location', localOnly, (req, res) => {
  if (!phoneLocation) return res.json({ available: false })
  const age = Date.now() - phoneLocationAge
  res.json({ available: true, ...phoneLocation, ageMs: age, stale: age > 60000 })
})

// Standalone phone page — asks GPS permission and streams location to server
app.get('/locate', localOnly, (req, res) => {
  // Get the server IP from the request so the page posts back to the right host
  const host = req.headers.host || `localhost:${PORT}`
  res.setHeader('Content-Type', 'text/html')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>R.I.S.I.N.G · Location</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      min-height:100dvh;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:20px;
      background:linear-gradient(160deg,#0d1f3c 0%,#1a3a6e 100%);
      font-family:'Inter',system-ui,sans-serif;color:#fff;padding:24px;
    }
    .logo{font-size:2rem;font-weight:900;letter-spacing:.2em;
      background:linear-gradient(180deg,#6ab4ff,#2a6ae8);
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;}
    .sub{font-size:.7rem;font-weight:700;letter-spacing:.18em;
      text-transform:uppercase;color:rgba(255,255,255,.5);margin-top:-12px;}
    .card{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);
      border-radius:20px;padding:28px 32px;width:100%;max-width:360px;
      display:flex;flex-direction:column;align-items:center;gap:16px;
      backdrop-filter:blur(12px);}
    .status-dot{width:14px;height:14px;border-radius:50%;background:#e03040;
      box-shadow:0 0 10px #e03040;transition:all .4s;}
    .status-dot.active{background:#2ec87a;box-shadow:0 0 14px #2ec87a;
      animation:pulse 2s ease-in-out infinite;}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .status-text{font-size:.9rem;font-weight:700;letter-spacing:.06em;text-align:center;}
    .coords{font-family:'Courier New',monospace;font-size:.75rem;
      color:rgba(255,255,255,.6);text-align:center;line-height:1.7;}
    .accuracy{font-size:.7rem;color:rgba(255,255,255,.4);}
    .btn{background:linear-gradient(135deg,#2a6ae8,#1a3a8a);border:none;
      border-radius:12px;color:#fff;font-size:.85rem;font-weight:800;
      letter-spacing:.08em;padding:14px 32px;cursor:pointer;
      transition:opacity .2s;width:100%;}
    .btn:hover{opacity:.85}
    .hint{font-size:.68rem;color:rgba(255,255,255,.35);text-align:center;
      line-height:1.6;max-width:280px;}
    .updates{font-size:.65rem;color:rgba(255,255,255,.3);margin-top:4px;}
  </style>
</head>
<body>
  <div class="logo">R I S I N G</div>
  <div class="sub">Location Relay</div>

  <div class="card">
    <div class="status-dot" id="dot"></div>
    <div class="status-text" id="statusText">Tap to share location</div>
    <div class="coords" id="coords">—</div>
    <div class="accuracy" id="accuracy"></div>
    <button class="btn" id="btn" onclick="startTracking()">Share My Location</button>
    <div class="updates" id="updates"></div>
  </div>

  <div class="hint">
    Keep this page open on your phone.<br/>
    The map on the main screen will use your location.
  </div>

  <script>
    const SERVER = window.location.origin
    let watchId = null
    let sendCount = 0

    function setStatus(text, active) {
      document.getElementById('statusText').textContent = text
      document.getElementById('dot').className = 'status-dot' + (active ? ' active' : '')
    }

    function startTracking() {
      if (!('geolocation' in navigator)) {
        setStatus('GPS not available on this device', false)
        return
      }
      document.getElementById('btn').style.display = 'none'
      setStatus('Requesting permission…', false)

      watchId = navigator.geolocation.watchPosition(
        pos => {
          const { latitude: lat, longitude: lng, accuracy } = pos.coords
          document.getElementById('coords').textContent =
            lat.toFixed(6) + ', ' + lng.toFixed(6)
          document.getElementById('accuracy').textContent =
            '± ' + Math.round(accuracy) + ' m accuracy'
          setStatus('Sharing location', true)

          fetch(SERVER + '/api/location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat, lng, accuracy }),
          }).then(() => {
            sendCount++
            document.getElementById('updates').textContent =
              'Updated ' + sendCount + ' time' + (sendCount === 1 ? '' : 's')
          }).catch(() => {
            setStatus('Server unreachable — retrying…', false)
          })
        },
        err => {
          const msgs = {
            1: 'Permission denied — allow location in browser settings',
            2: 'Location unavailable — check GPS signal',
            3: 'Timeout — trying again…',
          }
          setStatus(msgs[err.code] || 'Location error', false)
          document.getElementById('btn').style.display = 'block'
          document.getElementById('btn').textContent = 'Try Again'
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      )
    }

    // Auto-start if already permitted
    navigator.permissions?.query({ name: 'geolocation' }).then(p => {
      if (p.state === 'granted') startTracking()
    })
  </script>
</body>
</html>`)
})
// ─────────────────────────────────────────────────────────────────────────────

// ── Weather ───────────────────────────────────────────────────────────────────
app.get('/api/weather', weatherRateLimit, async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'OPENWEATHER_API_KEY is not configured' })
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${CITY}&units=${UNITS}&appid=${API_KEY}`
    const r = await fetch(url)
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.message })
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/forecast', weatherRateLimit, async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'OPENWEATHER_API_KEY is not configured' })
  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?q=${CITY}&units=${UNITS}&cnt=40&appid=${API_KEY}`
    const r = await fetch(url)
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.message })
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Sensor — includes calibration so frontend can use server-side value ───────
app.get('/api/sensor', sensorRateLimit, (req, res) => {
  if (!sensorCache) return res.status(503).json({ error: 'No sensor data yet' })
  const age = Date.now() - sensorLastUpdate
  res.json({
    ...sensorCache,
    stale: age > 30000,
    ageMs: age,
    sensorHeightM: calibration.sensorHeightM,   // ← frontend uses this
  })
})

// ── Overpass proxy ────────────────────────────────────────────────────────────
const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
]

app.post('/api/overpass', requireSameOrigin, overpassRateLimit, async (req, res) => {
  const query = req.body?.query
  if (typeof query !== 'string' || query.length === 0 || query.length > 8000) {
    return res.status(400).json({ error: 'A query of up to 8000 characters is required' })
  }
  const body = 'data=' + encodeURIComponent(query)
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const r = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) { console.warn('[overpass]', mirror, r.status); continue }
      return res.json(await r.json())
    } catch (e) {
      console.warn('[overpass]', mirror, e.message)
    }
  }
  res.status(503).json({ error: 'All Overpass mirrors unavailable' })
})

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, HOST, () => {
  console.log('========================================')
  console.log('  R.I.S.I.N.G  |  Express Server')
  console.log('========================================')
  console.log(`  App:           http://${HOST}:${PORT}`)
  console.log(`  Sensor:        ${ESP32 ? 'configured' : 'not configured'}`)
  console.log(`  Sensor Ht:     ${calibration.sensorHeightM} m`)
  console.log('  Calibrate:     POST /api/calibrate')
  console.log('========================================')
})
