/**
 * RainOverlay – canvas rain droplets drawn over the map.
 * Driven by weather: precipitationMm / cloudCover.
 * Adapts intensity to rain/storm/snow conditions.
 */
import { useEffect, useRef } from 'react'

const RN = 1400   // max droplets – same as the HTML demo

function seedRng(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

export default function RainOverlay({ weather, enabled = true }) {
  const canvasRef = useRef(null)
  const stateRef  = useRef(null)

  // Classify rain intensity 0..1 from weather object
  function rainAmount(w) {
    if (!w) return 0
    const precip  = Number(w.precipitation ?? w.precipitationMm ?? w.rain ?? 0)
    const cover   = Number(w.cloudCover ?? 0)
    const desc    = String(w.description ?? w.condition ?? '').toLowerCase()
    if (/thunder|storm/.test(desc) || precip > 5) return 1.0
    if (/heavy rain/.test(desc)    || precip > 2) return 0.85
    if (/rain|shower/.test(desc)   || precip > 0.5) return 0.6
    if (/drizzle/.test(desc)       || precip > 0.1) return 0.35
    if (cover > 80) return 0.15
    return 0
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rr = seedRng(21)
    const rx0 = new Float32Array(RN)
    const ry0 = new Float32Array(RN)
    const rz0 = new Float32Array(RN)   // z used for horizontal drift
    for (let q = 0; q < RN; q++) {
      rx0[q] = rr() * 1.0   // 0..1 fraction of canvas width
      ry0[q] = rr()          // 0..1 fraction of canvas height
      rz0[q] = (rr() - 0.5) * 0.0004  // tiny horizontal drift per frame
    }

    let raf = null
    let last = performance.now()

    stateRef.current = { rx0, ry0, rz0, rr }

    function draw(now) {
      raf = requestAnimationFrame(draw)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now

      const w   = canvas.width
      const h   = canvas.height
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, w, h)

      const amt  = rainAmount(weather)
      const vis  = Math.floor(RN * amt)
      if (vis === 0) return

      // drop length and speed scale with intensity
      const speed  = 0.28 + amt * 0.42   // fraction of height per second
      const dropH  = h * (0.012 + amt * 0.016)
      const slant  = w * 0.012            // slight horizontal slant

      ctx.strokeStyle = `rgba(180,210,255,${0.18 + amt * 0.32})`
      ctx.lineWidth   = 1
      ctx.beginPath()

      for (let d = 0; d < vis; d++) {
        ry0[d] += speed * dt
        rx0[d] += rz0[d] * dt * w * 60
        if (ry0[d] > 1) {
          ry0[d] = 0
          rx0[d] = rr()
          rz0[d] = (rr() - 0.5) * 0.0004
        }

        const px = rx0[d] * w
        const py = ry0[d] * h
        ctx.moveTo(px,          py)
        ctx.lineTo(px - slant,  py + dropH)
      }

      ctx.stroke()
    }

    raf = requestAnimationFrame(draw)
    return () => { if (raf) cancelAnimationFrame(raf) }
  }, [weather])  // restart loop when weather changes so amount re-evaluates

  // Keep canvas sized to parent
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const obs = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
    })
    obs.observe(canvas.parentElement)
    canvas.width  = canvas.offsetWidth
    canvas.height = canvas.offsetHeight
    return () => obs.disconnect()
  }, [])

  const amt = (() => {
    if (!weather) return 0
    const precip = Number(weather.precipitation ?? weather.precipitationMm ?? weather.rain ?? 0)
    const cover  = Number(weather.cloudCover ?? 0)
    const desc   = String(weather.description ?? weather.condition ?? '').toLowerCase()
    if (/thunder|storm/.test(desc) || precip > 5) return 1
    if (/rain|shower/.test(desc)   || precip > 0.1) return 0.5
    if (cover > 80) return 0.1
    return 0
  })()

  if (!enabled || amt === 0) return null

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 4,
      }}
    />
  )
}
