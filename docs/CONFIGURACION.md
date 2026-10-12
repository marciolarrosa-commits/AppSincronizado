# Configuración (variables de entorno)

Todo sale de variables de entorno (`src/config.js`). **Ningún secreto está en el repositorio.** `.env.example` es solo una plantilla comentada.

## Obligatorias en producción (`NODE_ENV=production`)

| Variable | Descripción |
|---|---|
| `MASTER_PASSWORD` | Contraseña del operador para `/master` (≥ 12 caracteres y al menos 6 caracteres distintos; **V3.5.0**). Si falta o es demasiado simple, **el servidor no arranca**. En desarrollo (sin `NODE_ENV=production`) se genera una temporal y se imprime una vez. |
| `PUBLIC_BASE_URL` | **V3.5.0: obligatoria.** URL pública https del servicio, **solo el origen** (p. ej. `https://mi-servicio.onrender.com`, sin ruta ni barra final). Si no se define y el servicio corre en Render, se usa `RENDER_EXTERNAL_URL` (que define Render) y el arranque lo registra. Con un **dominio propio** hay que definirla (si no, los WebSockets desde ese dominio se rechazan). Sin ninguna de las dos el servidor no arranca. |

## Seguridad y acceso

| Variable | Defecto | Descripción |
|---|---|---|
| `TOKEN_SECRET` | derivado de `MASTER_PASSWORD` con **scrypt** (V3.5.0; antes HKDF, rápido) | Secreto HMAC de los tokens. **Recomendado definirlo en producción**: ≥ 32 bytes aleatorios en **hexadecimal (≥ 64 caracteres) o base64/base64url (≥ 43)**, p. ej. `openssl rand -base64 48`. Si se define se **valida al arrancar** (el servidor no arranca si es corto, repetitivo, secuencial o texto libre; el mensaje nunca repite el valor). Es una comprobación heurística: no prueba aleatoriedad (un secreto aleatorio legítimo se rechaza ≈ 1 de cada 25 000; basta regenerarlo). Todas las instancias deben compartirlo. **Rotarlo invalida todos los tokens.** |
| `OPERATOR_TOKEN_TTL_S` | 28800 (**8 h**; antes 12 h) | Vigencia del token de operador (tope 24 h). Hay cierre de sesión con revocación en el servidor (`POST /api/master/logout`). |
| `MASTER_TOKEN_TTL_S` | 43200 (12 h) | Vigencia del token de Master de una sesión (tope 24 h). Se revoca rotando el `epoch` de la sesión. |
| `ALLOWED_ORIGINS` | (vacío) | Orígenes extra permitidos para WebSocket/CORS (lista separada por comas). **V3.5.0:** solo `https://dominio[:puerto]` (sin comodines, sin `null`, sin rutas; en producción `http://` solo para `localhost`); un valor inválido impide el arranque. En producción el Origin de un WebSocket se acepta **solo** si coincide (esquema + host + puerto) con `PUBLIC_BASE_URL` o está en esta lista: el encabezado `Host` ya no sirve de referencia (fuera de producción sí, por comodidad de desarrollo). |
| `ALLOW_NO_ORIGIN` | `false` en producción, `true` en desarrollo | Permitir WebSocket sin cabecera `Origin` (herramientas no-navegador). |
| `TRUST_PROXY_HOPS` | 1 en Render (`RENDER` definido), 0 en otro caso | Saltos de proxy de confianza para leer la IP real de `X-Forwarded-For` (entrada n-ésima **desde la derecha**). Con un CDN delante de Render hay que **subirlo a 2**; demasiado bajo agrupa a todos los usuarios en las IP del CDN y demasiado alto permite fijar la IP con una cabecera falsa. Las IP se normalizan (IPv4 mapeada → IPv4; IPv6 → prefijo /64). |
| `FORCE_HTTPS` | `true` en producción con proxy de confianza | Redirige `http` → `https` (308 a la URL canónica) según `X-Forwarded-Proto`. `/healthz` y `/readyz` quedan exentos. |
| `METRICS_TOKEN` | (vacío) | Token Bearer para `/metrics` (el token de operador también sirve). |

## Estado compartido / varias instancias

