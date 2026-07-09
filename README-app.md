# Repostaje Camper — app (PWA)

App real construida a partir del diseño de `design_handoff_repostaje_camper/`. Es una
**PWA** (un solo HTML + JS) instalable en Android/iPhone, que **funciona sin conexión**
mostrando los últimos precios guardados.

## Archivos
- `index.html` — estructura y estilos (tema día/noche, tokens del diseño).
- `app.js` — toda la lógica: datos reales, geolocalización, las 5 pantallas, detalle, sheets, mapa y rutas.
- `manifest.json` — instalación como app (nombre, iconos, color).
- `sw.js` — service worker: cachea la app para abrir **offline**.
- `icon-192/512/maskable.png`, `icon.svg` — iconos.

## Datos (reales, oficiales y gratis)
- **Precios:** Geoportal de Carburantes del Ministerio para la Transición Ecológica.
  - Por provincia (ligero): `…/EstacionesTerrestresFiltroProvincia/{idProvincia}`.
  - Nacional (fallback): `…/EstacionesTerrestres/`.
  - La API permite CORS, así que se consulta directamente desde el móvil (sin servidor propio).
- **Tu provincia:** se detecta por GPS + geocodificación inversa de **Nominatim** (OpenStreetMap).
- **Mapa:** Leaflet + tiles de **OpenStreetMap** (sin API key).
- **Rutas:** **OSRM** (router público de OpenStreetMap) traza el camino y se buscan las
  gasolineras más baratas dentro de un corredor de ~4 km del trayecto.

## Cómo funciona el modo sin conexión
- Al cargar con internet, guarda en el dispositivo (`localStorage`) las estaciones cercanas
  y la hora. Si abres sin cobertura, ves esos precios con un aviso de cuándo se actualizaron.
- El service worker cachea la app y los tiles del mapa ya visitados.

## Qué guarda en tu dispositivo (nada sale a ningún servidor)
- Favoritas, repostajes registrados (litros y precio del día), datos camper que marcas
  tú mismo (acceso/agua/pernocta), histórico de precios de tus favoritas, tema y depósito.
- Clave de almacenamiento: `repostaje_camper_v1`.

## Cómo probarla
1. En Claude Code, panel de preview → servidor **`repostaje`** (o ejecuta `serve-repostaje.ps1`).
2. Para instalarla en el móvil hace falta servirla por **HTTPS** (el GPS y el service
   worker lo requieren). Súbela a cualquier hosting estático (Netlify, GitHub Pages, Firebase
   Hosting, Vercel…) y "Añadir a pantalla de inicio".

## Notas / pendientes
- Los datos **camper** (surtidor accesible / agua-vaciado / pernocta) no existen en la API
  oficial: los marcas tú en el detalle de cada estación y se guardan en tu dispositivo.
- El **histórico de 7 días** se construye con los precios que la app va viendo de tus
  favoritas (la API solo da el precio actual), así que aparece cuando hay ≥2 lecturas.
- Marcas reconocidas por su rótulo: Repsol, Cepsa, BP, Galp, Petronor y low-cost
  (Ballenoil, Petroprix, Plenoil, Carrefour, Alcampo, Eroski…). El resto salen como "Otra".
