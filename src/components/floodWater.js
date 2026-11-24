/**
 * floodWater.js  -  R.I.S.I.N.G comic flood water for MapLibre GL JS.
 *
 * ONE self-contained file. No React, no gsap, no CSS. DO NOT REWRITE OR "SIMPLIFY" IT.
 * Import it and call the API at the bottom. All the water look lives here:
 *   - bathtub flood fill on a DEM grid, smooth polygon outline (Chaikin)
 *   - saturated depth bands (surface / mid / deep / core) + white foam shoreline
 *   - eased level changes (water fills and drains instead of jumping)
 *   - ripples around the sensor, breathing opacity
 *   - per-building color that fades continuously with the water depth at its footprint
 *   - time-of-day sky, light and basemap brightness (setHour)
 *
 * Usage:
 *   import { createFloodWater } from './floodWater.js'
 *   const flood = createFloodWater(map, { center: { longitude: 123.1945, latitude: 13.6218 } })
 *   flood.setLevel(sensor.waterLevelM)      // meters, same scale as the app (onset 3.15, channel 12.6)
 *   const grade = flood.setHour(14.5, weather)   // returns vignette strength
 *   flood.destroy()
 */
const CHANNEL_M = 12.60
const FLOOD_ONSET_M = 3.15
const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] }
const GRID_SPACING_M = 4
const FLOOD_MODEL_RADIUS_M = 80
const GRID_SIDE = Math.ceil((FLOOD_MODEL_RADIUS_M * 2) / GRID_SPACING_M) + 1
const GRID_HALF = Math.floor(GRID_SIDE / 2)
const EMPTY_WET_CELLS = new Uint8Array(GRID_SIDE * GRID_SIDE)
const WATER_LAYER_OPACITY = [
  { id: 'flood-water-surface', depthBand: 'surface', opacity: 0.78, start: 0 },
  { id: 'flood-water-mid', depthBand: 'mid', opacity: 0.84, start: 0 },
  { id: 'flood-water-deep', depthBand: 'deep', opacity: 0.9, start: 0 },
  { id: 'flood-water-core', depthBand: 'core', opacity: 0.94, start: 0 },
]
const MAX_BUILDINGS_TO_SAMPLE = 500
const DEM_ZOOM = 15
const DEM_TILE_SIZE = 256
const MAX_CACHED_DEM_TILES = 16
const DEM_TILE_CACHE = new Map()
const DEFAULT_LIGHT_LOCATION = { latitude: 13.6218, longitude: 123.1945 }
const NIGHT_BUILDING_COLOR = [91, 85, 76]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex(rgb) {
  return `#${rgb.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`
}

function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function localHour() {
  const now = new Date()
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600
}

/**
 * Time-of-day look. Hours are on the local clock and everything blends smoothly between keys.
 * [hour, sky top, horizon, fog]
 */
const LIGHT_KEYS = [
  [0,     '#0E2742', '#244A6B', '#1B3855'],
  [4.75,  '#122E4D', '#2C5579', '#21415F'],
  [5.75,  '#527EA6', '#83A9C9', '#7398B8'],
  [6.75,  '#80ACD0', '#B2D3EC', '#A8CBE5'],
  [9,     '#78B3DB', '#C9E0F1', '#BCD7EB'],
  [12,    '#6FB4EE', '#D3E7F5', '#C2DDEE'],
  [15.5,  '#78B3DB', '#C9E0F1', '#BCD7EB'],
  [17.25, '#6999C0', '#A6C8E2', '#87ACCA'],
  [18.25, '#345E85', '#7196B7', '#4E7090'],
  [19.25, '#1B3654', '#45698B', '#294764'],
  [24,    '#0E2742', '#244A6B', '#1B3855'],
].map(([hour, sky, horizon, fog]) => ({
  hour,
  sky: hexToRgb(sky),
  horizon: hexToRgb(horizon),
  fog: hexToRgb(fog),
}))

function lightingForHour(hour) {
  const h = ((hour % 24) + 24) % 24
  let index = 0
  while (index < LIGHT_KEYS.length - 2 && h >= LIGHT_KEYS[index + 1].hour) index++
  const from = LIGHT_KEYS[index]
  const to = LIGHT_KEYS[index + 1]
  const f = smoothstep(0, 1, (h - from.hour) / (to.hour - from.hour))
  return {
    sky: mixRgb(from.sky, to.sky, f),
    horizon: mixRgb(from.horizon, to.horizon, f),
    fog: mixRgb(from.fog, to.fog, f),
  }
}

function solarPosition(
  hour,
  { latitude, longitude } = DEFAULT_LIGHT_LOCATION,
  date = new Date(),
  timezoneOffsetMinutes = date.getTimezoneOffset(),
) {
  const yearStart = new Date(date.getFullYear(), 0, 0)
  const dayOfYear = Math.floor((date - yearStart) / 86400000)
  const daysInYear = (new Date(date.getFullYear() + 1, 0, 1) - new Date(date.getFullYear(), 0, 1)) / 86400000
  const localHour = ((hour % 24) + 24) % 24
  const gamma = 2 * Math.PI / daysInYear * (dayOfYear - 1 + (localHour - 12) / 24)
  const equationOfTime = 229.18 * (
    0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)
  )
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
  const timezoneHours = -timezoneOffsetMinutes / 60
  const solarMinutes = ((localHour * 60 + equationOfTime + 4 * longitude - 60 * timezoneHours) % 1440 + 1440) % 1440
  const hourAngle = (solarMinutes / 4 - 180) * Math.PI / 180
  const latitudeRad = latitude * Math.PI / 180
  const cosZenith = Math.sin(latitudeRad) * Math.sin(declination)
    + Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle)
  const elevation = 90 - Math.acos(clamp(cosZenith, -1, 1)) * 180 / Math.PI
  const azimuth = (Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitudeRad) - Math.tan(declination) * Math.cos(latitudeRad),
  ) * 180 / Math.PI + 180 + 360) % 360
  return { azimuth, elevation, polar: clamp(90 - elevation, 12, 168) }
}

