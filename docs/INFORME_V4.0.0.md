# Informe V4.0.0 — multi-evento, ráfaga de reloj repartida y seguridad visual por defecto

Fecha: 2026-11-05 · Base: V3.5.0 · Entorno de las pruebas: un equipo Windows 11, Node 24.18, Redis 5.0.14 (build de Windows, solo para pruebas), Chrome headless.

> **Qué NO se afirma**: que el sistema soporte 60 000 (ni 72 000) participantes. Esa capacidad **no está demostrada**. Lo medido está en §4 y lo no hecho en §6.

## 1. Qué se auditó antes de tocar nada

Lectura completa de `src/app.js`, `src/hub.js`, `src/store/{memory,redis,common}.js`, `src/config.js`, `src/sessions.js`, `public/js/{remote,master,clock}.js`, `public/master.html`, `render.yaml` y la documentación (`ARQUITECTURA`, `RUTAS`, `VERSIONADO`, `CARGA`, `OPERACION_EVENTO_MASIVO`). Hallazgos que condicionaron el diseño:

* **El aislamiento por sesión ya existía** (sala del hub, canal Redis `ch:<código>`, estado/versión/presencia/acks por código). El multi-evento se construyó **encima**, sin reescribir el núcleo ni cambiar el protocolo v1 ni el formato de QR.
* `clockBurst()` enviaba **6 pings cada 120 ms** al recibir `welcome` (y otra ráfaga completa al volver a primer plano).
* `STROBE_ALLOWED` era `true` por defecto.
* Un único `MASTER_PASSWORD` compartido; sin usuarios ni MFA (riesgo residual ya documentado en V3.5.0).
* La reconciliación del hub **no** cierra salas cuya sesión desapareció (a propósito: así los teléfonos retoman tras un reinicio del almacenamiento).
* Línea base: `npm test` = 224 pruebas, 193 pasan, 28 omitidas (sin Redis), **3 fallan por el entorno** (el `.gitignore` del repositorio padre ignora `.od`, `git ls-files` devuelve 0 archivos y `tools/release.js` no ve el proyecto; ver §5).

## 2. Cambios

| Área | Cambio | Archivos |
|---|---|---|
| **Multi-evento** | Eventos con id interno, nombre, descripción, fecha, estado (borrador/programado/activo/finalizado/cancelado), código público único, QR `/e/CÓDIGO`, configuración (colores, secuencias, efectos permitidos, margen), estadísticas, auditoría, archivado lógico, duplicado, edición con control de concurrencia. | `src/events.js` (nuevo), `src/store/{memory,redis,common}.js`, `src/app.js`, `src/sessions.js` |
| **Aislamiento / política** | El servidor valida por cada orden de un Master que el evento siga activo y que el efecto esté permitido; el margen del evento es un mínimo; los códigos de evento están reservados frente a sesiones sueltas. | `src/hub.js`, `src/sessions.js` |
| **Cierre de eventos** | Mensaje `close` por el bus del evento (todas las instancias), cierre en lotes; `4404` (desactivado, el cliente espera) y nuevo `4410` (terminó, el cliente no reintenta). | `src/hub.js`, `public/js/remote.js` |
| **QR** | `/e/CÓDIGO` (misma página siempre: no enumera), copiar enlace, ver QR, **PNG y SVG**. Los QR antiguos no cambian. | `src/app.js`, `public/flash.html`, `public/js/events-panel.js` |
| **Panel** | Sección «Eventos»: panel general (totales, por evento, instancias, almacenamiento, salud, alertas), detalle, estadísticas en vivo, registro de acciones, operación con **nombre del evento fijo** y confirmaciones que nombran el evento. | `public/master.html`, `public/js/events-panel.js`, `public/js/master.js` |
| **Ráfaga de reloj** | De 6 pings cada 120 ms a **3 pings con jitter en 3 s** (1 al reconectar con reloj ya sincronizado); parámetros en el `welcome` y por variable de entorno. | `public/js/remote.js`, `src/config.js`, `src/hub.js` |
| **Seguridad visual** | `STROBE_ALLOWED=false` por defecto. **Cambio de comportamiento.** | `src/config.js` |
| **Instancias** | Cada instancia se anuncia en el almacenamiento (vence sola): el panel cuenta instancias vivas. | `src/app.js`, stores |
| **Herramienta** | `tools/reloj-rafaga.js`: simulación reproducible de estrategias de ráfaga. | `tools/` |

