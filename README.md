# Música Épica — API Express / MongoDB

Node 22.12+ recomendado. Instalar con `npm install`; configurar localmente
`MONGODB_URI`, `JWT_SECRET` y las credenciales del proveedor elegido. No incluir
sus valores en logs o commits. `npm start` abre HTTP en `0.0.0.0:PORT` (7000 por
defecto) e inicializa Mongo e índices. `/health` solo responde 200 al terminar
esa inicialización. `npm run dev` usa nodemon.

## Rutas

- Público (JWT opcional): `POST /search-songs` recibe `{lyrics,artist?,genre?,provider?,searchId?}`;
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

## Enlaces y letra completa

Cada canción de búsqueda añade `links:{youtube,spotify,appleMusic}`. Son URLs de
búsqueda por título+artista, no IDs o enlaces directos de catálogo verificados.
El detalle/replay de historial regenera esos enlaces desde el snapshot existente;
no se necesitan nuevas columnas ni guardar URLs en playlists.

`GET /songs/lyrics?title=...&artist=...` resuelve una canción global en Mongo y
consulta LRCLIB bajo demanda por estos metadatos, sin fragmento del usuario
ni Authorization externo. Ambos strings1–200 caracteres. También acepta `songId`
(ObjectId global, no ID de entrada de playlist) y `edition` opcional. Si se envían
ID y metadatos deben corresponder. La identidad es provisional, no catálogo verificado.
Respuesta `{success:true,data:{status,title,artist,lyrics,source,emotions,emotionAnalysis}}`:
El contrato añade songId, lookupAttempted, lyricsLookupStatus, cacheState, cacheHit,
retryAfter y emotionAnalysis.sourceContentVersion. Estados clásicos se mantienen;
se añaden never_attempted/in_progress/temporary_error/rights_restricted.
Sólo se adjunta texto con coincidencia conservadora NFC. Guardarlo permanentemente
requiere autorización documentada.
**Persistencia de texto LRCLIB: BLOCKED_RIGHTS**: no se ha verificado permiso
para almacenamiento permanente. Su lector bajo demanda vuelve a entregar el texto
validado y analizarlo, sin copiar el cuerpo a Mongo. El gate de almacenamiento no
debe transformar un positivo de búsqueda en un bloqueo de visualización.
La API pública y licencia del software no autorizan letras de terceros. Ver
`../ai/SONG_CACHE_RIGHTS_DECISION.md`. Las pruebas usan texto propio sintético autorizado.

Estado persistido `transient`: text=null, fuente/hash/fechas/análisis en Song. DTO
con cuerpo: status=available, lyricsStorage=transient, cacheState=transient. Memoria
temporal de proceso:100 canciones/5min, purga por temporizador. Abrir un viejo
rights_restricted de LRCLIB vuelve a consultar automáticamente; no requiere reset
ni cooldown del bloqueo anterior. Un adaptador puede denegar explícitamente la
entrega mediante transientPolicy; no se confunde con la falta de permiso de guardar.
Tras caducar memoria/reiniciar/otra instancia es necesaria otra descarga. Los
claims Mongo serializan adquisición/análisis; las instancias no comparten cuerpos
que Mongo no guarda. El mismo hash reutiliza IA persistida (también después del
reinicio). La entrega transitoria conserva el lector previo, no acredita licencia.

En el mismo request, la letra disponible se analiza con el proveedor IA configurado.
`emotions:[{code,score}]` contiene3 códigos distintos, ordenados, enteros positivos
que suman100. Códigos: joy/sadness/anger/fear/love/hope/nostalgia/calm.
Son pesos relativos entre las3 emociones, no intensidad absoluta ni análisis de
audio. `emotionAnalysis` informa status `estimated|unavailable|insufficient_evidence|not_applicable`,
method `ai_lyrics`,scope `lyrics`,scale `relative_percent`,version1,provider/model,
analyzedAt y sampled. Métricas de llamadas del proveedor quedan en tests, no en DTO.
Máximo1 llamada/500 tokens/10s por trabajo adquirido, sin fallback;
letras >12000 caracteres usan muestra del principio/final. Sin letra no hay IA.
Si el proveedor no está disponible o el JSON no es válido, se devuelven letra y
HTTP200 con emotions[]/unavailable; nunca se inventan métricas.