// shortcut: shadows use an 8 m average building height, upgrade to per-building meshes for varied heights.
function buildingShadowForSun(sun, latitude, zoom) {
  const daylight = Math.sin(Math.max(0, sun.elevation) * Math.PI / 180)
  if (!daylight) return { translate: [0, 0], opacity: 0 }

  const elevation = Math.max(3, sun.elevation) * Math.PI / 180
  const shadowMeters = clamp(8 / Math.tan(elevation), 0, 30)
  const metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / 2 ** zoom
  const shadowPixels = shadowMeters / metersPerPixel
  const azimuth = sun.azimuth * Math.PI / 180
  return {
    translate: [-Math.sin(azimuth) * shadowPixels, Math.cos(azimuth) * shadowPixels],
    opacity: 0.24 * daylight,
  }
}

function updateBuildingShadow(map, sun, location) {
  if (!map.getLayer('building-shadows')) return
  const shadow = buildingShadowForSun(sun, location.latitude, map.getZoom())
  map.setPaintProperty('building-shadows', 'fill-translate', shadow.translate)
  map.setPaintProperty('building-shadows', 'fill-opacity', shadow.opacity)
}

/** Applies local-solar lighting, sky and terrain shadows for the hour. */
function applyLighting(map, hour, weather, location = DEFAULT_LIGHT_LOCATION) {
  const look = lightingForHour(hour)
  const sun = solarPosition(hour, location)
  const overcast = clamp((weather?.cloudCover ?? 0) / 100, 0, 1)
  const daylight = Math.sin(Math.max(0, sun.elevation) * Math.PI / 180)
  const nightFog = clamp(-sun.elevation / 12, 0, 1)
  const wash = overcast * 0.55 * daylight
  const gray = [170, 183, 192]
  const washed = rgb => rgbToHex(mixRgb(rgb, gray, wash))
  const fogColor = rgbToHex(mixRgb(hexToRgb(washed(look.fog)), [96, 101, 108], nightFog))

  map.setSky({
    'sky-color': washed(look.sky),
    'horizon-color': washed(look.horizon),
    'fog-color': fogColor,
    'fog-ground-blend': 0.18 + nightFog * 0.16,
    'horizon-fog-blend': 0.22 + nightFog * 0.28,
    'sky-horizon-blend': 0.35,
    'atmosphere-blend': 0.5,
  })

  const warmSun = mixRgb([255, 190, 130], [255, 250, 235], clamp(sun.elevation / 20, 0, 1))
  const lightColor = sun.elevation < -6 ? '#ECE6D9' : rgbToHex(warmSun)
  map.setLight({
    anchor: 'map',
    position: [1.15, sun.azimuth, sun.polar],
    color: lightColor,
    intensity: clamp(0.08 + daylight * 0.55 * (1 - 0.3 * overcast), 0.05, 0.63),
  })

  if (map.getLayer('openstreetmap-base')) {
    map.setPaintProperty('openstreetmap-base', 'raster-brightness-max',
      clamp(0.55 + daylight * 0.45 * (1 - 0.06 * overcast), 0.55, 1))
  }

  updateBuildingShadow(map, sun, location)
  const outlineColor = rgbToHex(mixRgb([142, 133, 119], [48, 37, 30], daylight))
  for (const id of ['building-outlines', 'flooded-building-outlines']) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', outlineColor)
  }

  if (map.getLayer('terrain-hillshade')) {
    map.setPaintProperty('terrain-hillshade', 'hillshade-illumination-direction', sun.azimuth)
    map.setPaintProperty('terrain-hillshade', 'hillshade-exaggeration', 0.35 * daylight)
  }

  return { vignette: 0.3 + 0.3 * (1 - daylight) }
}

function geometryPolygons(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  return geometry.type === 'MultiPolygon' ? geometry.coordinates : []
}

function geometryCenter(geometry) {
  const polygons = geometryPolygons(geometry)
  const ring = polygons[0]?.[0]
  if (!ring?.length) return null

  const points = ring.slice(0, -1)
  if (!points.length) return null

  const sum = points.reduce(
    (total, [longitude, latitude]) => ({
      longitude: total.longitude + longitude,
      latitude: total.latitude + latitude,
    }),
    { longitude: 0, latitude: 0 },
  )

  return {
    longitude: sum.longitude / points.length,
    latitude: sum.latitude / points.length,
  }
}

function geometryIntersectsBounds(geometry, bounds) {
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  for (const polygon of geometryPolygons(geometry)) {
    for (const ring of polygon) {
      for (const [longitude, latitude] of ring) {
        west = Math.min(west, longitude)
        east = Math.max(east, longitude)
        south = Math.min(south, latitude)
        north = Math.max(north, latitude)
      }
    }
  }
  return west <= bounds.getEast()
    && east >= bounds.getWest()
    && south <= bounds.getNorth()
    && north >= bounds.getSouth()
}

function geometrySamplePoints(geometry) {
  const polygons = geometryPolygons(geometry)
  const points = []
  const center = geometryCenter(geometry)
  if (center) points.push(center)

  for (const polygon of polygons) {
    const vertices = polygon[0]?.slice(0, -1) ?? []
    const stride = Math.max(1, Math.ceil(vertices.length / 16))
    for (let index = 0; index < vertices.length; index += stride) {
      const [longitude, latitude] = vertices[index]
      points.push({ longitude, latitude })
    }
  }

  return points
}

