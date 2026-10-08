# Música Épica — API Express / MongoDB

Node 22.12+ recomendado. Instalar con `npm install`; configurar localmente
`MONGODB_URI`, `JWT_SECRET` y las credenciales del proveedor elegido. No incluir
sus valores en logs o commits. `npm start` abre HTTP en `0.0.0.0:PORT` (7000 por
defecto) e inicializa Mongo e índices. `/health` solo responde 200 al terminar
esa inicialización. `npm run dev` usa nodemon.

## Rutas

- Público: `POST /search-songs` recibe `{lyrics,artist?,genre?,provider?}`;
  letra 15–12000 caracteres, pistas ≤200, proveedor gemini|deepseek. Respuesta
  `{success:true,data:{found,song,recommendations,count,ai,notice}}`.
  Identificación + 11 recomendaciones únicas, o found:false sin canciones.
  Errores 400/502. Son inferencias, no verificaciones de catálogo.
- Auth: POST `/auth/signup`, POST `/auth/login`, GET `/auth/me` con JWT.
- GET `/auth/providers`: correo disponible si JWT está configurado, OAuth false.
  Si no puede emitir sesiones, devuelve email:false y emailUnavailableReason
  (JWT_SECRET_MISSING o JWT_EXPIRES_IN_INVALID), nunca el valor de las variables.
- GET `/health`: 200 y `{success:true,data:{database:"connected"}}` cuando
  Mongo e índices están listos; incluye `data.ready:true`. Devuelve 503 UNAVAILABLE
  con `data.ready:false` durante inicialización/fallo. No comprueba proveedores IA.
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

### Configuración de sesiones

En Railway → servicio backend → Variables, `JWT_SECRET` debe ser una clave
privada no vacía. `JWT_EXPIRES_IN` es opcional (por defecto `7d`); usar valores
como `7d` o `1h`, sin comillas literales añadidas en el panel. No poner estas
variables en Netlify/VITE ni compartir sus valores.

Un JWT no configurable devuelve **503 AUTH_UNAVAILABLE** antes de consultar
credenciales o crear una cuenta. Signup no deja una cuenta creada por fallar la
firma del token. `/health` comprueba Mongo/índices; `/auth/providers` informa
separadamente de la disponibilidad de la autenticación.

Las cuentas heredadas sin un hash bcrypt válido reciben401, nunca se permite
autenticación con contraseña en texto plano ni se modifica su registro de forma
automática. Las excepciones de login registran solo fase/tipo (sin correo,
contraseña, hash, JWT ni URI). Registro duplicado devuelve409.

### Red y despliegue

API pública configurada para el frontend:
`https://backend-epic-music-production.up.railway.app`.
`railway.json` configura `npm start`, healthcheck `/health` (120s) y hasta tres
reinicios ante salida fallida. Railway debe disponer de MONGODB_URI/JWT_SECRET/
proveedor válidos y dirigir tráfico al mismo `PORT` asignado al servicio.
El puerto se abre explícitamente en `0.0.0.0` antes de inicializar Mongo.

Compatibilidad con el dominio existente: el backend original escuchaba siempre
en **7000**. Al detectar `RAILWAY_ENVIRONMENT_ID`, también se sirve la misma app
en 7000 si el `PORT` asignado es distinto. Así funcionan tanto el Target Port
legado del dominio como el puerto de healthcheck de Railway. Mongo e índices se
inicializan una sola vez. `LEGACY_HTTP_PORT` permite cambiar ese puerto; `0` lo
desactiva cuando el dominio ya apunte al PORT asignado. En desarrollo local no se
abre un puerto adicional.

Mientras Mongo/índices no estén listos, `/auth/providers` y OPTIONS responden
normalmente, y login/signup/me/playlists responden 503 UNAVAILABLE con CORS
(me/playlists sin JWT conservan 401). Así no se confunde un error de base de datos
con un bloqueo CORS ni se dejan operaciones esperando el buffer de Mongoose.
El servidor registra el tipo de error de inicialización sin URIs ni credenciales.
Un fallo inicial mantiene HTTP diagnóstico en 503, sin bucle de reconexión propio:
tras corregir las variables/conectividad, reiniciar/republicar el servicio.
El healthcheck impide considerar listo ese deployment hasta recibir 200.

En los logs se distinguen dos eventos:
1. `API Música Épica escuchando en puerto ...`: HTTP disponible.
2. `API lista: MongoDB e índices inicializados`: servicio listo para login/playlists.

Si sigue el 502 de railway-hikari, verificar que el deploy activo incluye estos
cambios, su rama de origen y el Target Port del dominio; abrir el puerto no corrige
por sí solo una asignación de puerto o una configuración remota errónea.

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
