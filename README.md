# R.I.S.I.N.G Flood Monitoring

Flood and weather monitoring dashboard for Naga City.

## Run

```powershell
npm install
npm run build
npm start
```

Copy `.env.example` to `.env` and set `OPENWEATHER_API_KEY` and `ESP32_URL` for live weather and sensor data. The server listens on `127.0.0.1:8000` by default.

For frontend development, run `npm run dev` in a second terminal. The Vite dev server proxies API requests to the local Express server.

The app automatically shows the 3D terrain dashboard on desktop and a lightweight dashboard with the evacuation map on phone-sized screens. The evacuation map uses the Express Overpass proxy. GitHub Pages cannot run the APIs; deploy the Node server on Railway to keep live features working. Railway sets `PORT` and `RAILWAY_ENVIRONMENT`; the server binds to `0.0.0.0` only there and keeps the OpenWeather key server-side.

Set `OPENWEATHER_API_KEY` and `ESP32_URL` in Railway's Variables. A Railway service cannot reach a sensor at a private LAN address; use a secured, reachable tunnel or VPN endpoint for `ESP32_URL`. Hosted mode rate-limits weather and map-proxy requests and disables the calibration write and shared phone-location relay endpoints. The evacuation map requests location directly from the user's browser over HTTPS.

`.env`, TLS files, and `calibration.json` are local-only and ignored by Git; publish `.env.example` instead.

## Project layout

- `src/components/` — dashboard, map, weather, and UI components
- `src/hooks/` — sensor, weather, and theme state
- `src/config/`, `src/layers/`, `src/utils/` — supporting configuration and rendering code
- `public/` — static images, icons, and map data
- `docs/` — design and implementation notes

Local `.env`, TLS key/certificate, and sensor calibration files stay in the project root.
