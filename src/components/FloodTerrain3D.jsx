/** OpenStreetMap terrain with a DEM-based, connected bathtub flood scenario. */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { gsap } from 'gsap'
import 'maplibre-gl/dist/maplibre-gl.css'
import styles from './FloodTerrain3D.module.css'
import { getWeatherLighting } from '../hooks/useWeather.js'
import { CHANNEL_M, createFloodWater, distanceBetweenCoordinates, solarPosition } from './floodWater.js'
import VolumetricCloudLayer3D, { CloudToggleControl } from './VolumetricCloudLayer3D'
import RainOverlay from './RainOverlay'

maplibregl.setWorkerUrl(mapWorkerUrl)

const TERRAIN_EXAGGERATION = 1
const DEFAULT_LNG = 123.1945
const DEFAULT_LAT = 13.6218
const SITE_MIN_ZOOM = 18.5
const SITE_MAX_ZOOM = 20.5
const SITE_INITIAL_ZOOM = 19.0
const SITE_DEFAULT_ZOOM = 18.5
const SITE_CAMERA_PITCH = 38
const SITE_CAMERA_BEARING = -8
const AUTO_FOCUS_DISTANCE_M = 1500
const MAP_ROAM_RADIUS_M = 1500

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function mapBoundsFor(center) {
  const latitudeDelta = MAP_ROAM_RADIUS_M / 111320
  const longitudeDelta = MAP_ROAM_RADIUS_M
    / (111320 * Math.max(0.01, Math.cos(center.latitude * Math.PI / 180)))
  return [
    [center.longitude - longitudeDelta, center.latitude - latitudeDelta],
    [center.longitude + longitudeDelta, center.latitude + latitudeDelta],
  ]
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex(rgb) {
  return `#${rgb.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`
}

function localHour() {
  const now = new Date()
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600
}

function cloudLightingForHour(hour, weather, location) {
  const { azimuth, polar, elevation } = solarPosition(hour, location)
  const phase = elevation < -6 ? 'Night' : 'Daylight'
  return { ...getWeatherLighting(weather), azimuth, polar, phase }
}

const DRY_HEIGHT_STOPS = [
  [0, '#F2D8A5'],
  [4, '#EBC98A'],
  [8, '#E0B876'],
  [14, '#D5A866'],
  [24, '#C99A58'],
].map(([stop, hex]) => [stop, hexToRgb(hex)])

const HEIGHT_COLOR_STOPS = [
  [3, '#F0D39B'],
  [8, '#E4C184'],
  [14, '#D7AE70'],
  [24, '#C99A58'],
].map(([stop, hex]) => [stop, hexToRgb(hex)])

const NIGHT_BUILDING_COLOR = [91, 85, 76]

function buildingColorExpression(mode, daylight = 1) {
  const stops = mode === 'height' ? HEIGHT_COLOR_STOPS : DRY_HEIGHT_STOPS
  const height = ['to-number', ['get', 'render_height'],
    ['to-number', ['get', 'height'],
      ['*', ['to-number', ['get', 'building:levels'], 1], 3.5]]]
  return ['interpolate', ['linear'], height, ...stops.flatMap(([value, color]) => [
    value,
    rgbToHex([
      color[0] + (NIGHT_BUILDING_COLOR[0] - color[0]) * (1 - daylight),
      color[1] + (NIGHT_BUILDING_COLOR[1] - color[1]) * (1 - daylight),
      color[2] + (NIGHT_BUILDING_COLOR[2] - color[2]) * (1 - daylight),
    ]),
  ])]
}

function getSensorCoordinates(sensor, sensorOnline) {
  if (!sensorOnline || sensor?._isMock === true) return null

  const latitude = Number(sensor?.latitude)
  const longitude = Number(sensor?.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) < 0.01) {
    return null
  }

  return { latitude, longitude }
}

