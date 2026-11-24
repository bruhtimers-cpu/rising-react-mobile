import { useEffect, useRef, useState } from 'react'
import styles from './FloodAlert.module.css'

const ALERT_LEVELS = {
  CRITICAL:  { label: 'CRITICAL FLOOD ALERT',  sub: 'Water level has reached critical height. Prepare for evacuation.' },
  DANGEROUS: { label: 'DANGEROUS FLOOD ALERT', sub: 'Water level is dangerously high. Evacuate immediately.' },
}

// Synthesise a siren using Web Audio API — no audio files needed
function playSiren(status) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const duration = status === 'DANGEROUS' ? 3.0 : 2.0
    const count    = status === 'DANGEROUS' ? 3    : 2

    for (let i = 0; i < count; i++) {
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)

      const t0 = ctx.currentTime + i * (duration / count)
      const t1 = t0 + duration / count * 0.9

      // Sweep frequency up then down
      osc.frequency.setValueAtTime(440, t0)
      osc.frequency.linearRampToValueAtTime(880, t0 + (t1 - t0) / 2)
      osc.frequency.linearRampToValueAtTime(440, t1)

      gain.gain.setValueAtTime(0, t0)
      gain.gain.linearRampToValueAtTime(0.35, t0 + 0.05)
      gain.gain.linearRampToValueAtTime(0.35, t1 - 0.05)
      gain.gain.linearRampToValueAtTime(0, t1)

      osc.start(t0)
      osc.stop(t1)
    }
  } catch (e) {
    console.warn('[FloodAlert] audio failed:', e.message)
  }
}

export default function FloodAlert({ floodStatus, waterLevelM }) {
  const [dismissed, setDismissed] = useState(false)
  const [visible,   setVisible]   = useState(false)
  const prevStatus  = useRef(null)
  const repeatTimer = useRef(null)

  const isAlert = floodStatus === 'CRITICAL' || floodStatus === 'DANGEROUS'
  const cfg     = ALERT_LEVELS[floodStatus] ?? null

  // Trigger when status first enters alert range, or escalates
  useEffect(() => {
    const wasAlert = prevStatus.current === 'CRITICAL' || prevStatus.current === 'DANGEROUS'

    if (isAlert) {
      const escalated = floodStatus === 'DANGEROUS' && prevStatus.current === 'CRITICAL'
      if (!wasAlert || escalated) {
        // New alert or escalation — reset dismiss, play siren
        setDismissed(false)
        setVisible(true)
        playSiren(floodStatus)

        // Repeat siren every 30s while alert is active
        clearInterval(repeatTimer.current)
        repeatTimer.current = setInterval(() => {
          playSiren(floodStatus)
        }, 30000)
      }
    } else {
      // Cleared — hide banner
      setVisible(false)
      clearInterval(repeatTimer.current)
    }

    prevStatus.current = floodStatus
    return () => clearInterval(repeatTimer.current)
  }, [floodStatus, isAlert])

  function dismiss() {
    setDismissed(true)
    clearInterval(repeatTimer.current)
  }

  if (!visible || dismissed || !cfg) return null

  return (
    <div
      className={`${styles.banner} ${floodStatus === 'DANGEROUS' ? styles.dangerous : styles.critical}`}
      role="alert"
      aria-live="assertive"
    >
      <div className={styles.bannerInner}>
        {/* Siren icon */}
        <div className={styles.sirenIcon}>
          <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="20" cy="20" r="18" fill="currentColor" opacity="0.15"/>
            <circle cx="20" cy="20" r="12" fill="currentColor" opacity="0.25"/>
            <path d="M20 10 L23 18 H17 Z" fill="currentColor"/>
            <rect x="16" y="24" width="8" height="4" rx="2" fill="currentColor"/>
            <rect x="14" y="29" width="12" height="3" rx="1.5" fill="currentColor"/>
          </svg>
        </div>

        <div className={styles.bannerText}>
          <span className={styles.bannerLabel}>{cfg.label}</span>
          <span className={styles.bannerSub}>{cfg.sub}</span>
          {waterLevelM != null && (
            <span className={styles.bannerLevel}>
              Current level: <strong>{waterLevelM.toFixed(2)} m</strong>
            </span>
          )}
        </div>

        {/* Replay sound */}
        <button
          className={styles.replayBtn}
          onClick={() => playSiren(floodStatus)}
          title="Replay alert sound"
          aria-label="Replay alert sound"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
          </svg>
        </button>

        {/* Dismiss */}
        <button
          className={styles.dismissBtn}
          onClick={dismiss}
          title="Dismiss alert"
          aria-label="Dismiss alert"
        >
          ✕
        </button>
      </div>

      {/* Animated progress bar — resets every 30s to show next siren */}
      <div className={styles.timerBar} />
    </div>
  )
}
