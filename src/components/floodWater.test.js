import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildingShadowForSun, distanceBetweenCoordinates, solarPosition, wetBuildingColor } from './floodWater.js'

test('solar position follows the real sun above and below the horizon in Naga', () => {
  const date = new Date(2026, 10, 24, 12)
  const location = { latitude: 13.6218, longitude: 123.1945 }
  const noon = solarPosition(12, location, date, -480)
  const night = solarPosition(23, location, date, -480)

  assert.ok(noon.elevation > 50)
  assert.ok(noon.azimuth > 160 && noon.azimuth < 210)
  assert.ok(night.elevation < -50)
  assert.ok(night.polar > 140)
})

test('building shadows follow daylight and disappear at night', () => {
  const noon = buildingShadowForSun({ azimuth: 180, elevation: 55 }, 13.6218, 19)
  const night = buildingShadowForSun({ azimuth: 180, elevation: -10 }, 13.6218, 19)

  assert.ok(noon.translate[1] < 0)
  assert.ok(noon.opacity > 0)
  assert.deepEqual(night, { translate: [0, 0], opacity: 0 })
})

test('dry and flooded building colors darken after sunset', () => {
  const dryDay = wetBuildingColor([242, 216, 165], 0, 1)
  const dryNight = wetBuildingColor([242, 216, 165], 0, 0)
  const wetDay = wetBuildingColor([242, 216, 165], 0.5, 1)
  const wetNight = wetBuildingColor([242, 216, 165], 0.5, 0)

  assert.notEqual(dryDay, dryNight)
  assert.notEqual(wetDay, wetNight)
  assert.equal(dryNight, '#5b554c')
  assert.equal(wetNight, '#5b554c')
})

test('sensor focus distance is measured locally around Naga', () => {
  const naga = { latitude: 13.6218, longitude: 123.1945 }
  const nearby = { latitude: 13.63, longitude: 123.2 }
  const farAway = { latitude: 14.0, longitude: 123.2 }

  assert.ok(distanceBetweenCoordinates(naga, nearby) < 1500)
  assert.ok(distanceBetweenCoordinates(naga, farAway) > 1500)
})
