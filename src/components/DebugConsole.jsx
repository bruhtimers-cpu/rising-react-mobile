import { useEffect, useRef } from 'react'
import styles from './DebugConsole.module.css'

export default function DebugConsole({ lines, visible }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])

  return (
    <div ref={ref} className={`${styles.debugConsole} ${visible ? styles.show : ''}`}>
      {lines.map(l => (
        <div key={l.id} className={`${styles.debugLine} ${styles[l.type] || ''}`}>
          &gt; {l.msg}
        </div>
      ))}
    </div>
  )
}
