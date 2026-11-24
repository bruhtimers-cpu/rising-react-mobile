import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, memo } from 'react'
import L from 'leaflet'
import { gsap } from 'gsap'
import 'leaflet/dist/leaflet.css'
import styles from './MapModal.module.css'

// Fix Leaflet's broken default icon paths when bundled
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const DEFAULT_LAT = 13.6298
const DEFAULT_LNG = 123.2250

// ── Fallback data: real fixed coords of Naga City locations ──
const NAGA_EVAC = [
  { name: 'Naga City Coliseum',          lat: 13.6324, lng: 123.2261, type: 'Sports Center',    kind: 'evac' },
  { name: 'Naga City Hall',              lat: 13.6307, lng: 123.2270, type: 'Government',        kind: 'evac' },
  { name: 'Ateneo de Naga University',   lat: 13.6270, lng: 123.2227, type: 'University',        kind: 'evac' },
  { name: 'University of Nueva Caceres', lat: 13.6296, lng: 123.2203, type: 'University',        kind: 'evac' },
  { name: 'Naga Central School',         lat: 13.6281, lng: 123.2285, type: 'School',            kind: 'evac' },
  { name: 'Naga Metropolitan Cathedral', lat: 13.6300, lng: 123.2265, type: 'Church',            kind: 'evac' },
]
const NAGA_TENTS = [
  { name: 'Brgy. Triangulo Evacuation Tent',   lat: 13.6336, lng: 123.2255, type: 'Barangay Shelter', kind: 'tent' },
  { name: 'Brgy. Concepcion Pequeña Tent',     lat: 13.6261, lng: 123.2305, type: 'Barangay Shelter', kind: 'tent' },
  { name: 'Brgy. Pacol Evacuation Area',       lat: 13.6181, lng: 123.2175, type: 'Barangay Shelter', kind: 'tent' },
  { name: 'Brgy. Peñafrancia Evacuation Site', lat: 13.6321, lng: 123.2295, type: 'Barangay Shelter', kind: 'tent' },
]
const NAGA_HOSPITALS = [
  { name: 'Naga City Hospital',              lat: 13.6291, lng: 123.2280, type: 'Government Hospital', kind: 'hospital' },
  { name: 'Bicol Medical Center',            lat: 13.6253, lng: 123.2222, type: 'Hospital',            kind: 'hospital' },
  { name: 'St. John Hospital',               lat: 13.6311, lng: 123.2235, type: 'Private Hospital',    kind: 'hospital' },
  { name: 'Perpetual Help Medical Center',   lat: 13.6339, lng: 123.2287, type: 'Hospital',            kind: 'hospital' },
]

