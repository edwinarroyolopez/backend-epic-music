# Música Épica — API Express / MongoDB

Node 22.12+ recomendado. Instalar con `npm install`; configurar localmente
`MONGODB_URI`, `JWT_SECRET` y las credenciales del proveedor elegido. No incluir
sus valores en logs o commits. `npm start` escucha en 7000 (o `PORT`) después
de conectar Mongo y crear/verificar los índices de playlists. `npm run dev` usa nodemon.

## Rutas

- Público: `POST /search-songs` recibe `{lyrics,artist?,genre?,provider?}`;
  letra 15–12000 caracteres, pistas ≤200, proveedor gemini|deepseek. Respuesta
  `{success:true,data:{found,song,recommendations,count,ai,notice}}`.
  Identificación + 11 recomendaciones únicas, o found:false sin canciones.
  Errores 400/502. Son inferencias, no verificaciones de catálogo.
- Auth: POST `/auth/signup`, POST `/auth/login`, GET `/auth/me` con JWT.
- GET `/auth/providers`: correo true, OAuth false.
- GET `/health`: 200 y `{success:true,data:{database:"connected"}}` cuando
  Mongo está conectado; 503 cuando no. No comprueba credenciales/proveedores IA.
- Playlists: todas con Bearer JWT + cuenta existente activa:
  GET/POST `/playlists`; GET/PATCH/DELETE `/playlists/:playlistId`;
  POST `/playlists/:playlistId/songs`;
  DELETE `/playlists/:playlistId/songs/:songId`;
  PATCH `/playlists/:playlistId/songs/order`.

## Ejemplo sin datos privados

POST `/playlists`:
```json
{"name":"Mi selección","description":"Instrumentación intensa","songs":[{"title":"Título de ejemplo","artist":"Artista de ejemplo","originType":"recommendation","catalogVerified":false}]}
```

201 (IDs ilustrativos de entradas propias, no de catálogo):
```json
{"success":true,"data":{"playlist":{"id":"000000000000000000000001","name":"Mi selección","description":"Instrumentación intensa","songCount":1,"songs":[{"id":"000000000000000000000002","title":"Título de ejemplo","artist":"Artista de ejemplo","originType":"recommendation","catalogVerified":false,"addedAt":"2026-10-08T00:00:00.000Z"}],"createdAt":"2026-10-08T00:00:00.000Z","updatedAt":"2026-10-08T00:00:00.000Z"},"addedCount":1,"skippedCount":0}}
```

Errores playlists: `{success:false,error:{code,message}}`. 400 validación, 401
sin sesión válida/cuenta inexistente, 403 inactiva, 404 inexistente **o ajena**,
409 conflicto/límite, 413 body >512 KiB, 500 fallo interno saneado. El middleware
JWT conserva además `message` por retrocompatibilidad con auth.

Límites: 100 playlists/usuario, 500 canciones/playlist, 100 por lote; name 100,
description 1000, title/artist/genre/album 200, reason 2000. Creación vacía válida.
Deduplicación por título+artista normalizados Unicode/acentos/case/espacios;
la primera versión conserva metadatos. Nunca se guardan letras ni IDs externos.
`songIds` exige permutación total del detalle actual. Concurrencia: __v/CAS y
owner en cada escritura, hasta 5 intentos; índice único owner+slot limita creación
concurrente. No requiere replica set/transactions; crear con canciones es una
única escritura. Timeouts inciertos de escritura deben resolverse consultando
el estado antes de repetir; la adición es deduplicada, la creación no es idempotente.

Contrato completo: `../ai/02_CONTRACTS.md`.

## Railway y CORS de Netlify

API pública configurada para el frontend:
`https://backend-epic-music-production.up.railway.app`.
Railway debe ejecutar `npm start`, disponer de MONGODB_URI/JWT_SECRET/proveedor
válidos y dirigir tráfico al puerto `PORT` asignado al servicio. El arranque
espera la conexión Mongo y la inicialización del índice de playlists.

CORS permite `https://musica-epica-ed.netlify.app`, los deploys/previews/ramas
`https://<prefijo>--musica-epica-ed.netlify.app` y localhost de desarrollo.
No permite otros sitios Netlify. Para dominios propios adicionales usar
`CORS_ORIGINS=https://music.example.com,https://www.music.example.com`.
Permite preflights con Authorization/Content-Type y GET/POST/PATCH/DELETE;
las rutas privadas siguen exigiendo JWT. Origen rechazado →403 CORS_ORIGIN_DENIED.

Comprobación pública sin credenciales:
```bash
curl -i https://backend-epic-music-production.up.railway.app/health
curl -i -X OPTIONS https://backend-epic-music-production.up.railway.app/search-songs \
  -H 'Origin: https://musica-epica-ed.netlify.app' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,authorization'
```
Esperado: health 200 con Mongo conectado; OPTIONS 204 con
Access-Control-Allow-Origin coincidente. Un 502 de railway-hikari indica que la
aplicación no respondió, antes de comprobar el CORS de Express.

## Pruebas locales aisladas

```bash
npm test
npx playwright install chromium
npm run test:e2e
```

`mongodb-memory-server` descarga/ejecuta un mongod real efímero exclusivamente
para tests. Nunca conecta con MONGODB_URI del entorno para tests. Cada ejecución
cierra procesos y elimina solo el espacio efímero que creó. Puede necesitar red
para la primera descarga del binario. E2E necesita dependencias del frontend
hermano instaladas y puerto local 5173 libre. No se inicia ningún servicio remoto.

IA determinista mediante dependencia `callAI`; el servidor de aplicación no
tiene interruptor de respuestas mock. Gemini/DeepSeek reales son opt-in manuales,
pueden tener coste y no se usan en los comandos anteriores. Timeout proveedor 45s,
cliente IA 240s para identificación/fallback/reintentos. No se garantiza exactitud
del título ni se presenta modelConfidence como probabilidad verificada.