Límites:120/min por IP/proceso (incluye polling), timeout proveedor8s,
cuerpo256KiB/letra60000 caracteres, host HTTPS fijo sin redirecciones.
Mongo e índice UNIQUE canonicalKey son obligatorios: 503 SONG_CACHE_UNAVAILABLE,
sin bypass. 400 VALIDATION_ERROR, 404 SONG_NOT_FOUND, 409 SONG_IDENTITY_MISMATCH,
429 RATE_LIMITED. Cache-Control:no-store. Espera de espectador1.5s → 202 + Retry-After;
no libera trabajo global si se cancela HTTP. Cada etapa tiene lease30s y budget12s.
CAS y token impiden commit de worker antiguo. Tras crash entre proveedor/commit,
la recuperación al caducar lease puede repetir el proveedor: no exactly-once universal.
Relojes de instancias deben estar sincronizados. Negativos y bloqueos explícitos
de entrega no se reconsultan automáticamente (excepción: migración lazy del bloqueo
local LRCLIB antiguo, descrita arriba). Fallo lookup: cooldown exponencial30s–1h, respeta
Retry-After hasta24h. Fallo IA: letra visible, retry explícito tras30s mediante
`analysisOnly=true`, que no adquiere lookup para texto persistido o aún presente
en memoria. Si el cuerpo transitorio caducó/falta en esta instancia, debe recuperarse
antes de analizar; estimated/insufficient_evidence se
reutilizan mientras coincidan hash de contenido y EMOTION_VERSION.

**Refetch manual:** `refetchLyrics=true` permite volver a consultar `not_found` o
`rights_restricted` tras30s desde la última finalización. No se activa al abrir una
vista; requiere acción explícita. `lyricsRefetchAt` informa la fecha absoluta para
habilitar el botón y `Retry-After` la espera restante. Si obtiene texto autorizado,
se persiste y se ejecuta el análisis pendiente; en entrega transitoria sólo el hash
y el análisis se guardan. Con texto persistido o aún en memoria no redescarga la
letra; sólo recupera análisis faltante/fallido respetando su cooldown. Los flags
`refetchLyrics` y `analysisOnly` son booleanos textuales y mutuamente excluyentes.
Cada petición admite como máximo una adquisición de lookup, con el mismo CAS,
lease y fencing. El refetch **no** concede derechos: un resultado aún restringido
continúa sin texto/IA. Véase `../ai/SONG_CACHE_REFETCH.md`.

### Persistencia autorizada y datos legacy
La decisión histórica «nunca almacenar letras en Mongo» cambia **sólo para Song
global con derechos documentados**. Nunca se copian a playlists, historial,
localStorage ni logs; fragments de identificación siguen sin persistencia.
Adaptadores de servidor `storagePolicy(data,song)` default-deny autorizan por
procedencia/registro y referencia de derechos. Ningún flag HTTP o variable de
entorno activa derechos de LRCLIB. Nuevas fuentes requieren revisión documentada.
Search enlaza12 Song sin precargar letras/emociones. Historial conserva snapshot
privado/TTL90d; playlist conserva ID de entrada y orden, con songId adicional.
Legacy sin songId resuelve al abrir por título/artista/edición; no hay migración
destructiva. Backfill opcional: recorrer lotes pequeños de snapshots, resolver sólo
metadatos, actualizar songId únicamente si sigue ausente y los metadatos no cambiaron;
repetir es idempotente, nunca copiar texto ni regenerar identificación. No ejecutado.
Invalidación/revocación futura de derechos debe retirar texto y análisis mediante
un procedimiento administrativo autorizado, no un endpoint público de reset.
Tests inyectan fetch/callAI; no descargan letras reales ni usan IA de pago.
Contrato/evidencia actual: `../ai/SONG_CACHE_MASTER_LOOP_PLAN.md` y
`../ai/SONG_CACHE_FINAL_ACCEPTANCE.md` (sustituyen la parte de persistencia del diseño anterior).

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

## Búsqueda tolerante, directorio global e historial

Contrato aditivo y decisiones: `../ai/SEARCH_INTELLIGENCE_MASTER_PLAN.md`.
Evidencia local: `../ai/SEARCH_INTELLIGENCE_EVIDENCE.md`.

- `input.original/resolved`, `input.corrections`, `input.needsConfirmation` e
  `input.directoryStatus` explican la resolución textual sin contener letras.
  Coincidencia exacta/alias/fold/fuzzy conservador; prefijos de artista inequívocos
  (>=6 caracteres, >=75% del nombre y margen frente a otros candidatos) con
  source `catalog_prefix`. Los prefijos no se guardan como alias permanentes.
  Géneros extensibles en
  `src/services/search-normalization.js`. Ambigüedad no aplica sustituciones.
