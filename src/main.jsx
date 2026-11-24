import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  componentDidCatch(e, info) {
    if (import.meta.env.DEV) console.error('[app] render failed:', e, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div role="alert" style={{position:'fixed',inset:0,display:'grid',placeContent:'center',gap:12,background:'#101316',color:'#f7f8fa',fontFamily:'system-ui,sans-serif',padding:20,textAlign:'center',zIndex:99999}}>
          <p>The dashboard could not load.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )
    }
    return this.props.children
  }
}

const root = document.getElementById('root')
if (!root) {
  document.body.innerHTML = '<div style="color:red;padding:20px;font-size:20px">NO ROOT ELEMENT</div>'
} else {
  try {
    ReactDOM.createRoot(root).render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    )
  } catch(e) {
    if (import.meta.env.DEV) console.error('[app] failed to mount:', e)
    root.textContent = 'The dashboard could not start. Reload the page to try again.'
  }
}