| Variable | Defecto | Descripción |
|---|---|---|
| `REDIS_URL` | (vacío = memoria) | URL de Redis/Valkey. Obligatoria con más de una instancia o `CLUSTER_WORKERS>1`. |
| `REDIS_PREFIX` | `ds:` | Prefijo de claves. |
| `CLUSTER_WORKERS` | 1 | Procesos por instancia (>1 requiere `REDIS_URL`). |
| `INSTANCE_ID` | host-pid-aleatorio | Identificador de la instancia en logs y presencia. |
| `SESSION_TTL_S` | 43200 | Caducidad de una sesión inactiva. |
| `MAX_SESSIONS` | 200 | Tope de sesiones activas. |

## Capacidad y límites

| Variable | Defecto | Descripción |
|---|---|---|
| `PORT` / `HOST` | 10000 / 0.0.0.0 | Render define `PORT`. |
| `LISTEN_BACKLOG` | 4096 | Cola de aceptación (reconexiones masivas). |
| `MAX_CONNECTIONS` | 20000 | Conexiones por proceso; al llegar, `/readyz` → 503 y se rechazan upgrades (503). |
| `MAX_PUBLIC_PER_SESSION` | 100000 | Participantes por sesión (por proceso). |
| `MAX_MASTERS_PER_SESSION` | 3 | Paneles Master simultáneos por sesión. |
| `MAX_MESSAGE_BYTES` | 2048 | Tamaño máximo de mensaje entrante. |
| `HELLO_TIMEOUT_MS` | 5000 | Tiempo para enviar `hello`. |
| `HEARTBEAT_MS` | 20000 | Ping/pong de transporte, **repartido** en el intervalo (no todos a la vez). |
| `CLOCK_PING_INTERVAL_MS` | 30000 | Cada cuánto resincroniza el reloj el cliente (1 ping, ±15 %). |

## Sincronización y efectos

| Variable | Defecto | Descripción |
|---|---|---|
| `COMMAND_LEAD_MS` | 1500 | Margen entre aceptar una orden y su ejecución. |
| `COMMAND_MIN_LEAD_MS` / `COMMAND_MAX_LEAD_MS` | 300 / 8000 | Límites del margen. El margen efectivo es ≥ 2 × p95 de difusión + 250 ms. |
| `ON_TIME_TOLERANCE_MS` | 100 | Tolerancia para contar una aplicación como "a tiempo". |
| `ACK_TARGET_PER_COMMAND` | 500 | Confirmaciones de aplicación deseadas por orden (`ackRate = min(1, 500/audiencia)`). |
| `STROBE_ALLOWED` | true | Interruptor general: `false` impide habilitar strobe en cualquier sesión. |
| `MAX_STROBE_HZ` | 3 (tope duro 3) | Frecuencia máxima de strobe. |
| `MAX_STROBE_DURATION_MS` | 30000 (máx 120000) | Duración máxima de un strobe. |
| `MAX_PULSE_DURATION_MS` | 600000 | Duración máxima de un pulso con límite. |

## Límites de frecuencia

| Variable | Defecto | Descripción |
|---|---|---|
| `MASTER_COMMANDS_PER_SEC` / `MASTER_COMMAND_BURST` | 5 / 10 | Órdenes del Master (`stop` no cuenta). |
| `PUBLIC_MSG_PER_SEC` / `PUBLIC_MSG_BURST` | 5 / 30 | Mensajes de un participante; 20 infracciones → cierre 4429. |
| `HTTP_RATE_PER_MIN` | 600 | Peticiones a la API/administración por IP (no incluye páginas estáticas). |
| `LOGIN_RATE_PER_MIN` | 8 | Intentos de login por IP (**compartido entre instancias** con Redis; V3.5.0). |
| `LOGIN_GLOBAL_FAIL_PER_MIN` | 60 | Fallos de login de TODAS las IP juntas por minuto; por encima se **demora** toda respuesta de login (1,75 s, también la correcta) en vez de bloquear: frena un intento distribuido sin dejar fuera al operador. |
| `STATUS_MISS_PER_MIN` | 30 | Consultas públicas a `/api/sessions/:id/status` de sesiones inexistentes por IP/min (límite propio; ya no cuenta contra las uniones WebSocket del NAT). |
| `RATE_LIMIT_BACKEND` | `store` | `store`: los límites de API, login, uniones fallidas y consultas de estado se cuentan en Redis/Valkey y valen para **todas** las instancias (sin Redis = memoria, igual que local). `local`: siempre por proceso (el límite efectivo se **multiplica por el número de instancias**). Ante un fallo de Redis cada instancia sigue limitando en local (ver `SEGURIDAD.md`). |
| `WS_CONNECT_PER_MIN_PER_IP` | 60000 | Upgrades WebSocket por IP (capa 4, muy holgada). Ver "Límites por IP y NAT" en SEGURIDAD.md. |
| `BAD_JOIN_PER_MIN_PER_IP` | 120 | Fallos por IP antes de bloquearla un minuto (capa 3). |