- La letra es primaria. Si el artista no se resuelve, un fallo permite reconsiderar
  el nombre como fragmento opcional (`identify_relaxed_artist`) antes de quitar
  todas las pistas (`identify_without_hints`). La recuperación tiene prioridad
  sobre cambiar de proveedor cuando el nombre está incompleto.
  Máximo3 llamadas de identificación (incluye fallback) +2 de recomendaciones;
  `ai.callCount`, `ai.attempts`, `ai.totalElapsedMs` y `ai.recommendationGenre`
  muestran coste en llamadas/latencia/contexto. Máximo9400 tokens de salida
  solicitados (3×1000 +2×3200), no un coste monetario ni precisión garantizada.
  Un género identificado contradictorio prevalece sobre la pista.
  Un miss válido tras completar la recuperación no se convierte en502 por fallar
  un proveedor opcional posterior: se conserva found:false y el error en attempts.
  Fallos reales sin ningún ciclo completado siguen siendo502.
- Colección `artists` global sin propietario: identidad única, alias limitados,
  índices multikey de búsqueda y origen `curated|model_inferred`. Se aprenden
  el artista de **cada búsqueda found:true** antes de responder, incluso cuando
  coincide exactamente con la pista escrita. Se usa el mismo umbral de identificación
  (>=.6), sin un filtro secundario.9. Upsert por identidad del nombre devuelto, sin
  fusionar nombres distintos mediante fuzzy. No se promueven pistas sin resultado,
  recomendaciones ni identificaciones rechazadas. Esto no es un catálogo
  verificado; no hay seeds de prueba en producción.
- `GET /artists/suggest?q=...&limit=6`: q2–200, limit1–10, público para cuentas
  e invitados; rango indexado literal + candidatos por trigramas, <=81 por query,
  maxTimeMS1000. 400 VALIDATION_ERROR, 429 RATE_LIMITED, 503 UNAVAILABLE.
  Cache-Control:no-cache obliga a revalidar sugerencias anteriores tras nuevas altas.
- `GET /search-history?limit=20&cursor=...`, `GET /search-history/:id`,
  `DELETE /search-history/:id`: JWT/cuenta activa, owner exclusivo del JWT;
  ID ajeno/inexistente404, inválido400. Paginación estable fecha+ID, limit1–50,
  Cache-Control:no-store. Snapshot de canción y11 recomendaciones, sin letras,
  hashes de letras, tokens ni respuestas completas del proveedor.
- Historial en `searchhistories`: TTL90 días y recorte a200 entradas completadas
  por cuenta. Reservas pendientes no se eliminan durante trabajo; a los5min se
  muestran INTERRUPTED y se consolidan al siguiente search. Índices inicializados
  antes de readiness: owner/requestId único, owner/fecha/id y expiresAt TTL.
- `searchId` UUIDv4 permite repetir la misma operación autenticada: reserva
  pendiente409 SEARCH_IN_PROGRESS, completada devuelve snapshot sin otra IA.
  La primera petición con ese ID gana, incluso si se cambia el body. Sin ID se
  genera uno; invitados no tienen historial/idempotencia persistente en servidor.
- `data.history.status`: saved solo tras confirmar escritura, local_only para
  invitados, unavailable ante fallo Mongo/guardado. Error de proveedor502 añade
  history/input/code y también puede persistirse. Validación400 no crea historial.
  JWT presente inválido401; usuario inactivo403. Si Mongo no está listo, un JWT
  con firma válida no basta para asociar una cuenta: búsqueda pública continúa
  con history unavailable. Cabeceras de owner/userId nunca asignan historial.
- Cancelar el HTTP no garantiza detener el proveedor: una búsqueda aceptada puede
  completar su entrada. Si guardar falla, el resultado musical se conserva.
  Directorio/historial503 no se presentan como falta de coincidencia musical.
- Rate limits por proceso/IP de conexión: sugerencias60/min, búsqueda20/min,
  historial120/min; mapa máximo5000 IPs por limitador, sin confiar X-Forwarded-For.
  Tras un proxy los visitantes pueden compartir cupo; para múltiples instancias
  se requiere un limitador compartido y configuración explícita de proxies fiables.

Cambios de esquema aditivos: no migran User/Playlist. Rollback local de código
puede dejar ambas colecciones sin consumidores; no requiere borrar datos.

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