Documentación: `EVENTOS.md` (nuevo), y actualizadas `CONFIGURACION`, `PROTOCOLO`, `RUTAS`, `SINCRONIZACION`, `SEGURIDAD`, `OPERACION_EVENTO_MASIVO`.

**Compatibilidad**: protocolo WebSocket v1 sin cambios incompatibles (campos nuevos en `welcome.config`; nuevo código de cierre `4410` solo para eventos); QR `/?s=…&mode=remote`, `/flash` y la API de sesiones intactos. **Único cambio de comportamiento para quien ya despliega**: `STROBE_ALLOWED` pasa a `false` (hay que definir `STROBE_ALLOWED=true` para habilitarlo).

Se numera **4.0.0** a pedido ("V4.0"): según la regla de `VERSIONADO.md` (major = rompe protocolo o QR) este cambio sería *minor*; se eligió major por el cambio del valor predeterminado de seguridad visual y por ser un hito funcional.

## 3. Pruebas ejecutadas (resultado real)

| Suite | Resultado |
|---|---|
| `npm test` con `REDIS_SERVER` real (Redis 5.0.14) | **236 pruebas: 233 pasan, 0 omitidas, 3 fallan** — las mismas 3 de la línea base (empaquetado, §5). |
| de ellas, nuevas | `test/eventos.test.js` (9) y `test/eventos-redis.test.js` (3, **Redis real, 2 instancias**). |
| `npm run test:browser` (Chrome real) | **42/42** tras actualizar una prueba (§5). Incluye `e2e/eventos.test.js` nueva. |
| Carga `tools/loadtest.js`, 5 000 clientes, 2 instancias + Redis, **reconexión masiva del 100 %** | **APROBADA** (7 criterios). Ver §4. |
| `npm audit --omit=dev` | 0 vulnerabilidades (producción). |

Cobertura funcional de las pruebas nuevas: validación estricta; ciclo de vida y transiciones inválidas; archivado con confirmación; duplicado; unicidad de códigos (25 en memoria, **40 concurrentes en 2 instancias**); **aislamiento** (dos eventos con participantes y Masters conectados: sin mensajes cruzados, versiones independientes, mismo `deviceId` sin pisarse, token de otro evento rechazado, finalizar A no afecta a B); política de efectos y margen mínimo en el servidor; strobe deshabilitado por defecto; cierre propagado por **Pub/Sub entre instancias** (`4410`); edición concurrente (12 simultáneas → exactamente 1 gana); persistencia tras reiniciar una instancia; QR `/e/` sin oráculo de existencia; compatibilidad con QR antiguos; panel general y alertas; y el flujo completo en navegador (crear → QR PNG/SVG → activar con confirmación que nombra el evento → operar → teléfono por `/e/CÓDIGO` ve el color → finalizar → teléfono «EVENTO FINALIZADO», sin errores de CSP ni de JavaScript).

## 4. Mediciones

**Ráfaga de reloj** (`node tools/reloj-rafaga.js`; **modelo**, no campo; 60 000 teléfonos a la vez):

| | Pings | Pico pings/s | Error de reloj p50/p95/p99 |
|---|---|---|---|
| V3.x (6 × 120 ms) | 360 000 | 600 000 | 7,4 / 31,6 / 52,8 ms |
| **V4.0 (3 con jitter en 3 s)** | **180 000** | **61 390** | 8,3 / 35,8 / 59,7 ms |

≈ 10× menos pico de carga a cambio de ≈ +4 ms (p95) / +7 ms (p99) de error de reloj *en el modelo*. Ver `SINCRONIZACION.md` para las alternativas (2 y 1 ping; 6 repartidos).

**Carga 5 000 clientes, 2 instancias + Redis** (`loadtest-results/v4/5000-i2.json`): 5000/5000 conectados (conexión p50/p95/p99 = 51/73/90 ms); 25 000/25 000 entregas, 0 pérdida, 0 duplicados, 0 fuera de orden; distribución p50/p95/p99 = 88/168/190 ms; **reconexión masiva de 5 000: 5000/5000 recuperados en 12,7 s**; lag del event loop p99 máx. 48 ms; RSS pico 123 MB por proceso (2 500 conexiones cada uno); 0 errores de almacenamiento. **Salvedad de la propia herramienta**: el generador de carga (un solo proceso) estaba saturado, por lo que las latencias y el criterio 5 «no son concluyentes». Es el mismo orden de magnitud que la corrida V3.x equivalente (`CARGA.md`: 54/102/157 ms de conexión, 89/182/197 ms de distribución): **sin regresión observable**, no una mejora demostrada.

