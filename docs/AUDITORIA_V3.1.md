# Auditoría técnica de V3.1 (2026-10-09)

Base: commit `289bbac` (tag `v3.1.0`). Cada hallazgo se **verificó en el código real y se reprodujo con una prueba o medición** antes de corregirlo.
Los cambios están en el árbol de trabajo, **sin commit** (a la espera de autorización).

## Problemas confirmados, por gravedad

### Críticos

| # | Problema | Archivo / función | Reproducción (antes de corregir) | Impacto | Corrección |
|---|---|---|---|---|---|
| C1 | **Reenviar un comando antiguo revierte el estado.** La idempotencia solo comparaba el `commandId` con el **último** guardado. | `src/store/redis.js` (`APPLY_LUA`), `src/store/memory.js` (`applyState`) | `test/idempotencia.test.js`: A, B, reenvío de A → `duplicate:false`, versión 3 con el color de A (memoria, Redis real y entre dos instancias). | El Master reintenta A (no recibió su ACK) y las pantallas vuelven al color viejo. | Ventana acotada de `commandId` recientes por sesión (500, `COMMAND_HISTORY`), atómica en Lua / en el mismo turno en memoria. El duplicado devuelve la versión **original** y no se publica. |
| C2 | **Pérdida silenciosa de órdenes si una sesión se re-crea con el hub vivo** (p. ej. el Key Value gratuito se reinicia). El hub guardaba `lastDeliverVersion=3` y descartaba las versiones 1,2,3 de la sesión nueva; el Master veía "aceptada". Los teléfonos tenían el mismo problema (descartaban versiones "viejas"). | `src/hub.js` (`deliver`/`onBus`), `public/js/remote.js` (`onState`) | `test/robustez.test.js` (Redis real + `FLUSHALL`): el teléfono nunca recibe la orden (timeout). | Un evento entero sin respuesta de las pantallas, sin error visible. | Cada estado lleva `incarnation` (instante de creación de la sesión); hub y clientes reinician su línea base cuando cambia. |

### Altos

| # | Problema | Archivo | Reproducción | Corrección |
|---|---|---|---|---|
| A1 | **ACK del Master:** `case 'ack'` hacía `S.inflight = null` sin mirar el `commandId`. El ACK tardío de A borraba el pendiente B; `stop` ni siquiera se rastreaba; A y B se pisaban. | `public/js/master.js` (`onMessage`, `sendCommand`) | Chrome real + WebSocket defectuoso (`$TEMP/old_bug.js` sobre el `master.js` original): A llega y su ACK se retiene; B se pierde en el camino; llega tarde el ACK de A; cae la conexión → **el servidor queda en versión 1: B se perdió** y el panel no lo sabe. | Nuevo `public/js/pending.js`: comandos rastreados por id, "el último gana", reintento con el mismo id (máx. 3), reenvío tras reconectar solo del más reciente y reciente (≤ 15 s), ACK `ok/late/duplicate/unknown` clasificado. |
| A2 | **Sesión a medio crear en Redis:** `HSETNX` + `MULTI` no eran atómicos; una caída entre ambos dejaba una clave sin estado **ni TTL** y el código quedaba envenenado (`JSON.parse(undefined)` al unirse; `SESSION_EXISTS` al re-crear). | `src/store/redis.js` (`createSession`, `view`) | `test/robustez.test.js`: `409 SESSION_EXISTS` y error al unirse. | Creación en un único script Lua; un registro incompleto se trata como inexistente. |
| A3 | **Generador de carga:** `lastStatus` se sobrescribía por instancia: contadores, bytes e histogramas reflejaban solo la **última** instancia. | `tools/loadtest.js` (`poll`) | Datos reales de la ronda anterior (`loadtest-results/5000-i2.json`): `ws_connections_total: 5000` (real: 10 000), `serverReportedPublic: 2500` de 5 000; `10000-i4`: 2 500 de 10 000. | Vista por proceso + agregación (suma de acumulados una vez por proceso, suma de buckets, picos máximos), configuración efectiva leída del servidor, entorno controlado. |
| A4 | **Límites por IP con falsos positivos en NAT:** `WS_CONNECT_PER_MIN_PER_IP=3000` corta a ~85 % de un estadio detrás de un NAT; `BAD_JOIN=30` bloquea a todo un NAT por 30 códigos mal escritos. | `src/config.js`, `src/app.js` | `test/auditoria.test.js` (3 500 uniones desde una IP). | Límites por capas (ver `SEGURIDAD.md`). |
| A5 | **Pub/sub de Redis es "como máximo una vez":** si el suscriptor de una instancia se cae un instante, esa instancia pierde órdenes y sus teléfonos quedan con estado viejo hasta la próxima orden. | `src/store/redis.js`, `src/hub.js` | `test/robustez.test.js` (suscriptor caído y restaurado). | Reconciliación: al volver el suscriptor y cada `RECONCILE_INTERVAL_MS` se compara la versión del almacenamiento con la entregada y se entrega el estado vigente. |