## Contrapresión y apagado

| Variable | Defecto | Descripción |
|---|---|---|
| `WS_BUFFER_SOFT_BYTES` | 65536 | Sobre esto se omite el envío (se reenvía el estado vigente al liberarse). |
| `WS_BUFFER_HARD_BYTES` | 524288 | Sobre esto el cliente se corta (4413). |
| `WS_SLOW_STRIKES` | 5 | Omisiones consecutivas antes de cortar. |
| `BROADCAST_CHUNK` | 500 | Envíos por turno del event loop durante una difusión. |
| `SHUTDOWN_GRACE_MS` | 20000 | Tiempo máximo de apagado (Render: 30 s por defecto). |
| `SHUTDOWN_SPREAD_MS` | 8000 | Ventana en la que se cierran escalonadamente las conexiones al apagar. |
| `PRESENCE_INTERVAL_MS` / `PRESENCE_TTL_MS` | 2000 / 10000 | Publicación y caducidad de la presencia por instancia. |
| `DEGRADED_LOOP_LAG_MS` / `DEGRADED_STORE_MS` | 100 / 250 | Umbrales de estado "degradado". |
| `LOG_LEVEL` | info | `debug`, `info`, `warn`, `error`. |

---

## Añadidos / cambios de la auditoría V3.1 (2026-10-09)

| Variable | Defecto | Descripción |
|---|---|---|
| `COMMAND_HISTORY` | 500 (50–10000) | Ventana de `commandId` recientes por sesión para la idempotencia. |
| `RECONCILE_INTERVAL_MS` | 15000 | Cada cuánto cada instancia compara el estado guardado con el entregado (red de seguridad ante mensajes de pub/sub perdidos). También se dispara al recuperarse el suscriptor. |
| `PRE_HELLO_MAX_PER_IP` | 1000 | Conexiones simultáneas **sin `hello`** por IP (capa 2). |
| `MAX_CONN_PER_IP` | 0 (desactivado) | Conexiones totales por IP (capa 5). |
| `WS_CONNECT_PER_MIN_PER_IP` | **60000** (antes 3000) | Capa 4, solo contra inundaciones absurdas. |
| `BAD_JOIN_PER_MIN_PER_IP` | **120** (antes 30) | Capa 3: fallos (sesión inexistente, token inválido, hello vencido, violaciones de protocolo) por IP. |
| `HTTP_RATE_PER_MIN` | 600 | **Solo API/administración** por IP (antes también páginas estáticas). |
| `HTTP_STATIC_RATE_PER_MIN` | 0 (sin límite) | Páginas y archivos estáticos por IP. |
| `CLOCK_PING_INTERVAL_MS` | **30000** (antes 15000) | Un ping de reloj por cliente cada ~30 s (±15 %). |
| `BROADCAST_CHUNK` | 500 | (de la ronda anterior) |

## App Flash (V3.2)

| Variable | Defecto | Descripción |
|---|---|---|
| `FLASH_DEFAULT_ENABLED` | `false` | Estado **inicial** del acceso a la app Flash (`/flash`, `/?s=CODIGO`). El operador lo cambia desde `/master`; ese valor se guarda en el almacenamiento y **manda** sobre este. Con almacenamiento en memoria, un reinicio vuelve a este valor. |

## Reloj de las marcas de tiempo (V3.4.0)

| Variable | Defecto | Descripción |
|---|---|---|
| `CLOCK_SOURCE` | `store` | `store`: todas las marcas de tiempo (welcome, pong, executeAt) usan la **hora del almacenamiento compartido** (Redis `TIME`), igual para todas las instancias. `local`: reloj del sistema de cada instancia (solo recomendable con una instancia). Con almacenamiento en memoria siempre es el reloj local. Ver `SINCRONIZACION.md`. |