## 5. Notas honestas sobre las pruebas

* **Las 3 pruebas rojas** (`el repositorio REAL cumple su propia política…`, `paquete: incluye el código…`, `release.run: exige una nota…`) fallan igual **antes y después** de V4: dependen de `git ls-files`, y en este equipo el proyecto vive dentro de `.od`, que el `.gitignore` del repositorio padre ignora. No indican un defecto del código; sí significa que `npm run release` no funciona tal cual en este directorio (se generó el ZIP con la API de `tools/release.js` con `useGit:false`, que aplica las mismas listas de exclusión y la verificación de CRC).
* **Pruebas modificadas** (no se eliminó ninguna): (a) `test/helpers.js` ahora arranca los servidores de prueba con `strobeAllowed: true` explícito (cuatro pruebas del efecto strobe asumían el valor predeterminado anterior; `eventos.test.js` prueba el nuevo valor predeterminado); (b) `e2e/browser.test.js` («E2E carga…») esperaba 6 pings en el primer segundo: se actualizó a 3 repartidos en la ventana del `welcome`, manteniendo la comprobación del ping periódico.
* `npm audit` completo marca 1 alta en `zod` (transitiva de `puppeteer-core`, solo pruebas, no empaquetada).

## 6. Lo NO demostrado o NO hecho

1. **60 000 / 72 000 conexiones simultáneas: no probado.** El máximo reproducido con el código V4 es 5 000 (2 instancias + Redis) en un solo equipo Windows; el máximo histórico del proyecto es 10 000 en 4 procesos. No se extrapola. El plan de reparto (8–12 procesos) es un dimensionamiento de partida (`OPERACION_EVENTO_MASIVO.md`), **no** una capacidad medida. Falta una prueba en la infraestructura real (Linux/Render, generador distribuido).
2. **Redis lento** (latencia inyectada) y **reinicio de Redis con pérdida de datos durante un evento activo**: no probados. Sí se probaron: Redis caído y recuperado, pérdida del suscriptor, reinicio de una instancia, cierre por Pub/Sub entre instancias.
3. **Caída de una instancia durante una orden bajo carga**: no probada (solo reinicio de una instancia en pruebas de 2 instancias).
4. **MFA y permisos por evento: NO implementados.** Contraseña compartida única; cualquier operador autenticado gestiona todos los eventos; la auditoría identifica la sesión de operador (`op:<jti>`), no a la persona. Es un cambio de contrato de autenticación que requiere diseño y pruebas propias (ver `SEGURIDAD.md`).
5. **Valkey y el entorno real de Render**: no probados; no se revisó la configuración viva de Render.
6. **Teléfonos físicos, redes móviles y estadio**: sin ensayo; el error de reloj es un modelo.
7. **Optimización de Redis**: se revisó y no se encontró un cuello de botella a la escala medida (1 `EVAL` + `PUBLISH` por orden, nada por teléfono, 2 conexiones por proceso, una suscripción por evento y por instancia); el único costo nuevo es 1–2 lecturas del evento por orden humana. No se hizo perfilado de Redis bajo 60 000 conexiones.
8. **Métricas Prometheus por evento**: no se añadieron etiquetas por evento (cardinalidad); las estadísticas por evento salen de la API.
9. **Borrado físico** de eventos: no existe (archivado lógico por diseño).
10. **Tablero**: el panel de infraestructura muestra el número de instancias vivas y el estado de salud de la instancia que responde, no la salud individual de cada una.

## 7. Cómo desplegar y volver atrás

Despliegue: sin pasos nuevos. Opcionales: `STROBE_ALLOWED` (ahora `false`), `CLOCK_BURST_COUNT`, `CLOCK_BURST_COUNT_RESYNC`, `CLOCK_BURST_WINDOW_MS`, `MAX_EVENTS` (`CONFIGURACION.md`). Con un solo proceso en memoria los eventos **se pierden al reiniciar**; con Redis/Valkey persisten (usar un Key Value **con persistencia**). Rollback: desplegar el ZIP de V3.5.0 (los eventos creados quedan en Redis, inertes; las sesiones y QR antiguos siguen funcionando).
