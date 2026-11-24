/** Light blue welcome screen with an animated transition into the dashboard. */
import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import styles from './SplashScreen.module.css'

const LETTERS = ['R','I','S','I','N','G']

export default function SplashScreen({ onEnter }) {
  const [exiting, setExiting] = useState(false)
  const entered = useRef(false)
  const enterTimeoutRef = useRef(null)
  const contentRef = useRef(null)
  const wordmarkRef = useRef(null)
  const hintRef = useRef(null)
  const firstPulseRef = useRef(null)
  const secondPulseRef = useRef(null)

  useEffect(() => {
    const fn = event => {
      if (event.key === 'Enter' || event.key === ' ') handleEnter()
    }
    document.addEventListener('keydown', fn)
    return () => {
      document.removeEventListener('keydown', fn)
      if (enterTimeoutRef.current) clearTimeout(enterTimeoutRef.current)
    }
  }, [onEnter])

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined
    const intro = gsap.timeline()
      .fromTo(contentRef.current,
        { autoAlpha: 0, y: 24 },
        { autoAlpha: 1, y: 0, duration: 0.7, ease: 'power3.out' })
      .fromTo(wordmarkRef.current.children,
        { autoAlpha: 0, y: 30, scaleX: 0.9 },
        { autoAlpha: 1, y: 0, scaleX: 1, duration: 0.72, stagger: 0.075, ease: 'back.out(1.4)' },
        '-=0.38')
      .fromTo(hintRef.current,
        { autoAlpha: 0, y: 12, scale: 0.96 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: 'power3.out' },
        '-=0.16')
    const pulses = [
      gsap.fromTo(firstPulseRef.current,
        { attr: { r: 28 }, autoAlpha: 0.62 },
        { attr: { r: 118 }, autoAlpha: 0, duration: 3.2, repeat: -1, ease: 'none' }),
      gsap.fromTo(secondPulseRef.current,
        { attr: { r: 28 }, autoAlpha: 0.5 },
        { attr: { r: 118 }, autoAlpha: 0, duration: 3.2, delay: 1.6, repeat: -1, ease: 'none' }),
    ]
    return () => {
      intro.kill()
      pulses.forEach(pulse => pulse.kill())
    }
  }, [])

  function handleEnter() {
    if (entered.current) return
    entered.current = true
    setExiting(true)
    enterTimeoutRef.current = setTimeout(onEnter, 600)
  }

  return (
    <div className={`${styles.root} ${exiting ? styles.exiting : ''}`}>
      <div className={styles.bg} />
      <svg className={styles.backgroundArt} viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <g className={styles.mapContours} fill="none" stroke="currentColor">
          <path d="M100 178c55-42 149-52 214-19 71 36 83 105 40 158-42 52-137 72-208 39-77-36-103-122-46-178Z" />
          <path d="M128 190c45-32 119-40 171-12 57 30 66 83 31 126-34 42-109 58-166 31-62-29-83-99-36-145Z" />
          <path d="M157 202c34-24 91-30 129-9 43 23 49 62 22 94-26 32-82 44-124 24-47-22-62-75-27-109Z" />
          <path d="M1080 605c46-37 117-43 165-15 52 30 61 88 25 131-36 44-106 54-159 26-59-31-77-101-31-142Z" />
          <path d="M1107 619c34-27 86-32 121-11 38 22 44 64 18 95-26 32-77 40-116 19-43-23-56-74-23-103Z" />
          <path d="M1133 633c22-17 55-20 77-7 24 14 28 40 11 60-16 20-49 25-74 12-28-15-36-47-14-65Z" />
        </g>
        <g className={styles.radar} fill="none" stroke="currentColor">
          <circle cx="1195" cy="675" r="118" className={styles.pulseRing} ref={firstPulseRef} />
          <circle cx="1195" cy="675" r="118" className={styles.pulseRing} ref={secondPulseRef} />
          <circle cx="1195" cy="675" r="38" />
          <circle cx="1195" cy="675" r="7" className={styles.radarDot} />
          <path d="M1195 615v120M1135 675h120" />
        </g>
        <g className={styles.mapNodes} fill="currentColor">
          <circle cx="262" cy="333" r="4" />
          <circle cx="322" cy="289" r="3" />
          <circle cx="1127" cy="300" r="4" />
          <circle cx="1206" cy="333" r="3" />
          <path d="M262 333 322 289M1127 300l79 33" fill="none" stroke="currentColor" />
        </g>
      </svg>
      <div className={styles.overlay} />

      <main className={styles.content} ref={contentRef}>
        <div className={styles.wordmark} aria-label="RISING" ref={wordmarkRef}>
          {LETTERS.map((l, i) => (
            <span key={i} className={styles.letter}>
              {l}
            </span>
          ))}
        </div>

        {/* Subtitle */}
        <p className={styles.subtitle}>
          Flood-level monitoring for Naga City
        </p>

        {/* Hint */}
        <button
          ref={hintRef}
          type="button"
          className={styles.hint}
          onClick={handleEnter}
        >
          Open monitoring dashboard
        </button>
      </main>
    </div>
  )
}