function offsetMeters(origin, eastM, northM) {
  const metersPerDegree = 111320
  const longitudeScale = Math.max(0.01, Math.cos(origin.latitude * Math.PI / 180))
  return {
    longitude: origin.longitude + eastM / (metersPerDegree * longitudeScale),
    latitude: origin.latitude + northM / metersPerDegree,
  }
}

function metersFrom(origin, point) {
  const metersPerDegree = 111320
  return {
    east: (point.longitude - origin.longitude)
      * metersPerDegree * Math.cos(origin.latitude * Math.PI / 180),
    north: (point.latitude - origin.latitude) * metersPerDegree,
  }
}

function distanceBetweenCoordinates(origin, point) {
  const offset = metersFrom(origin, point)
  return Math.hypot(offset.east, offset.north)
}

function demTilePoint(point) {
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.latitude))
  const tileCount = 2 ** DEM_ZOOM
  const x = ((point.longitude + 180) / 360) * tileCount
  const latitudeRadians = latitude * Math.PI / 180
  const y = ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * tileCount
  const tileX = Math.max(0, Math.min(tileCount - 1, Math.floor(x)))
  const tileY = Math.max(0, Math.min(tileCount - 1, Math.floor(y)))
  return {
    tileX,
    tileY,
    pixelX: Math.max(0, Math.min(DEM_TILE_SIZE - 1, (x - tileX) * DEM_TILE_SIZE)),
    pixelY: Math.max(0, Math.min(DEM_TILE_SIZE - 1, (y - tileY) * DEM_TILE_SIZE)),
  }
}

function terrariumElevation(pixels, x, y) {
  const pixelOffset = (y * DEM_TILE_SIZE + x) * 4
  return pixels[pixelOffset] * 256
    + pixels[pixelOffset + 1]
    + pixels[pixelOffset + 2] / 256
    - 32768
}

function sampleDemPixel(pixels, pixelX, pixelY) {
  const x0 = Math.floor(pixelX)
  const y0 = Math.floor(pixelY)
  const x1 = Math.min(DEM_TILE_SIZE - 1, x0 + 1)
  const y1 = Math.min(DEM_TILE_SIZE - 1, y0 + 1)
  const xBlend = pixelX - x0
  const yBlend = pixelY - y0
  const top = terrariumElevation(pixels, x0, y0) * (1 - xBlend)
    + terrariumElevation(pixels, x1, y0) * xBlend
  const bottom = terrariumElevation(pixels, x0, y1) * (1 - xBlend)
    + terrariumElevation(pixels, x1, y1) * xBlend
  return top * (1 - yBlend) + bottom * yBlend
}

