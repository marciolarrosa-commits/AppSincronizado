# Rutas del servidor (verificadas contra `src/app.js`)

Tabla extraída del código (`route()`, `pickPage()`, `server.on('upgrade')`). No hay otras rutas: cualquier otra petición recibe `404 {"error":"NOT_FOUND"}`.
Todas las respuestas llevan `x-content-type-options`, `x-frame-options: DENY`, `referrer-policy: no-referrer` y, en producción, HSTS. Los errores internos devuelven `500 {"error":"SERVER_ERROR"}` sin detalle.

## Páginas (sin redirecciones; cada URL responde directamente)

| Método y ruta | Quién | Qué entrega | Errores / notas |
|---|---|---|---|
| `GET/HEAD /` | público | **Portada de Destello·Sync V3** (`public/index.html`): explica el sistema, botón «Abrir panel del operador» → `/master`, y un campo para unirse con el código. | Cualquier parámetro que no sea `s` o `mode` se ignora (p. ej. `?utm_source=`). |
| `GET/HEAD /?s=CODIGO&mode=remote` | público (participante) | **Pantalla del participante** (`public/flash.html`, cliente remoto V3). **Es el formato de los QR de V3; se conserva.** | Siempre disponible, no depende del interruptor Flash. |
| `GET/HEAD /?mode=remote` | público | Igual, sin código (app instalada / PWA: pide el código). `start_url` del manifiesto. | Siempre disponible. |
| `GET/HEAD /master` (y `/master/`) | público (la página); la autenticación es del API | **Panel del operador** (`public/master.html`). | Sin sesión de operador solo muestra el formulario de ingreso. |
| `GET/HEAD /flash` (y `/flash/`, `/flash.html`) | público, **solo si el operador habilitó Flash** | **App Flash anterior** (micrófono + linterna), misma página `flash.html`. Con `?s=CODIGO` abre directamente la vista de activación. | Deshabilitada (por defecto): `403` con la página `flash-disabled.html`, `cache-control: no-store`. |
| `GET/HEAD /?s=CODIGO` (sin `mode=remote`) | público, igual que `/flash` | Enlaces/QR **antiguos** de la app Flash. | Deshabilitada: `403`. |
| `GET/HEAD /js/*.js`, `/icons/*.png`, `/favicon.svg`, `/manifest.webmanifest`, `/flash-disabled.html` | público | Archivos estáticos de `public/` (gzip + ETag; `cache-control: no-cache`, se revalidan). | `404` si no existen; `400` si la ruta tiene `..` o `\0`. Los `*.artifact.json` del editor **no** se publican. |

> `flash.html` es un único archivo: contiene la app Flash y el cliente remoto de V3 (el que se validó en dos iPhone). No se separó para no tocar ese cliente. Por eso el interruptor controla las **direcciones de entrada** (`/flash`, `/?s=`), no los bytes del archivo; la app Flash es 100 % del lado del cliente (no usa el servidor) y no expone nada sensible.

## Salud y métricas

| Método y ruta | Auth | Respuesta | Notas |
|---|---|---|---|
| `GET/HEAD /healthz` | ninguna | `200 {"ok":true,"status":"alive","uptimeS":N}` | Liveness; es el `healthCheckPath` de Render. Exento del límite de peticiones. |
| `GET /readyz` | ninguna | `200 {"ready":true}` o `503 {"ready":false}` | `503` si el almacenamiento no responde, la instancia se está apagando o superó `MAX_CONNECTIONS`. Exento del límite. |
| `GET /metrics` | `Authorization: Bearer <METRICS_TOKEN>` **o** token de operador | `200 text/plain` (formato Prometheus) | `401 {"error":"UNAUTHORIZED"}` sin token válido. |

## API REST (JSON, `cache-control: no-store`, límite por IP `HTTP_RATE_PER_MIN`; `429` con `retry-after`)

| Método y ruta | Auth | Cuerpo → respuesta | Errores |
|---|---|---|---|
| `POST /api/master/login` | ninguna (límite propio `LOGIN_RATE_PER_MIN`=8/min/IP) | `{ "password": "…" }` → `200 {operatorToken, expiresAt}` | `401` contraseña incorrecta (espera 250 ms); `429` demasiados intentos; `400` JSON inválido; `413` cuerpo > 4 KB. |
| `POST /api/sessions` | operador (Bearer) | `{}` o `{ "sessionId": "ABC234" }` (re-crear con el mismo código) → `201 {sessionId, code, joinUrl, masterToken, masterTokenExpiresAt, state, strobeEnabled, wsPath:"/ws"}` | `401`; `400 INVALID_SESSION`; `409 SESSION_EXISTS`; `429 TOO_MANY_SESSIONS`; `503 CODE_COLLISION`. `joinUrl` = `<base>/?s=CODIGO&mode=remote`. |
| `GET /api/sessions` | operador | → `200 {sessions:[{id, createdAt}]}` (hasta 50) | `401`. |
| `POST /api/sessions/:id/master-token` | operador | → `200 {sessionId, joinUrl, masterToken, masterTokenExpiresAt, state, strobeEnabled}` | `401`; `404 SESSION_NOT_FOUND`. |
| `POST /api/sessions/:id/revoke` | operador | → `200 {epoch}` (invalida los tokens de Master emitidos) | `401`; `404`. |
| `GET /api/sessions/:id/status` | pública: solo existencia · operador: detalle | público → `200 {sessionId, exists:true}`; operador → `{sessionId, state, strobeEnabled, connected, createdAt}` | `404 SESSION_NOT_FOUND` (cuenta para el límite de fallos por IP). `:id` = 6 caracteres. |
| `GET /api/admin/flash` | operador | → `200 {enabled, defaultEnabled, path:"/flash", url}` | `401`. |
| `POST /api/admin/flash` | operador | `{ "enabled": true \| false }` → `200` igual que el GET | `401`; `400 INVALID_BODY` si `enabled` no es booleano; `413`. Se guarda en el almacenamiento (compartido entre instancias, refresco ≤ 5 s). |
| `GET /api/admin/status` | operador | → `200 {health, hub, metrics, store, flash:{enabled}, instance, cluster, sessions}` | `401`. La URL de Redis se enmascara. |
| `OPTIONS *` | — | `204` con CORS solo para los orígenes de `ALLOWED_ORIGINS` | Sin origen permitido no se agrega `access-control-allow-origin`. |

Tokens: el **operador** (`POST /api/master/login`, vigencia `OPERATOR_TOKEN_TTL_S`) puede usar toda la API; el **Master de sesión** (`masterToken`, vigencia `MASTER_TOKEN_TTL_S`, ligado a UNA sesión y a su `epoch`) solo sirve para el WebSocket; los participantes no tienen token. El token de Master **no** es válido como operador (probado en `test/navegacion.test.js`).

## WebSocket

| Ruta | Auth | Protocolo |
|---|---|---|
| `WS /ws` | primer mensaje `hello` con `role: "public"` + `sessionId` (+ `deviceId`) o `role: "master"` + `sessionId` + `token` | Ver `PROTOCOLO.md`. Compatibilidad V3.0: `/ws?session=CODIGO&role=public&deviceId=ID` (solo participantes). |

Rechazos antes de aceptar la conexión: `404` (otra ruta), `503` (apagando o sin capacidad), `403` (`Origin` no permitido), `429` (límites por IP). Códigos de cierre: `4401` token inválido/vencido, `4404` sesión inexistente, `1012` reinicio del servidor.