function buildStyle(buildingColorMode = 'depth', daylight = 1) {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      ofm: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution: '© OpenFreeMap © OpenStreetMap contributors',
      },
      'osm-raster': {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© OpenStreetMap contributors',
      },
      'terrain-dem': {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 15,
        encoding: 'terrarium',
        attribution: 'Terrain tiles © AWS Terrain Tiles, Mapzen',
      },
      'terrain-hillshade-dem': {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 15,
        encoding: 'terrarium',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#E9EDF0' } },
      {
        id: 'openstreetmap-base',
        type: 'raster',
        source: 'osm-raster',
      },
      {
        id: 'terrain-hillshade',
        type: 'hillshade',
        source: 'terrain-hillshade-dem',
        paint: {
          'hillshade-illumination-direction': 315,
          'hillshade-illumination-anchor': 'map',
          'hillshade-exaggeration': 0.12,
          'hillshade-shadow-color': '#62594C',
          'hillshade-highlight-color': '#FFF3D8',
          'hillshade-accent-color': '#D2C6B2',
        },
      },
      {
        id: 'building-shadows',
        type: 'fill',
        source: 'ofm',
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-color': '#28231E',
          'fill-opacity': 0,
          'fill-translate': [0, 0],
          'fill-translate-anchor': 'map',
        },
      },
      {
        id: 'building',
        type: 'fill-extrusion',
        source: 'ofm',
        'source-layer': 'building',
        minzoom: 12,
        paint: {
          'fill-extrusion-color': buildingColorExpression(buildingColorMode, daylight),
          'fill-extrusion-height': [
            'max', 3.5,
            ['to-number', ['get', 'render_height'],
              ['to-number', ['get', 'height'],
                ['*', ['to-number', ['get', 'building:levels'], 1], 3.5]]],
          ],
          'fill-extrusion-base': ['to-number', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.97,
        },
      },
      {
        id: 'building-outlines',
        type: 'line',
        source: 'ofm',
        'source-layer': 'building',
        minzoom: 14,
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': '#30251E',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 18, 4, 20, 5],
          'line-opacity': 1,
        },
      },
      {
        id: 'label-place',
        type: 'symbol',
        source: 'ofm',
        'source-layer': 'place',
        filter: ['in', 'class', 'city', 'town', 'village'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
          'text-max-width': 8,
        },
        paint: {         'text-color': '#35424C', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.5 },
      },
    ],
  }
}

