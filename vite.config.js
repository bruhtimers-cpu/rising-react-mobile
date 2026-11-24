import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/leaflet'))      return 'leaflet'
          if (id.includes('node_modules/react-dom'))    return 'react-dom'
          if (id.includes('node_modules/react/'))       return 'react'
        },
      },
    },

    // Minify with esbuild (default, fast)
    minify: 'esbuild',

    // Enable source maps for easier debugging
    sourcemap: false,

    // Target modern browsers — smaller output
    target: ['chrome90', 'firefox90', 'safari14'],
  },
})
