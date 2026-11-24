// Polls /api/sensor every 3 seconds.
//
// LD2413 firmware sends DIST already in METRES (rawCm / 100.0).
// Sensor is mounted ABOVE the channel pointing DOWN at the water.
//
//   waterLevelM = sensorHeightM - DIST
//
// sensorHeightM is calibrated server-side (POST /api/calibrate?auto=true).
// Channel depth = 12.60 m, 4 equal levels of 3.15 m each.

import { useState, useEffect, useRef } from 'react'

const CHANNEL_M = 12.60
const L1_M = 3.15
const L2_M = 6.30
const L3_M = 9.45
const HISTORY_KEY = 'rising.water-level-history.v1'
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
const HISTORY_SAMPLE_MS = 30 * 1000

function readStoredHistory() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]')
    if (!Array.isArray(stored)) return []
    const cutoff = Date.now() - HISTORY_WINDOW_MS
    return stored.filter(point => Number.isFinite(point?.timestamp)
      && Number.isFinite(point?.waterLevelM)
      && point.timestamp >= cutoff
      && point.waterLevelM >= 0
      && point.waterLevelM <= CHANNEL_M)
  } catch (error) {
    console.warn('[sensor] unable to load stored water history:', error.message)
    return []
  }
}

function deriveFloodStatus(levelM) {
  if (levelM == null) return { status: 'UNKNOWN',   activeLevel: -1 }
  if (levelM >= L3_M) return { status: 'DANGEROUS', activeLevel:  3 }
  if (levelM >= L2_M) return { status: 'CRITICAL',  activeLevel:  2 }
  if (levelM >= L1_M) return { status: 'MODERATE',  activeLevel:  1 }
  return               { status: 'SAFE',       activeLevel:  0 }
}

function levelToVisualPct(levelM) {
  if (levelM == null || levelM <= 0) return 0
  return Math.min(100, Math.max(0, (levelM / CHANNEL_M) * 100))
}

export function useSensor() {
  const [sensor,  setSensor]  = useState(null)
  const [history, setHistory] = useState(readStoredHistory)
  const historyRef = useRef(history)
  const [online,  setOnline]  = useState(false)
  const [error,   setError]   = useState(null)
  const [latency, setLatency] = useState(null)   // ms, null = no reading yet
  const [lastUpdated, setLastUpdated] = useState(null)

  // sensorHeightM comes from server (persisted calibration)
  // Fall back to 14.75 if not yet received
  const sensorHeightRef = useRef(14.75)

  async function poll() {
    try {
      const t0 = performance.now()
      const r = await fetch('/api/sensor')
      const t1 = performance.now()
      setLatency(Math.round(t1 - t0))
      if (!r.ok) throw new Error(`status ${r.status}`)
      const d = await r.json()
      if (d.error) throw new Error(d.error)

      // Use server-provided calibration value if present
      if (d.sensorHeightM != null) sensorHeightRef.current = d.sensorHeightM

      const distM  = d.distance != null ? d.distance : null
      const levelM = distM != null
        ? Math.max(0, Math.min(CHANNEL_M, sensorHeightRef.current - distM))
        : null

      const { status: floodStatus, activeLevel } = deriveFloodStatus(levelM)
      const sampleTime = Date.now() - (Number.isFinite(d.ageMs) ? d.ageMs : 0)
      const isFresh = d.stale !== true && (!Number.isFinite(d.ageMs) || d.ageMs <= 30000)

      setSensor({
        ...d,
        _isStale: !isFresh,
        waterLevelM:   levelM,
        waterLevelPct: levelToVisualPct(levelM),
        floodStatus,
        activeLevel,
        channelM:      CHANNEL_M,
        sensorHeightM: sensorHeightRef.current,
        thresholds:    { l1: L1_M, l2: L2_M, l3: L3_M },
      })
      setOnline(isFresh)
      setError(null)
      if (isFresh) setLastUpdated(sampleTime)

      if (isFresh && levelM != null) {
        const last = historyRef.current[historyRef.current.length - 1]
        if (!last || sampleTime - last.timestamp >= HISTORY_SAMPLE_MS) {
          const cutoff = sampleTime - HISTORY_WINDOW_MS
          const next = [...historyRef.current.filter(point => point.timestamp >= cutoff), {
            timestamp: sampleTime,
            waterLevelM: levelM,
          }]
          historyRef.current = next
          setHistory(next)
          try {
            window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
          } catch (error) {
            console.warn('[sensor] unable to persist water history:', error.message)
          }
        }
      }
    } catch (e) {
      setOnline(false)
      setError(e.message)
    }
  }

  // Calibration helper — POST /api/calibrate with { auto: true }
  async function calibrate() {
    const r = await fetch('/api/calibrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: true }),
    })
    const data = await r.json()
    if (data.calibration?.sensorHeightM) {
      sensorHeightRef.current = data.calibration.sensorHeightM
    }
    return data
  }

  useEffect(() => {
    poll()
    const t = setInterval(poll, 3000)
    return () => clearInterval(t)
  }, [])

  return { sensor, history, online, error, latency, lastUpdated, calibrate }
}