function loadDemTilePixels(tileX, tileY) {
  const key = `${DEM_ZOOM}/${tileX}/${tileY}`
  const cached = DEM_TILE_CACHE.get(key)
  if (cached) {
    DEM_TILE_CACHE.delete(key)
    DEM_TILE_CACHE.set(key, cached)
    return cached
  }

  const request = fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`)
    .then(response => {
      if (!response.ok) throw new Error(`DEM tile ${key} returned HTTP ${response.status}`)
      return response.blob()
    })
    .then(createImageBitmap)
    .then(bitmap => {
      const canvas = document.createElement('canvas')
      canvas.width = DEM_TILE_SIZE
      canvas.height = DEM_TILE_SIZE
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('Canvas 2D context is unavailable for DEM sampling')
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      return context.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE).data
    })

  DEM_TILE_CACHE.set(key, request)
  if (DEM_TILE_CACHE.size > MAX_CACHED_DEM_TILES) {
    const oldestKey = DEM_TILE_CACHE.keys().next().value
    DEM_TILE_CACHE.delete(oldestKey)
  }
  request.catch(() => {
    if (DEM_TILE_CACHE.get(key) === request) DEM_TILE_CACHE.delete(key)
  })
  return request
}

async function sampleTerrainGrid(center) {
  const elevations = new Float32Array(GRID_SIDE * GRID_SIDE)
  elevations.fill(Number.NaN)
  const tiles = new Map()
  for (let row = 0; row < GRID_SIDE; row++) {
    for (let column = 0; column < GRID_SIDE; column++) {
      const point = offsetMeters(
        center,
        (column - GRID_HALF) * GRID_SPACING_M,
        (GRID_HALF - row) * GRID_SPACING_M,
      )
      const tilePoint = demTilePoint(point)
      const tileKey = `${tilePoint.tileX}/${tilePoint.tileY}`
      const sample = { index: row * GRID_SIDE + column, ...tilePoint }
      const tileSamples = tiles.get(tileKey) ?? []
      tileSamples.push(sample)
      tiles.set(tileKey, tileSamples)
    }
  }

  await Promise.all([...tiles.entries()].map(async ([tileKey, tileSamples]) => {
    const [tileX, tileY] = tileKey.split('/').map(Number)
    const pixels = await loadDemTilePixels(tileX, tileY)
    for (const sample of tileSamples) {
      elevations[sample.index] = sampleDemPixel(pixels, sample.pixelX, sample.pixelY)
    }
  }))

  return elevations
}

function smoothTerrainGrid(elevations) {
  const weights = [1, 2, 1]
  const smoothed = new Float32Array(elevations.length)
  smoothed.fill(Number.NaN)

  for (let index = 0; index < elevations.length; index++) {
    const elevation = elevations[index]
    if (!Number.isFinite(elevation)) continue
    const row = Math.floor(index / GRID_SIDE)
    const column = index % GRID_SIDE
    let weightedElevation = 0
    let totalWeight = 0

    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
        const sampleRow = row + rowOffset
        const sampleColumn = column + columnOffset
        if (sampleRow < 0 || sampleRow >= GRID_SIDE
          || sampleColumn < 0 || sampleColumn >= GRID_SIDE) continue
        const sampleElevation = elevations[sampleRow * GRID_SIDE + sampleColumn]
        if (!Number.isFinite(sampleElevation)) continue
        const weight = weights[rowOffset + 1] * weights[columnOffset + 1]
        weightedElevation += sampleElevation * weight
        totalWeight += weight
      }
    }

    smoothed[index] = totalWeight ? weightedElevation / totalWeight : elevation
  }

  return smoothed
}

function waterWaveFeature(point, radiusM, id) {
  const coordinates = []
  const pointCount = 48
  for (let index = 0; index <= pointCount; index++) {
    const angle = (index / pointCount) * Math.PI * 2
    const coordinate = offsetMeters(point, Math.cos(angle) * radiusM, Math.sin(angle) * radiusM)
    coordinates.push([coordinate.longitude, coordinate.latitude])
  }
  return {
    type: 'Feature',
    id,
    geometry: { type: 'LineString', coordinates },
  }
}

/** Gentle breathing of the water opacity, so the surface never looks frozen. */
function setWaterShimmer(map, shimmer) {
  for (const layer of WATER_LAYER_OPACITY) {
    if (map.getLayer(layer.id)) {
      map.setPaintProperty(layer.id, 'fill-opacity', Math.min(1, layer.opacity * shimmer))
    }
  }
}

function buildFloodSurface(center, surfaceElevation, elevations) {
  const centerIndex = GRID_HALF * GRID_SIDE + GRID_HALF
  const centerElevation = elevations[centerIndex]
  if (!Number.isFinite(centerElevation) || centerElevation > surfaceElevation) {
    return {
      collection: EMPTY_FEATURE_COLLECTION,
      wetCells: EMPTY_WET_CELLS,
      wetCellCount: 0,
    }
  }

  const wet = new Uint8Array(elevations.length)
  const queue = new Int32Array(elevations.length)
  let head = 0
  let tail = 0
  queue[tail++] = centerIndex
  wet[centerIndex] = 1

  while (head < tail) {
    const index = queue[head++]
    const row = Math.floor(index / GRID_SIDE)
    const column = index % GRID_SIDE
    const neighbors = [
      row > 0 ? index - GRID_SIDE : -1,
      row < GRID_SIDE - 1 ? index + GRID_SIDE : -1,
      column > 0 ? index - 1 : -1,
      column < GRID_SIDE - 1 ? index + 1 : -1,
    ]

    for (const neighbor of neighbors) {
      if (neighbor < 0 || wet[neighbor] || !Number.isFinite(elevations[neighbor])
        || elevations[neighbor] > surfaceElevation) continue
      const neighborRow = Math.floor(neighbor / GRID_SIDE)
      const neighborColumn = neighbor % GRID_SIDE
      const east = (neighborColumn - GRID_HALF) * GRID_SPACING_M
      const north = (GRID_HALF - neighborRow) * GRID_SPACING_M
      if (east * east + north * north > FLOOD_MODEL_RADIUS_M ** 2) continue
      wet[neighbor] = 1
      queue[tail++] = neighbor
    }
  }

  const features = []
  const addDepthContour = (minDepthM, maxDepthM, depthBand, waterColor) => {
    const bandCells = new Uint8Array(elevations.length)
    let bandCellCount = 0
    for (let index = 0; index < wet.length; index++) {
      if (!wet[index]) continue
      const depthM = surfaceElevation - elevations[index]
      if (depthM < minDepthM || depthM >= maxDepthM) continue
      bandCells[index] = 1
      bandCellCount++
    }
    if (!bandCellCount) return

    const geometry = mergeFloodCells(center, bandCells, bandCellCount)
    if (!geometry) return
    features.push({
      type: 'Feature',
      geometry,
      properties: { depthBand, waterColor },
    })
  }

  addDepthContour(0, Infinity, 'shore', '#EAF6FF')
  addDepthContour(0, 0.25, 'surface', '#A9D7F2')
  addDepthContour(0.25, 0.65, 'mid', '#68B2E0')
  addDepthContour(0.65, 1.5, 'deep', '#347FAA')
  addDepthContour(1.5, Infinity, 'core', '#174D79')

  if (!features.length) {
    return {
      collection: EMPTY_FEATURE_COLLECTION,
      wetCells: EMPTY_WET_CELLS,
      wetCellCount: tail,
    }
  }
  return {
    collection: { type: 'FeatureCollection', features },
    wetCells: wet,
    wetCellCount: tail,
  }
}

const DRY_HEIGHT_STOPS = [
  [0, '#F2D8A5'],
  [4, '#EBC98A'],
  [8, '#E0B876'],
  [14, '#D5A866'],
  [24, '#C99A58'],
].map(([stop, hex]) => [stop, hexToRgb(hex)])

const WET_DEPTH_STOPS = [
  [0, '#91CCF0'],
  [0.5, '#68AEDD'],
  [1.5, '#397FAF'],
  [3, '#194D78'],
].map(([stop, hex]) => [stop, hexToRgb(hex)])

function rampRgb(stops, value) {
  if (value <= stops[0][0]) return stops[0][1]
  for (let index = 0; index < stops.length - 1; index++) {
    const [from, fromRgb] = stops[index]
    const [to, toRgb] = stops[index + 1]
    if (value <= to) return mixRgb(fromRgb, toRgb, (value - from) / (to - from))
  }
  return stops[stops.length - 1][1]
}

function buildingBaseRgb(heightM) {
  return rampRgb(DRY_HEIGHT_STOPS, heightM)
}

/** Keep dry buildings warm, then blend continuously into flood blue with depth. */
function shadeBuildingRgb(color, daylight) {
  return mixRgb(NIGHT_BUILDING_COLOR, color, clamp(daylight, 0, 1))
}

function wetBuildingColor(baseRgb, depthM, daylight = 1) {
  const color = depthM <= 0.002
    ? baseRgb
    : mixRgb(baseRgb, rampRgb(WET_DEPTH_STOPS, depthM), smoothstep(0, 0.12, depthM))
  return rgbToHex(shadeBuildingRgb(color, daylight))
}

function statusLabel(status) {
  return status ? `${status[0]}${status.slice(1).toLowerCase()}` : 'Unknown'
}

function mergeFloodCells(center, wetCells, wetCellCount) {
  const edges = new Map()
  const vertexKey = (x, y) => `${x},${y}`
  const edgeKey = (from, to) => `${from}>${to}`

  const addEdge = (from, to) => {
    const key = edgeKey(from, to)
    const reverse = edgeKey(to, from)
    if (edges.has(reverse)) edges.delete(reverse)
    else edges.set(key, { key, from, to })
  }

  for (let index = 0; index < wetCells.length; index++) {
    if (!wetCells[index]) continue
    const row = Math.floor(index / GRID_SIDE)
    const column = index % GRID_SIDE
    const northWest = vertexKey(column, row)
    const northEast = vertexKey(column + 1, row)
    const southEast = vertexKey(column + 1, row + 1)
    const southWest = vertexKey(column, row + 1)
    addEdge(southWest, southEast)
    addEdge(southEast, northEast)
    addEdge(northEast, northWest)
    addEdge(northWest, southWest)
  }

  const outgoing = new Map()
  for (const edge of edges.values()) {
    const starts = outgoing.get(edge.from) ?? []
    starts.push(edge)
    outgoing.set(edge.from, starts)
  }

  const toCoordinate = key => {
    const [x, y] = key.split(',').map(Number)
    const point = offsetMeters(
      center,
      (x - GRID_HALF - 0.5) * GRID_SPACING_M,
      (GRID_HALF + 0.5 - y) * GRID_SPACING_M,
    )
    return [point.longitude, point.latitude]
  }
  const rings = []
  const edgeHeading = edge => {
    const [fromX, fromY] = edge.from.split(',').map(Number)
    const [toX, toY] = edge.to.split(',').map(Number)
    return Math.atan2(fromY - toY, toX - fromX)
  }
  const nextBoundaryEdge = (incoming, candidates) => {
    const incomingHeading = edgeHeading(incoming)
    return candidates.reduce((selected, candidate) => {
      const turn = (edgeHeading(candidate) - incomingHeading + Math.PI * 2) % (Math.PI * 2)
      return !selected || turn < selected.turn ? { edge: candidate, turn } : selected
    }, null)?.edge
  }

  while (edges.size) {
    const first = edges.values().next().value
    const ringKeys = [first.from]
    let current = first
    edges.delete(current.key)

    for (let step = 0; step <= wetCellCount * 4; step++) {
      ringKeys.push(current.to)
      if (current.to === first.from) break
      const candidates = outgoing.get(current.to)?.filter(edge => edges.has(edge.key)) ?? []
      const next = nextBoundaryEdge(current, candidates)
      if (!next) break
      current = next
      edges.delete(current.key)
    }

    if (ringKeys.length >= 4 && ringKeys[ringKeys.length - 1] === first.from) {
      rings.push(ringKeys.map(toCoordinate))
    }
  }

  const smoothRing = ring => {
    let points = ring.slice(0, -1)
    for (let iteration = 0; iteration < 2; iteration++) {
      const smoothed = []
      for (let index = 0; index < points.length; index++) {
        const point = points[index]
        const next = points[(index + 1) % points.length]
        smoothed.push([
          point[0] * 0.75 + next[0] * 0.25,
          point[1] * 0.75 + next[1] * 0.25,
        ], [
          point[0] * 0.25 + next[0] * 0.75,
          point[1] * 0.25 + next[1] * 0.75,
        ])
      }
      points = smoothed
    }
    return [...points, points[0]]
  }
  const smoothedRings = rings.map(smoothRing)

  const signedArea = ring => ring.slice(0, -1).reduce((area, point, index, points) => {
    const next = points[(index + 1) % points.length]
    return area + point[0] * next[1] - next[0] * point[1]
  }, 0) / 2
  const outerRings = smoothedRings.filter(ring => signedArea(ring) > 0)
  const holeRings = smoothedRings.filter(ring => signedArea(ring) < 0)
  const polygons = outerRings.map(ring => [ring])

  for (const hole of holeRings) {
    const [longitude, latitude] = hole[0]
    const owner = outerRings.findIndex(ring => {
      let inside = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        const crosses = (yi > latitude) !== (yj > latitude)
          && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi
        if (crosses) inside = !inside
      }
      return inside
    })
    if (owner >= 0) polygons[owner].push(hole)
  }

  if (!polygons.length) return null
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons }
}

/* ------------------------------------------------------------------ controller */

const OLD_LAYER_IDS = [
  'flood-water-surface', 'flood-water-mid', 'flood-water-deep', 'flood-water-core',
  'flood-water-foam', 'flood-wave-fronts', 'flooded-buildings', 'flooded-building-outlines',
]
const OLD_SOURCE_IDS = ['flood-water', 'flood-waves', 'flooded-buildings']

/**
 * @param {maplibregl.Map} map   a map whose style is already loaded
 * @param {object} options
 * @param {{longitude:number, latitude:number}} options.center  sensor position
 * @param {string}  [options.beforeLayerId='building']  water goes under this layer
 * @param {string}  [options.buildingsAboveLayerId='label-place']  colored buildings go under this layer (or null = top)
 * @param {string}  [options.buildingSource='ofm']       vector source holding the buildings
 * @param {string}  [options.buildingSourceLayer='building']
 * @param {string[]} [options.hideLayers=['building','building-outlines']]  base building layers hidden while flooded
 * @param {string}  [options.basemapLayerId='openstreetmap-base']
 * @param {(center)=>Promise<Float32Array>} [options.demSampler]  must return GRID_SIDE*GRID_SIDE meters
 * @param {boolean} [options.reduceMotion]
 * @param {(stats)=>void} [options.onStats]  { wetCells, affectedBuildings, level, loading, error }
 */
export function createFloodWater(map, options = {}) {
  const opts = {
    beforeLayerId: 'building',
    buildingsAboveLayerId: 'label-place',
    buildingSource: 'ofm',
    buildingSourceLayer: 'building',
    hideLayers: ['building', 'building-outlines'],
    basemapLayerId: 'openstreetmap-base',
    demSampler: sampleTerrainGrid,
    reduceMotion: false,
    ...options,
  }
  let center = { ...opts.center }
  let lightingHour = localHour()
  let daylight = 1
  let destroyed = false
  let target = null
  let shown = null
  let terrain = null
  let loadingKey = ''
  let generation = 0
  let scenario = null
  let buildings = []
  let overlayActive = false
  let forceRebuild = false
  let refreshPending = false
  let lastBuildAt = 0
  let lastBuildingAt = 0
  let lastFxAt = 0
  let lastStatsAt = 0
  let rafId = 0
  let lastFrame = 0
  let active = false
  let builtLevel = null
  let builtTerrainKey = null
  let reported = ''
  const shownDepth = new Map()
  const baseBuildingOpacities = new Map()
  const stats = { wetCells: 0, affectedBuildings: 0, level: null, loading: false, error: null }
  const before = id => (id && map.getLayer(id) ? id : undefined)
  const updateShadowsOnZoom = () => updateBuildingShadow(map, solarPosition(lightingHour, center), center)
  map.on('zoom', updateShadowsOnZoom)

  // Remove any older flood layers (for example a previous knockoff) so only this water draws
  for (const id of OLD_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id)
  for (const id of OLD_SOURCE_IDS) if (map.getSource(id)) map.removeSource(id)

  map.addSource('flood-water', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION })
  map.addSource('flood-waves', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION })
  map.addSource('flooded-buildings', { type: 'geojson', data: EMPTY_FEATURE_COLLECTION })
  for (const layer of WATER_LAYER_OPACITY) {
    map.addLayer({
      id: layer.id,
      type: 'fill',
      source: 'flood-water',
      filter: ['==', ['get', 'depthBand'], layer.depthBand],
      paint: { 'fill-color': ['get', 'waterColor'], 'fill-opacity': 0, 'fill-opacity-transition': { duration: 0 } },
    }, before(opts.beforeLayerId))
  }
  map.addLayer({
    id: 'flood-water-foam',
    type: 'line',
    source: 'flood-water',
    filter: ['==', ['get', 'depthBand'], 'shore'],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#EAF6FF', 'line-width': 2, 'line-opacity': 0.85, 'line-blur': 0.5,
      'line-width-transition': { duration: 0 }, 'line-opacity-transition': { duration: 0 },
    },
  }, before(opts.beforeLayerId))
  map.addLayer({
    id: 'flood-wave-fronts',
    type: 'line',
    source: 'flood-waves',
    paint: {
      'line-color': '#CFE6FF', 'line-width': 1.5,
      'line-opacity': ['coalesce', ['feature-state', 'o'], 0],
      'line-opacity-transition': { duration: 0 },
    },
  }, before(opts.beforeLayerId))
  map.addLayer({
    id: 'flooded-buildings',
    type: 'fill-extrusion',
    source: 'flooded-buildings',
    paint: {
      'fill-extrusion-color': ['to-color', ['coalesce', ['feature-state', 'color'], ['get', 'baseColor']]],
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-base': ['get', 'base'],
      'fill-extrusion-opacity': 1,
      'fill-extrusion-vertical-gradient': false,
    },
  }, before(opts.buildingsAboveLayerId))
  map.addLayer({
    id: 'flooded-building-outlines',
    type: 'line',
    source: 'flooded-buildings',
    layout: {
      'line-join': 'round',
      'line-cap': 'round',
    },
    paint: {
      'line-color': '#30251E',
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 18, 4, 20, 5],
      'line-opacity': 1,
    },
  }, before(opts.buildingsAboveLayerId))
  function emit(force) {
    const key = `${stats.wetCells}|${stats.affectedBuildings}|${stats.loading}|${stats.error}|${stats.level == null ? '' : stats.level.toFixed(2)}`
    if (!force && key === reported) return
    reported = key
    opts.onStats?.({ ...stats })
  }

  function setBaseBuildingVisibility(visible) {
    for (const id of opts.hideLayers) {
      const layer = map.getLayer(id)
      if (!layer) continue
      const property = layer.type === 'line' ? 'line-opacity'
        : layer.type === 'fill-extrusion' ? 'fill-extrusion-opacity'
          : null
      if (!property) continue

      let original = baseBuildingOpacities.get(id)
      if (!original) {
        const opacity = map.getPaintProperty(id, property)
        if (opacity === undefined) continue
        original = { property, opacity }
        baseBuildingOpacities.set(id, original)
      }
      map.setPaintProperty(id, original.property, visible ? original.opacity : 0)
    }
  }

  function setFloodOpacity(progress) {
    for (const layer of WATER_LAYER_OPACITY) {
      if (map.getLayer(layer.id)) map.setPaintProperty(layer.id, 'fill-opacity', layer.opacity * progress)
    }
  }

  function clearLayers() {
    map.getSource('flood-water')?.setData(EMPTY_FEATURE_COLLECTION)
    map.getSource('flood-waves')?.setData(EMPTY_FEATURE_COLLECTION)
    map.getSource('flooded-buildings')?.setData(EMPTY_FEATURE_COLLECTION)
    setBaseBuildingVisibility(true)
    setFloodOpacity(0)
  }

  function updateWaves() {
    const source = map.getSource('flood-waves')
    if (!source || !scenario?.wetCellCount) { source?.setData(EMPTY_FEATURE_COLLECTION); return }
    source.setData({
      type: 'FeatureCollection',
      features: [1.5, 2.6, 3.7].map((factor, id) => waterWaveFeature(scenario.center, GRID_SPACING_M * factor, id)),
    })
  }

  function pushOverlay() {
    const live = scenario?.wetCellCount ? scenario : null
    setBaseBuildingVisibility(!live)
    const source = map.getSource('flooded-buildings')
    if (!live || !buildings.length) {
      overlayActive = false
      source?.setData(EMPTY_FEATURE_COLLECTION)
      stats.affectedBuildings = 0
      emit()
      return
    }
    const features = []
    for (const building of buildings) {
      const baseColor = rgbToHex(shadeBuildingRgb(building.baseRgb, daylight))
      for (const part of building.parts) {
        part.color = null
        features.push({
          type: 'Feature',
          id: part.fid,
          geometry: { type: 'Polygon', coordinates: part.polygon },
          properties: { height: building.height, base: building.base, baseColor },
        })
      }
    }
    map.removeFeatureState({ source: 'flooded-buildings' })
    source?.setData({ type: 'FeatureCollection', features })
    overlayActive = true
  }

  function refreshBuildings() {
    if (destroyed) return
    const bounds = map.getBounds()
    const rendered = map.querySourceFeatures(opts.buildingSource, { sourceLayer: opts.buildingSourceLayer })
      .filter(b => b.geometry && geometryIntersectsBounds(b.geometry, bounds))
    if (shownDepth.size > 5000) shownDepth.clear()
    for (const b of buildings) for (const part of b.parts) shownDepth.set(part.key, part.shown)

    const seen = new Set()
    const next = []
    let nextId = 0
    for (const b of rendered) {
      const geometry = b.geometry
      if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) continue
      const c = geometryCenter(geometry)
      if (!c) continue
      const identity = b.id ?? `${c.longitude.toFixed(5)},${c.latitude.toFixed(5)}`
      if (seen.has(identity)) continue
      if (seen.size >= MAX_BUILDINGS_TO_SAMPLE) break
      seen.add(identity)
      const props = b.properties ?? {}
      const height = Math.max(3.2, Number(props.render_height) || Number(props.height)
        || Number(props['building:levels'] || 1) * 3.2)
      const base = Number(props.render_min_height) || 0
      const parts = geometryPolygons(geometry).map((polygon, polygonIndex) => {
        const samples = []
        if (terrain) {
          for (const point of geometrySamplePoints({ type: 'Polygon', coordinates: polygon })) {
            const off = metersFrom(terrain.center, point)
            const column = Math.round(off.east / GRID_SPACING_M) + GRID_HALF
            const row = GRID_HALF - Math.round(off.north / GRID_SPACING_M)
            if (row < 0 || row >= GRID_SIDE || column < 0 || column >= GRID_SIDE) continue
            const idx = row * GRID_SIDE + column
            if (Number.isFinite(terrain.floodElevations[idx])) samples.push(idx)
          }
        }
        const key = `${identity}:${polygonIndex}`
        return { fid: nextId++, key, polygon, samples: Int32Array.from(samples), shown: shownDepth.get(key) ?? 0, color: null }
      })
      next.push({ identity, height, base, baseRgb: buildingBaseRgb(height), parts })
    }
    buildings = next
    pushOverlay()
  }

  function scheduleRefresh() {
    if (refreshPending || destroyed) return
    refreshPending = true
    map.once('idle', () => { refreshPending = false; refreshBuildings() })
  }

  const onSourceData = e => { if (e.sourceId === opts.buildingSource) scheduleRefresh() }
  map.on('moveend', scheduleRefresh)
  map.on('sourcedata', onSourceData)

  async function ensureTerrain() {
    if (target == null || target <= FLOOD_ONSET_M) return
    const key = `${center.longitude.toFixed(5)}:${center.latitude.toFixed(5)}`
    if (terrain?.key === key || loadingKey === key) return
    loadingKey = key
    const gen = ++generation
    stats.loading = true
    emit()
    try {
      const elevations = await opts.demSampler({ ...center })
      if (destroyed || gen !== generation) return
      const centerElevation = elevations[GRID_HALF * GRID_SIDE + GRID_HALF]
      if (!Number.isFinite(centerElevation)) throw new Error('The DEM has no elevation at the sensor location')
      terrain = { key, center: { ...center }, elevations, floodElevations: smoothTerrainGrid(elevations), centerElevation }
      forceRebuild = true
      stats.error = null
      scheduleRefresh()
    } catch (err) {
      if (gen !== generation) return
      clearLayers()
      scenario = null
      overlayActive = false
      active = false
      stats.wetCells = 0
      stats.affectedBuildings = 0
      stats.error = err instanceof Error ? err.message : String(err)
    } finally {
      if (loadingKey === key) loadingKey = ''
      if (gen === generation) { stats.loading = false; emit() }
    }
  }

  /** One animation step. Exposed as flood.step(nowMs, dtSeconds) so tests can drive it. */
  function step(now, dt) {
    if (destroyed) return
    if (target == null) shown = null
    else if (shown == null) shown = target
    else {
      const diff = target - shown
      shown = Math.abs(diff) < 0.0015 ? target : shown + diff * (1 - Math.exp(-dt * 2.4))
    }
    stats.level = shown
    const stage = shown == null ? 0 : Math.max(0, shown - FLOOD_ONSET_M)
    const settled = shown === target
    let affectedNow = stats.affectedBuildings

    if (stage <= 0) {
      if (active) {
        active = false
        builtLevel = null
        scenario = null
        overlayActive = false
        clearLayers()
        affectedNow = 0
        stats.wetCells = 0
      }
    } else if (terrain) {
      const terrainChanged = builtTerrainKey !== terrain.key
      const moved = builtLevel == null || Math.abs(shown - builtLevel) > 0.004
      if ((moved || terrainChanged || forceRebuild) && (now - lastBuildAt > 80 || settled || !active)) {
        lastBuildAt = now
        forceRebuild = false
        const surfaceElevation = terrain.centerElevation + stage
        const { collection, wetCells, wetCellCount } = buildFloodSurface(terrain.center, surfaceElevation, terrain.floodElevations)
        const wasActive = active
        scenario = { center: terrain.center, level: shown, surfaceElevation, wetCells, wetCellCount, elevations: terrain.floodElevations }
        map.getSource('flood-water').setData(collection)
        builtLevel = shown
        builtTerrainKey = terrain.key
        active = wetCellCount > 0
        stats.wetCells = wetCellCount
        if (active && (!wasActive || terrainChanged)) {
          setFloodOpacity(1)
          updateWaves()
          pushOverlay()
          scheduleRefresh()
        }
        if (!active) {
          affectedNow = 0
          if (wasActive) pushOverlay()
        }
      }
    }

    if (overlayActive && scenario?.wetCellCount && now - lastBuildingAt > 32) {
      const ease = 1 - Math.exp(-Math.min(0.1, (now - lastBuildingAt) / 1000) * 4)
      lastBuildingAt = now
      let affected = 0
      for (const building of buildings) {
        let touched = false
        for (const part of building.parts) {
          let total = 0
          let wet = 0
          for (let s = 0; s < part.samples.length; s++) {
            const idx = part.samples[s]
            if (!scenario.wetCells[idx]) continue
            total += Math.max(0, scenario.surfaceElevation - scenario.elevations[idx])
            wet++
          }
          const targetDepth = part.samples.length ? total / part.samples.length : 0
          const diff = targetDepth - part.shown
          part.shown = Math.abs(diff) < 0.0008 ? targetDepth : part.shown + diff * ease
          if (wet) touched = true
          const color = wetBuildingColor(building.baseRgb, part.shown, daylight)
          if (color !== part.color) {
            map.setFeatureState({ source: 'flooded-buildings', id: part.fid }, { color })
            part.color = color
          }
        }
        if (touched) affected++
      }
      affectedNow = affected
    }

    if (!opts.reduceMotion && active && now - lastFxAt > 90) {
      lastFxAt = now
      const t = now / 1000
      setWaterShimmer(map, 1 + 0.05 * Math.sin(t * 1.4))
      if (map.getLayer('flood-water-foam')) {
        map.setPaintProperty('flood-water-foam', 'line-opacity', 0.7 + 0.2 * Math.sin(t * 2.1))
        map.setPaintProperty('flood-water-foam', 'line-width', 1.8 + 0.8 * (0.5 + 0.5 * Math.sin(t * 1.7)))
      }
      for (let id = 0; id < 3; id++) {
        const phase = (((t * 0.5 - id / 3) % 1) + 1) % 1
        map.setFeatureState({ source: 'flood-waves', id }, { o: 0.5 * Math.sin(phase * Math.PI) })
      }
    }

    stats.affectedBuildings = affectedNow
    if (now - lastStatsAt > 250) { lastStatsAt = now; emit() }
  }

  function frame(time) {
    if (destroyed) return
    const dt = lastFrame ? Math.min(0.1, (time - lastFrame) / 1000) : 0.016
    lastFrame = time
    step(time, dt)
    rafId = requestAnimationFrame(frame)
  }
  if (typeof requestAnimationFrame === 'function' && options.autoStart !== false) {
    rafId = requestAnimationFrame(frame)
  }

  return {
    /** Water level in meters. The water eases toward it on its own. Pass null to clear. */
    setLevel(levelM) {
      target = Number.isFinite(levelM) ? clamp(levelM, 0, CHANNEL_M) : null
      ensureTerrain()
    },
    /** Move the sensor. The DEM is sampled again at the new place. */
    setCenter(next) {
      center = { longitude: next.longitude, latitude: next.latitude }
      ensureTerrain()
    },
    /** Sky, solar light and terrain shadows for a local hour (0-24). */
    setHour(hour, weather) {
      lightingHour = hour
      daylight = Math.sin(Math.max(0, solarPosition(hour, center).elevation) * Math.PI / 180)
      return applyLighting(map, hour, weather, center)
    },
    step,
    getStats: () => ({ ...stats }),
    destroy() {
      destroyed = true
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
      map.off('moveend', scheduleRefresh)
      map.off('sourcedata', onSourceData)
      map.off('zoom', updateShadowsOnZoom)
      try {
        clearLayers()
        for (const id of OLD_LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id)
        for (const id of OLD_SOURCE_IDS) if (map.getSource(id)) map.removeSource(id)
      } catch { /* map already removed */ }
    },
  }
}

export { GRID_SIDE, GRID_HALF, GRID_SPACING_M, FLOOD_ONSET_M, CHANNEL_M, lightingForHour, solarPosition, buildingShadowForSun, wetBuildingColor, buildingBaseRgb, distanceBetweenCoordinates, applyLighting }
