import { useState, useEffect } from 'react'

const THEME_STORAGE_KEY = 'rising-theme-v2'

export function useDarkMode() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    if (saved) return saved === 'dark'
    return false
  })

  useEffect(() => {
    // Use data-theme="light" / no attribute (dark) pattern
    if (dark) {
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', 'light')
    }
    localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light')
  }, [dark])

  function toggle() { setDark(d => !d) }
  return { dark, toggle }
}
