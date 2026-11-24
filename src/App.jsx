import { useState, useEffect, useRef } from 'react'
import SplashScreen from './components/SplashScreen.jsx'
import MainApp from './components/MainApp.jsx'

export default function App() {
  const [entered, setEntered] = useState(false)

  return (
    <>
      {!entered && <SplashScreen onEnter={() => setEntered(true)} />}
      <MainApp visible={entered} />
    </>
  )
}