function distanceKm(fromLat, fromLng, toLat, toLng) {
  const radians = value => value * Math.PI / 180
  const dLat = radians(toLat - fromLat)
  const dLng = radians(toLng - fromLng)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(fromLat)) * Math.cos(radians(toLat)) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function nearestResource(places, sensorLat, sensorLng) {
  return places
    .map(place => {
      const lat = place.lat ?? place.center?.lat
      const lng = place.lon ?? place.center?.lon ?? place.lng
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return {
        name: place.tags?.name || place.name || 'Emergency resource',
        lat,
        lng,
        distanceKm: distanceKm(sensorLat, sensorLng, lat, lng),
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm)[0] ?? null
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

// ── Flat image icon with ground shadow ──
function makeIcon(src, size) {
  const shadowW = Math.round(size * 0.65)
  const shadowH = Math.round(size * 0.13)
  return `
    <div style="display:flex;flex-direction:column;align-items:center;width:${size}px;">
      <img src="${src}" style="
        width:${size}px;height:${size}px;object-fit:contain;display:block;
        filter:drop-shadow(0 2px 5px rgba(0,0,0,0.35));
      "/>
      <div style="
        width:${shadowW}px;height:${shadowH}px;
        background:radial-gradient(ellipse,rgba(7,39,68,0.24) 0%,transparent 75%);
        margin-top:-5px;border-radius:50%;flex-shrink:0;
      "></div>
    </div>`
}

// ── Themed popup card HTML (matches app card design) ──
function popupHtml(name, type, addr, distKm, accentColor, badge) {
  name = escapeHtml(name)
  type = escapeHtml(type)
  addr = escapeHtml(addr)
  distKm = escapeHtml(distKm)
  badge = escapeHtml(badge)
  return `
    <div class="mapPopupCard">
      <div class="mapPopupHeader" style="background:${accentColor};">
        <div class="mapPopupBadge">${badge}</div>
        <div class="mapPopupTitle">${name}</div>
      </div>
      <div class="mapPopupBody">
        <div class="mapPopupRow">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
          <span style="text-transform:capitalize;">${type}</span>
        </div>
        <div class="mapPopupAddr">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#315F82" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px;">
            <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          <span>${addr}</span>
        </div>
        <div class="mapPopupDist" style="background:${accentColor}18;color:${accentColor};">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
          <span>${distKm} km away</span>
        </div>
      </div>
    </div>`
}

// ── Render all marker types ──
function renderMarkers(L, map, sensorLat, sensorLng, evacs, tents, hospitals, setStatus, fitMap = true) {
  const sortedEvacs = [...evacs].sort((a, b) => {
    const aLat = a.lat ?? a.center?.lat, aLng = a.lon ?? a.center?.lon ?? a.lng
    const bLat = b.lat ?? b.center?.lat, bLng = b.lon ?? b.center?.lon ?? b.lng
    return distanceKm(sensorLat, sensorLng, aLat, aLng) - distanceKm(sensorLat, sensorLng, bLat, bLng)
  })

  // ── Evac centers ──
  sortedEvacs.forEach((el, i) => {
    const lat = el.lat ?? el.center?.lat
    const lng = el.lon ?? el.center?.lon ?? el.lng
    if (!lat || !lng) return
    const isNearest = i === 0
    const name    = el.tags?.name || el.name || 'Evacuation Center'
    const type    = el.tags?.amenity || el.type || 'Evacuation Center'
    const addr    = el.tags?.['addr:street'] || el.tags?.['addr:city'] || 'Naga City, Camarines Sur'
    const distKm  = distanceKm(sensorLat, sensorLng, lat, lng).toFixed(2)
    const imgSize = isNearest ? 68 : 48

    const icon = L.divIcon({
      className: '',
      html: makeIcon('/icons/evac-center-removebg-preview.png', imgSize),
      iconSize:   [imgSize, Math.round(imgSize * 1.18)],
      iconAnchor: [imgSize / 2, Math.round(imgSize * 1.18)],
    })

    const marker = L.marker([lat, lng], { icon }).addTo(map)
    if (isNearest) {
      marker.bindTooltip(escapeHtml(name), { permanent: true, direction: 'top', offset: [0, -30], className: 'nearestSiteLabel' })
    }
    marker.bindPopup(
      popupHtml(name, type, addr, distKm,
        isNearest ? '#B43D43' : '#37815C',
        isNearest ? 'NEAREST EVACUATION CENTER' : 'EVACUATION CENTER'),
      { maxWidth: 260, className: 'evac-popup' }
    )

    // Draw line from sensor to EVERY evac center — REMOVED per user request

    if (isNearest && fitMap) {
      map.fitBounds([[sensorLat, sensorLng], [lat, lng]], { padding: [70, 70], maxZoom: 15 })
      setTimeout(() => marker.openPopup(), 600)
    }
  })

  // ── Tent shelters ──
  tents.forEach(el => {
    const lat = el.lat ?? el.center?.lat
    const lng = el.lon ?? el.center?.lon ?? el.lng
    if (!lat || !lng) return
    const name   = el.tags?.name || el.name || 'Temporary Shelter'
    const type   = el.tags?.amenity || el.type || 'Barangay Shelter'
    const addr   = el.tags?.['addr:street'] || 'Naga City, Camarines Sur'
    const distKm = distanceKm(sensorLat, sensorLng, lat, lng).toFixed(2)

    const icon = L.divIcon({
      className: '',
      html: makeIcon('/icons/evac-tent.png', 64),
      iconSize:   [64, 75], iconAnchor: [32, 75],
    })
    // Orange dashed line — REMOVED
    L.marker([lat, lng], { icon }).addTo(map)
      .bindPopup(popupHtml(name, type, addr, distKm, '#AA7521', 'TEMPORARY SHELTER'),
        { maxWidth: 260, className: 'evac-popup' })
  })

  // ── Hospitals ──
  hospitals.forEach(el => {
    const lat = el.lat ?? el.center?.lat
    const lng = el.lon ?? el.center?.lon ?? el.lng
    if (!lat || !lng) return
    const name   = el.tags?.name || el.name || 'Hospital'
    const type   = el.tags?.amenity || el.type || 'Hospital'
    const addr   = el.tags?.['addr:street'] || 'Naga City, Camarines Sur'
    const distKm = distanceKm(sensorLat, sensorLng, lat, lng).toFixed(2)

    const icon = L.divIcon({
      className: '',
      html: makeIcon('/icons/hospital.png', 44),
      iconSize:   [44, 52], iconAnchor: [22, 52],
    })
    // Navy dashed line — REMOVED
    L.marker([lat, lng], { icon }).addTo(map)
      .bindPopup(popupHtml(name, type, addr, distKm, '#2B5D8A', 'HOSPITAL'),
        { maxWidth: 260, className: 'evac-popup' })
  })

  setStatus(`${evacs.length} evac centers · ${tents.length} shelters · ${hospitals.length} hospitals`)
  const nearest = sortedEvacs[0]
  if (!nearest) return null
  const nearestLat = nearest.lat ?? nearest.center?.lat
  const nearestLng = nearest.lon ?? nearest.center?.lon ?? nearest.lng
  return {
    name: nearest.tags?.name || nearest.name || 'Evacuation Center',
    lat: nearestLat,
    lng: nearestLng,
    distanceKm: distanceKm(sensorLat, sensorLng, nearestLat, nearestLng).toFixed(2),
  }
}

export default memo(function MapModal({ open, onClose, sensor, dark = false }) {
  const mapRef     = useRef(null)
  const mapWrapRef   = useRef(null)
  const modalRef = useRef(null)
  const leafletRef = useRef(null)
  const resizeRef  = useRef(null)
  const observerRef = useRef(null)
  const [status,   setStatus]   = useState('Loading…')
  const [locLabel, setLocLabel] = useState('')
  const [nearestResources, setNearestResources] = useState({ evacuation: null, shelter: null, hospital: null })

  useEffect(() => {
    if (!open) return undefined
    const previousFocus = document.activeElement
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    modalRef.current?.focus()
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return () => {
        window.removeEventListener('keydown', onKeyDown)
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
      }
    }
    const tween = gsap.fromTo(modalRef.current,
      { autoAlpha: 0, y: 18, scale: 0.98 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.34, ease: 'power3.out', clearProps: 'transform,opacity,visibility' },
    )
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      tween.kill()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [open, onClose])

  const coordsRef = useRef({ lat: DEFAULT_LAT, lng: DEFAULT_LNG, source: 'default' })
  const prevOpen  = useRef(false)
  if (open && !prevOpen.current) {
    coordsRef.current = { lat: DEFAULT_LAT, lng: DEFAULT_LNG, source: 'default' }
  }
  prevOpen.current = open

  useEffect(() => {
    if (!open) return
    setNearestResources({ evacuation: null, shelter: null, hospital: null })
    let cancelled = false
    let invalidateTimer

    // Priority: GPS sensor fix → browser/phone geolocation → hardcoded default
    // Works on phone via HTTPS (ngrok) — browser will ask for location permission
    function resolveLocation() {
      return new Promise(resolve => {
        // 1. GPS sensor fix from ESP32
        const sLat = sensor?.latitude
        const sLng = sensor?.longitude
        const hasGPS = sensor?._isMock !== true && sLat && sLng && Math.abs(sLat) > 0.01 && Math.abs(sLng) > 0.01
        if (hasGPS) {
          resolve({ lat: sLat, lng: sLng, source: 'gps' })
          return
        }

        // 2. Browser geolocation — works on phone + desktop over HTTPS
        if ('geolocation' in navigator) {
          setStatus('Requesting your location…')
          navigator.geolocation.getCurrentPosition(
            pos => resolve({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
              source: 'browser',
            }),
            () => resolve({ lat: DEFAULT_LAT, lng: DEFAULT_LNG, source: 'default' }),
            { timeout: 3000, maximumAge: 30000, enableHighAccuracy: true }
          )
        } else {
          resolve({ lat: DEFAULT_LAT, lng: DEFAULT_LNG, source: 'default' })
        }
      })
    }

    const t = setTimeout(async () => {
      if (!mapRef.current || leafletRef.current) return

      // Resolve location before initialising the map
      const loc = await resolveLocation()
      if (cancelled || !mapRef.current || leafletRef.current) return
      coordsRef.current = loc

      const sourceLabel =
        loc.source === 'gps'     ? `GPS fix · ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` :
        loc.source === 'browser' ? `Your location · ±${Math.round(loc.accuracy ?? 0)} m` :
                                   'Default location (Naga City)'
      setLocLabel(sourceLabel)
      // L is imported directly — no window.L needed

      const { lat, lng, source } = coordsRef.current

      const map = L.map(mapRef.current, { zoomControl: true }).setView([lat, lng], 15)
      leafletRef.current = map

      const invalidate = () => {
        requestAnimationFrame(() => map.invalidateSize())
      }
      resizeRef.current = invalidate
      invalidate()
      invalidateTimer = setTimeout(invalidate, 350)
      window.addEventListener('resize', invalidate)
      window.addEventListener('orientationchange', invalidate)

      if (mapWrapRef.current && typeof ResizeObserver !== 'undefined') {
        observerRef.current = new ResizeObserver(invalidate)
        observerRef.current.observe(mapWrapRef.current)
      }

      const satelliteLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
          maxZoom: 19,
        }
      )
      const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      })
      streetLayer.addTo(map)
      L.control.layers(
        { 'Satellite imagery': satelliteLayer, 'Street map': streetLayer },
        null,
        { collapsed: true, position: 'topright' }
      ).addTo(map)

      // ── Sensor dot ──
      const sensorIcon = L.divIcon({
        className: '',
        html: `<div style="position:relative;width:24px;height:24px;">
          <div style="position:absolute;inset:-10px;border-radius:50%;background:rgba(40,123,178,0.2);animation:sensorPulse 1.8s ease-in-out infinite;"></div>
          <div style="position:absolute;inset:-4px;border-radius:50%;background:rgba(40,123,178,0.35);"></div>
          <div style="position:absolute;inset:0;border-radius:50%;background:#287BB2;border:3px solid #EAF6FF;box-shadow:0 0 0 2px #0A3152;"></div>
        </div>`,
        iconSize: [24, 24], iconAnchor: [12, 12],
      })

      // Keep a ref to the sensor marker so we never lose it
      const sensorMarker = L.marker([lat, lng], { icon: sensorIcon }).addTo(map)
      sensorMarker.bindPopup(`
          <div class="mapPopupCard">
            <div class="mapPopupHeader" style="background:linear-gradient(135deg,#35424C,#52616D);">
              <div class="mapPopupBadge">${source === 'gps' ? 'GPS SENSOR' : source === 'browser' ? 'YOUR LOCATION' : 'DEFAULT LOCATION'}</div>
              <div class="mapPopupTitle">You are here</div>
            </div>
            <div class="mapPopupBody">
              <div class="mapPopupAddr" style="margin-bottom:8px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#315F82" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px;">
                  <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/>
                </svg>
                <span>${lat.toFixed(5)}, ${lng.toFixed(5)}</span>
              </div>
              <div class="mapPopupDist" style="background:${source === 'gps' ? '#37815C22' : source === 'browser' ? '#2B5D8A22' : '#65717A22'};color:${source === 'gps' ? '#28754E' : source === 'browser' ? '#2B5D8A' : '#59636B'};">
                ${source === 'gps' ? '✓ GPS lock' : source === 'browser' ? '✓ Live location' : '⚠ Using default (Naga City)'}
              </div>
            </div>
          </div>`, { maxWidth: 260, className: 'evac-popup' })
      sensorMarker.openPopup()

      // Tag it so we can skip it when clearing other markers
      sensorMarker._isSensor = true

      // Helper: remove all non-sensor markers
      const clearPlaceMarkers = () => {
        map.eachLayer(layer => {
          if (layer instanceof L.Marker && !layer._isSensor) map.removeLayer(layer)
        })
      }

      // ── Render fallback markers immediately so the map isn't empty ──
      // Only use Naga City fallback data if we're actually on the default location
      const fallbackEvacs = NAGA_EVAC.map(c => ({ lat: c.lat, lon: c.lng, name: c.name, type: c.type, kind: c.kind }))
      const fallbackTents = NAGA_TENTS.map(c => ({ lat: c.lat, lon: c.lng, name: c.name, type: c.type, kind: c.kind }))
      const fallbackHosps = NAGA_HOSPITALS.map(c => ({ lat: c.lat, lon: c.lng, name: c.name, type: c.type, kind: c.kind }))
      const fallbackAllowed = source === 'default' || Math.hypot((lat - 13.63) * 111, (lng - 123.225) * 105) <= 4.5

      if (fallbackAllowed) {
        renderMarkers(L, map, lat, lng, fallbackEvacs, fallbackTents, fallbackHosps, setStatus)
        setNearestResources({
          evacuation: nearestResource(fallbackEvacs, lat, lng),
          shelter: nearestResource(fallbackTents, lat, lng),
          hospital: nearestResource(fallbackHosps, lat, lng),
        })
      } else {
        setNearestResources({ evacuation: null, shelter: null, hospital: null })
        setStatus('Finding nearby evacuation sites…')
        map.fitBounds([[lat - 0.01, lng - 0.01], [lat + 0.01, lng + 0.01]], { maxZoom: 15 })
      }

      // Try Overpass in the background — if it succeeds, replace markers
      const R = 4000
      const query = `[out:json][timeout:10];
(
  node["emergency"="assembly_point"](around:${R},${lat},${lng});
  node["amenity"="evacuation_center"](around:${R},${lat},${lng});
  way["amenity"="school"](around:${R},${lat},${lng});
  way["amenity"="university"](around:${R},${lat},${lng});
  way["amenity"="community_centre"](around:${R},${lat},${lng});
  way["amenity"="townhall"](around:${R},${lat},${lng});
  way["amenity"="sports_centre"](around:${R},${lat},${lng});
  way["building"="civic"](around:${R},${lat},${lng});
  node["emergency"="shelter"](around:${R},${lat},${lng});
  way["emergency"="shelter"](around:${R},${lat},${lng});
  node["amenity"="shelter"](around:${R},${lat},${lng});
  way["amenity"="shelter"](around:${R},${lat},${lng});
  node["amenity"="hospital"](around:${R},${lat},${lng});
  way["amenity"="hospital"](around:${R},${lat},${lng});
  relation["amenity"="hospital"](around:${R},${lat},${lng});
  node["amenity"="clinic"](around:${R},${lat},${lng});
  way["amenity"="clinic"](around:${R},${lat},${lng});
  node["healthcare"="hospital"](around:${R},${lat},${lng});
  way["healthcare"="hospital"](around:${R},${lat},${lng});
);
out center;`

      fetch('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
        .then(r => { if (!r.ok) throw new Error('overpass ' + r.status); return r.json() })
        .then(data => {
          if (cancelled) return
          const all = (data.elements || []).filter(el =>
            (el.lat ?? el.center?.lat) && (el.lon ?? el.center?.lon)
          )
          if (all.length === 0) {
            if (!fallbackAllowed) setStatus('No nearby emergency sites found')
            return
          }

          const isShelter = el => ['shelter'].includes(el.tags?.emergency || '')
            || el.tags?.amenity === 'shelter'
            || el.tags?.social_facility === 'shelter'
          const liveEvac = all.filter(el => !isShelter(el)
            && !['hospital','clinic'].includes(el.tags?.amenity || '')
            && el.tags?.healthcare !== 'hospital')
          const liveShelters = all.filter(isShelter)
          const liveHosp = all.filter(el => ['hospital','clinic'].includes(el.tags?.amenity || '') || el.tags?.healthcare === 'hospital')

          // Deduplicate by name — keep first occurrence only
          const dedupe = arr => {
            const seen = new Set()
            return arr.filter(el => {
              const name = el.tags?.name || el.name || ''
              if (!name || seen.has(name)) return false
              seen.add(name)
              return true
            })
          }

          // Cap to nearest 10 evac and 10 hospitals to avoid lag
          const evacs = dedupe(liveEvac.length > 0 ? liveEvac : (fallbackAllowed ? fallbackEvacs : [])).slice(0, 10)
          const shelters = dedupe(liveShelters.length > 0 ? liveShelters : (fallbackAllowed ? fallbackTents : [])).slice(0, 10)
          const hosps = dedupe(liveHosp.length > 0 ? liveHosp : (fallbackAllowed ? fallbackHosps : [])).slice(0, 10)

          clearPlaceMarkers()
          renderMarkers(L, map, lat, lng, evacs, shelters, hosps, setStatus, false)
          setNearestResources({
            evacuation: nearestResource(evacs, lat, lng),
            shelter: nearestResource(shelters, lat, lng),
            hospital: nearestResource(hosps, lat, lng),
          })
        })
        .catch(() => {
          if (cancelled) return
          if (fallbackAllowed) {
            clearPlaceMarkers()
            renderMarkers(L, map, lat, lng, [...fallbackEvacs], [...fallbackTents], [...fallbackHosps], setStatus)
            setNearestResources({
              evacuation: nearestResource(fallbackEvacs, lat, lng),
              shelter: nearestResource(fallbackTents, lat, lng),
              hospital: nearestResource(fallbackHosps, lat, lng),
            })
            setStatus(`${fallbackEvacs.length} evac centers · ${fallbackTents.length} shelters · ${fallbackHosps.length} hospitals (offline)`)
          } else {
            setNearestResources({ evacuation: null, shelter: null, hospital: null })
            setStatus('Could not load nearby sites — check connection')
          }
        })
    }, 150)

    return () => {
      cancelled = true
      clearTimeout(t)
      clearTimeout(invalidateTimer)
      if (resizeRef.current) {
        window.removeEventListener('resize', resizeRef.current)
        window.removeEventListener('orientationchange', resizeRef.current)
      }
      observerRef.current?.disconnect()
      observerRef.current = null
      if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null }
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div className={styles.overlay} data-theme={dark ? 'dark' : 'light'} onClick={e => e.target === e.currentTarget && onClose()}>
      <div
        ref={modalRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="emergency-map-title"
        tabIndex={-1}
      >
        <div className={styles.header}>
          <div className={styles.headerTop}>
            <div className={styles.headerLeft}>
              <div className={styles.headerIcon}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z"/>
                  <circle cx="12" cy="10" r="3"/>
                </svg>
              </div>
              <span className={styles.headerTitle} id="emergency-map-title">Emergency Map</span>
            </div>
            <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="1" y1="1" x2="13" y2="13"/><line x1="13" y1="1" x2="1" y2="13"/>
              </svg>
            </button>
          </div>
          <div className={styles.headerMeta}>
            <span className={styles.coords}>{locLabel || `${(coordsRef.current.lat ?? DEFAULT_LAT).toFixed(4)}, ${(coordsRef.current.lng ?? DEFAULT_LNG).toFixed(4)}`}</span>
            <span className={`${styles.gpsTag} ${
              coordsRef.current.source === 'gps'     ? styles.gpsOn :
              coordsRef.current.source === 'browser' ? styles.gpsBrowser :
              styles.gpsOff
            }`}>
              {coordsRef.current.source === 'gps'     ? 'GPS' :
               coordsRef.current.source === 'browser' ? 'LIVE' :
               'DEFAULT'}
            </span>
          </div>
        </div>

        <div className={styles.body}>
          <div className={styles.infoBar}>
            <div className={styles.statusRow}>
              <span className={styles.statusDot} />
              <span className={styles.statusText}>{status}</span>
            </div>
            <div className={styles.legend}>
              <span className={styles.legendItem}><span className={styles.dotBlue}/> You</span>
              <span className={styles.legendItem}>
                <img src="/icons/evac-center-removebg-preview.png" className={styles.legendIcon} alt=""/> Nearest
              </span>
              <span className={styles.legendItem}>
                <img src="/icons/evac-center-removebg-preview.png" className={styles.legendIcon} alt=""/> Evac
              </span>
              <span className={styles.legendItem}><img src="/icons/evac-tent.png" className={styles.legendIcon} alt=""/> Shelter</span>
              <span className={styles.legendItem}><img src="/icons/hospital.png" className={styles.legendIcon} alt=""/> Hospital</span>
            </div>
          </div>

          <div className={styles.nearestResources} aria-label="Nearest emergency resources">
            {[
              { key: 'evacuation', label: 'Evacuation center', icon: '/icons/evac-center-removebg-preview.png' },
              { key: 'shelter', label: 'Temporary shelter', icon: '/icons/evac-tent.png' },
              { key: 'hospital', label: 'Hospital', icon: '/icons/hospital.png' },
            ].map(resource => {
              const place = nearestResources[resource.key]
              return (
                <article className={styles.resourceCard} key={resource.key}>
                  <span className={styles.resourceType}>
                    <img src={resource.icon} alt="" />
                    {resource.label}
                  </span>
                  <strong title={place?.name}>{place?.name ?? 'No nearby listing'}</strong>
                  <span className={styles.resourceDistance}>
                    {place ? `${place.distanceKm.toFixed(2)} km straight-line` : 'Try again when location is available'}
                  </span>
                  {place && (
                    <a
                      className={styles.routeLink}
                      href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${place.lat},${place.lng}`)}&travelmode=walking`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Directions <span aria-hidden="true">↗</span>
                    </a>
                  )}
                </article>
              )
            })}
          </div>
          <p className={styles.siteDisclaimer}>Map listings may be incomplete or out of date. Confirm a site is open before travelling.</p>

          <div className={styles.mapFrame}>
            <div ref={mapWrapRef} className={styles.mapWrap}>
              <div ref={mapRef} className={styles.map} />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
})