export default function FloodTerrain3D({
  sensor,
  sensorOnline,
  waterLevelM,
  weather,
  hourOverride = null,
  rainEnabled = true,
  buildingColorMode = 'depth',
  onMapReady,
}) {
  const mountRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const obsRef = useRef(null)
  const initRef = useRef(false)
  const floodRef = useRef(null)
  const centeredOnSensorRef = useRef(false)
  const lastCoordinatesRef = useRef({ longitude: DEFAULT_LNG, latitude: DEFAULT_LAT, hasGps: false })
  const latestPropsRef = useRef(null)
  const markerAnimationRef = useRef(null)
  const cameraAnimationRef = useRef(null)
  const animateCameraRef = useRef(null)
  const syncTimerRef = useRef(null)
  const cloudLayerRef = useRef(null)
  const mapReadyRef = useRef(false)
  const [locSrc, setLocSrc] = useState('default')
  const [scenarioLoading, setScenarioLoading] = useState(false)
  const [terrainError, setTerrainError] = useState(null)
  const [wetCellCount, setWetCellCount] = useState(0)
  const [affectedBuildings, setAffectedBuildings] = useState(0)
  const [error, setError] = useState(null)
  const [zoom, setZoom] = useState(SITE_INITIAL_ZOOM)
  const [clockHour, setClockHour] = useState(localHour)
  const [grade, setGrade] = useState(null)

  const hour = hourOverride ?? clockHour
  const sensorCoords = getSensorCoordinates(sensor, sensorOnline)
  const sceneCenter = sensorCoords ?? lastCoordinatesRef.current
  const longitude = sceneCenter.longitude
  const latitude = sceneCenter.latitude
  latestPropsRef.current = { sensor, sensorOnline, waterLevelM, weather, hour }

  // Follow the real clock unless the time is set by hand
  useEffect(() => {
    if (hourOverride != null) return undefined
    setClockHour(localHour())
    const timer = setInterval(() => setClockHour(localHour()), 30000)
    return () => clearInterval(timer)
  }, [hourOverride])

  // Keep the sun, sky and terrain shading tied to the current map location and local time.
  useEffect(() => {
    const flood = floodRef.current
    if (!flood || !mapReadyRef.current) return
    flood.setCenter({ longitude, latitude })
    setGrade(flood.setHour(hour, weather))
  }, [hour, weather, longitude, latitude])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.getLayer('building')) return
    const sun = solarPosition(hour, { latitude, longitude })
    const daylight = Math.sin(Math.max(0, sun.elevation) * Math.PI / 180)
    map.setPaintProperty('building', 'fill-extrusion-color', buildingColorExpression(buildingColorMode, daylight))
  }, [buildingColorMode, hour, latitude, longitude])

  const syncMapData = useCallback(() => {
    const map = mapRef.current
    if (!map || !mapReadyRef.current) return

    const latest = latestPropsRef.current
    const sensorCoords = getSensorCoordinates(latest.sensor, latest.sensorOnline)
    if (sensorCoords) {
      lastCoordinatesRef.current = { ...sensorCoords, hasGps: true }
      setLocSrc('gps')
    } else {
      setLocSrc(lastCoordinatesRef.current.hasGps ? 'offline' : 'default')
    }

    const { longitude, latitude } = sensorCoords ?? lastCoordinatesRef.current
    markerRef.current?.setLngLat([longitude, latitude])
    const markerElement = markerRef.current?.getElement()
    markerElement?.setAttribute('data-connected', String(Boolean(sensorCoords)))
    markerElement?.setAttribute('aria-label', sensorCoords
      ? 'Live flood sensor GPS location'
      : lastCoordinatesRef.current.hasGps
        ? 'Last known flood sensor location'
        : 'Default map location in Naga City')

    // Keep cloud layer anchored over the sensor (or default position)
    cloudLayerRef.current?.setOrigin(longitude, latitude)

    if (sensorCoords && !centeredOnSensorRef.current) {
      centeredOnSensorRef.current = true
      const center = map.getCenter()
      if (distanceBetweenCoordinates(
        { longitude: center.lng, latitude: center.lat },
        sensorCoords,
      ) <= AUTO_FOCUS_DISTANCE_M) {
        animateCameraRef.current?.([longitude, latitude], {
          zoom: SITE_DEFAULT_ZOOM,
          pitch: SITE_CAMERA_PITCH,
          bearing: SITE_CAMERA_BEARING,
          duration: 1.1,
        })
      }
    }
  }, [])

  useEffect(() => {
    floodRef.current?.setLevel(waterLevelM)
  }, [waterLevelM])

  useEffect(() => {
    const el = mountRef.current
    if (!el || initRef.current) return
    initRef.current = true

    const initialProps = latestPropsRef.current
    const initialSensorCoords = getSensorCoordinates(initialProps.sensor, initialProps.sensorOnline)
    const defaultCoords = lastCoordinatesRef.current
    const initialCoords = initialSensorCoords
      && distanceBetweenCoordinates(defaultCoords, initialSensorCoords) <= AUTO_FOCUS_DISTANCE_M
      ? initialSensorCoords
      : defaultCoords
    if (initialSensorCoords) {
      lastCoordinatesRef.current = { ...initialSensorCoords, hasGps: true }
      centeredOnSensorRef.current = true
    }
    const initialSun = solarPosition(initialProps.hour, {
      latitude: initialCoords.latitude,
      longitude: initialCoords.longitude,
    })
    const initialDaylight = Math.sin(Math.max(0, initialSun.elevation) * Math.PI / 180)

    let map
    try {
      map = new maplibregl.Map({
        container: el,
        style: buildStyle(buildingColorMode, initialDaylight),
        center: [initialCoords.longitude, initialCoords.latitude],
        zoom: SITE_INITIAL_ZOOM,
        pitch: SITE_CAMERA_PITCH,
        bearing: SITE_CAMERA_BEARING,
        antialias: false,
        maxZoom: SITE_MAX_ZOOM,
        minZoom: SITE_MIN_ZOOM,
        maxBounds: mapBoundsFor(initialCoords),
        minPitch: 25,
        maxPitch: 54,
        fadeDuration: 100,
        refreshExpiredTiles: false,
      })
    } catch (e) {
      setError(`WebGL unavailable: ${e.message}`)
      return
    }

    mapRef.current = map
    map.on('zoom', () => setZoom(map.getZoom()))
    map.dragRotate.enable()
    map.touchZoomRotate.enableRotation()
    map.touchPitch.enable()
    animateCameraRef.current = (center, options = {}) => {
      cameraAnimationRef.current?.kill()
      const startCenter = map.getCenter()
      const startView = {
        longitude: startCenter.lng,
        latitude: startCenter.lat,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
        progress: 0,
      }
      const target = {
        longitude: center[0],
        latitude: center[1],
        zoom: options.zoom ?? SITE_DEFAULT_ZOOM,
        pitch: options.pitch ?? SITE_CAMERA_PITCH,
        bearing: options.bearing ?? SITE_CAMERA_BEARING,
      }
      cameraAnimationRef.current = gsap.to(startView, {
        progress: 1,
        duration: options.duration ?? 1.2,
        ease: 'power3.inOut',
        onUpdate: () => {
          const progress = startView.progress
          const interpolate = (from, to) => from + (to - from) * progress
          map.jumpTo({
            center: [
              interpolate(startView.longitude, target.longitude),
              interpolate(startView.latitude, target.latitude),
            ],
            zoom: interpolate(startView.zoom, target.zoom),
            pitch: interpolate(startView.pitch, target.pitch),
            bearing: interpolate(startView.bearing, target.bearing),
          })
        },
        onComplete: options.onComplete,
      })
    }
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
    map.on('error', e => console.warn('[3D]', e.error?.message ?? e))

    map.once('load', () => {
      console.log('[FloodTerrain3D] Map load event - adding terrain and layers')
      map.setTerrain({ source: 'terrain-dem', exaggeration: TERRAIN_EXAGGERATION })
      try {
        floodRef.current = createFloodWater(map, {
          center: initialCoords,
          beforeLayerId: 'building',
          buildingsAboveLayerId: 'label-place',
          onStats: stats => {
            setWetCellCount(stats.wetCells)
            setAffectedBuildings(stats.affectedBuildings)
            setScenarioLoading(stats.loading)
            setTerrainError(stats.error)
          },
        })
        floodRef.current.setLevel(latestPropsRef.current.waterLevelM)
        setGrade(floodRef.current.setHour(latestPropsRef.current.hour, latestPropsRef.current.weather))
      } catch (floodError) {
        console.error('[FloodTerrain3D] Flood water controller error:', floodError)
        setTerrainError(floodError instanceof Error ? floodError.message : String(floodError))
      }
      mapReadyRef.current = true

      const markerElement = document.createElement('div')
      markerElement.className = styles.sensorMarker
      markerElement.setAttribute('data-connected', String(Boolean(initialSensorCoords)))
      markerElement.setAttribute('role', 'img')
      markerElement.setAttribute('aria-label', initialSensorCoords
        ? 'Live flood sensor GPS location'
        : 'Default map location in Naga City')
      markerElement.innerHTML = `
        <span class="${styles.markerPulse}" aria-hidden="true"></span>
        <span class="${styles.markerCore}" aria-hidden="true"></span>`

      const marker = new maplibregl.Marker({
        element: markerElement,
        anchor: 'center',
        pitchAlignment: 'viewport',
        rotationAlignment: 'viewport',
      })
        .setLngLat([initialCoords.longitude, initialCoords.latitude])
        .addTo(map)
      markerRef.current = marker
      const markerPulse = markerElement.querySelector(`.${styles.markerPulse}`)
      if (markerPulse && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        markerAnimationRef.current = gsap.fromTo(markerPulse,
          { scale: 0.55, opacity: 0.85 },
          { scale: 2.2, opacity: 0, duration: 1.65, repeat: -1, ease: 'power2.out' })
      }

      syncMapData()
      map.once('idle', syncMapData)

      // Volumetric clouds
      try {
        const weather = latestPropsRef.current.weather
        const cloudLayer = new VolumetricCloudLayer3D({
          id: 'volumetric-clouds',
          weather: weather || {},
          lighting: cloudLightingForHour(latestPropsRef.current.hour, weather, {
            latitude: initialCoords.latitude,
            longitude: initialCoords.longitude,
          }),
        })
        cloudLayerRef.current = cloudLayer
        map.addLayer(cloudLayer, 'label-place')
        map.addControl(new CloudToggleControl(() => cloudLayerRef.current), 'top-right')
      } catch (e) {
        console.error('[FloodTerrain3D] Cloud layer error:', e)
      }

      onMapReady?.({
        focusOnSensor: () => {
          const center = markerRef.current?.getLngLat() ?? map.getCenter()
          map.setMaxBounds(null)
          animateCameraRef.current?.([center.lng, center.lat], {
            zoom: SITE_DEFAULT_ZOOM,
            pitch: SITE_CAMERA_PITCH,
            bearing: SITE_CAMERA_BEARING,
            duration: 1.2,
            onComplete: () => map.setMaxBounds(mapBoundsFor({
              longitude: center.lng,
              latitude: center.lat,
            })),
          })
        },
      })
      animateCameraRef.current?.([initialCoords.longitude, initialCoords.latitude], {
        zoom: SITE_INITIAL_ZOOM,
        pitch: SITE_CAMERA_PITCH,
        bearing: SITE_CAMERA_BEARING,
        duration: 1.55,
      })
    })

    obsRef.current = new ResizeObserver(() => {
      requestAnimationFrame(() => map.resize())
    })
    obsRef.current.observe(el)

    return () => {
      obsRef.current?.disconnect()
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
      floodRef.current?.destroy()
      floodRef.current = null
      markerAnimationRef.current?.kill()
      cameraAnimationRef.current?.kill()
      markerAnimationRef.current = null
      cameraAnimationRef.current = null
      animateCameraRef.current = null
      markerRef.current?.remove()
      markerRef.current = null
      cloudLayerRef.current = null
      mapReadyRef.current = false
      onMapReady?.(null)
      map.remove()
      mapRef.current = null
      initRef.current = false
    }
  }, [onMapReady, syncMapData])

  // Keep cloud illumination synchronized with the same time-of-day lighting as the map.
  useEffect(() => {
    const cloudLayer = cloudLayerRef.current
    if (!cloudLayer) return
    cloudLayer.updateWeather(weather ?? {}, cloudLightingForHour(hour, weather, { latitude, longitude }))
  }, [weather, hour, latitude, longitude])

  // Sensor position changes are debounced
  useEffect(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(syncMapData, 180)
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    }
  }, [sensorOnline, sensor?._isMock, sensor?.latitude, sensor?.longitude, syncMapData])

  if (error) return (
    <div className={styles.errBox}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>{error}</span>
    </div>
  )

  const level = Number.isFinite(waterLevelM)
    ? Math.max(0, Math.min(CHANNEL_M, waterLevelM))
    : null
  return (
    <div className={styles.wrapper}>
      <div ref={mountRef} className={styles.canvas} />

      {/* Rain droplets overlay — driven by live weather */}
      <RainOverlay weather={weather} enabled={rainEnabled} />

      {/* Keep the time-of-day vignette without tinting the basemap or building colors. */}
      {grade && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: `radial-gradient(ellipse at 50% 55%, rgba(0,0,0,0) 55%, rgba(4,8,14,${grade.vignette.toFixed(2)}) 100%)`,
          }}
        />
      )}

      <div className={`${styles.badge} ${styles[`loc_${locSrc}`]}`}>
        <span className={styles.badgeDot}/>
        <span className={styles.badgeText}>
          {locSrc === 'gps' && sensorCoords
            ? `Sensor · ${sensorCoords.latitude.toFixed(4)}, ${sensorCoords.longitude.toFixed(4)}`
            : locSrc === 'offline' ? 'Last sensor location' : 'Naga City'}
        </span>
      </div>

      <label className={styles.zoomControl}>
        <span className={styles.zoomLabel}>
          <span>ZOOM</span>
          <output>{zoom.toFixed(1)}</output>
        </span>
        <input
          aria-label="Map zoom"
          type="range"
          min={SITE_MIN_ZOOM}
          max={SITE_MAX_ZOOM}
          step="0.1"
          value={zoom}
          onChange={event => mapRef.current?.easeTo({
            zoom: Number(event.target.value),
            duration: 0.12,
          })}
        />
      </label>

      {sensorOnline && level != null && (
        <div
          className={styles.liveLevelBadge}
          aria-label={`Live water level ${level.toFixed(2)} meters; ${wetCellCount} wet terrain cells; ${affectedBuildings} affected buildings`}
        >
          <span className={`${styles.badgeDot} ${styles.statusDot}`} />
          {level.toFixed(2)} m
          {terrainError && <span className={styles.terrainWarning}>Terrain unavailable</span>}
          {!terrainError && scenarioLoading && <span className={styles.terrainWarning}>Loading terrain</span>}
          {!terrainError && !scenarioLoading && wetCellCount > 0 && (
            <span className={styles.terrainWarning}>
              {wetCellCount} cells · {affectedBuildings} buildings
            </span>
          )}
        </div>
      )}
    </div>
  )
}