### Medios

| # | Problema | Evidencia | Corrección |
|---|---|---|---|
| M1 | **Batería/CPU:** el cliente mantenía un `requestAnimationFrame` a 60 fps **para siempre** con un color fijo. | Medido en Chrome: **121 frames en 2 s** con color fijo. | El bucle solo corre mientras hay animación u orden pendiente: **≤ 3 frames en 2 s** con color fijo; pulso/transición ≈ 30 fps; strobe 60 fps. |
| M2 | **3 pings de reloj por cliente cada 15 s** (12 000 msg/s entrantes con 60 000 teléfonos). | Código; medido en navegador. | 1 ping cada ~30 s (±15 % jitter): ≈ 2 000/s. Medido: 1 por intervalo. |
| M3 | `ackRate` se calculaba con el conteo **local** en instancias sin Master → hasta K× más confirmaciones de las buscadas. | `test/auditoria.test.js` (Redis, 2 instancias: 0,5 vs 0,25). | Todas las instancias leen la audiencia global. |
| M4 | `Host` y `X-Forwarded-Proto` se reflejaban sin validar en la CSP y en el enlace del QR. | `test/auditoria.test.js`. | Validación estricta (solo nombre/puerto; solo http/https). |
| M5 | La configuración efectiva de Redis no se podía verificar; el informe de carga confiaba en `--redis`. | Código. | `/api/admin/status` y el log de arranque informan `store.config` con la URL **enmascarada**; el generador no hereda `REDIS_URL`/`CLUSTER_WORKERS` y compara lo efectivo con lo pedido. |
| M6 | Los histogramas no se podían agregar entre instancias. | Código. | `/api/admin/status` publica los buckets. |

### Descartados / sin cambio (con medición)

* **Pre-codificar el mensaje como `Buffer`** para acelerar la difusión: medido (3 000 sockets, 6 repeticiones): `string` 51,9 µs/envío vs `Buffer` 56,7 µs. **No mejora → no se aplicó.** Escribir tramas directo al socket (API privada de `ws`) ganaba ≤ 35 % y se descartó por fragilidad.
* Reducir `ws.send` por lotes más pequeños: ya implementado (`BROADCAST_CHUNK=500`).
* Fugas de listeners/temporizadores: se probó (1 500 ciclos, 6 sesiones) y **no se encontraron**: todas las estructuras internas vuelven a cero (`test/auditoria.test.js`).

## Pendientes conocidos (no corregidos en esta fase)

* Las claves de Redis no usan *hash tags*: **no compatible con Redis Cluster** (Render Key Value es de un solo nodo).
* Sin autenticación individual de operadores ni MFA.
* La mitigación de strobe se prueba a nivel de código (límites en servidor y cliente), no con pruebas con personas.
* No se probó en Linux/Render ni con dispositivos móviles reales (ver informe final).

## Seguimiento (2026-10-09)

* **Commit y etiqueta** aplicados tras la autorización: `48dbb1a` (`v3.1.1-auditoria`). No hay remoto Git configurado: no hubo push ni despliegue.
* **`ioredis` 6.0.0 evaluado en una copia aislada** (fuera del repositorio): las 14 pruebas con Redis real (idempotencia, robustez, distribución) **pasan** con la versión 6. No se adoptó: no aporta una mejora demostrada y es una versión mayor; la 5.11.1 queda fijada. Si se decide migrar, hacerlo en un cambio aparte con esta misma batería.
