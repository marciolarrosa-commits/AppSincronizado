# Informe de la auditoría V3.1 (2026-10-09)

Detalle de cada hallazgo (archivo, función, reproducción, corrección): `AUDITORIA_V3.1.md`. Semántica del protocolo: `PROTOCOLO.md`. Carga: `CARGA.md`.

## 1. Resumen ejecutivo

Se verificó en el código real y se reprodujo cada problema antes de corregirlo. Los dos puntos de máxima prioridad **estaban presentes** y se corrigieron:

* **ACK del Master** (`master.js`): confirmado. Un ACK tardío de A borraba el pendiente B; si B se perdía y caía la conexión, la orden se perdía en silencio (reproducido en Chrome real sobre el código original: el servidor quedó en la versión 1).
* **Idempotencia** (`redis.js` y memoria): confirmado. A, B y el reenvío de A volvían a aplicar A (reproducido en memoria, Redis real y entre dos instancias).

Además aparecieron **otros dos problemas críticos/altos no previstos**: pérdida silenciosa de órdenes si la sesión se re-crea con el hub vivo (p. ej. reinicio del Key Value gratuito) y sesiones a medio crear en Redis que envenenan el código; y un hueco de consistencia por el pub/sub "como máximo una vez". Se corrigió el generador de carga (agregación) y los límites por IP que dejaban sin servicio a un público detrás de NAT.

**Estado**: todas las correcciones están **en el árbol de trabajo, sin commit, sin push y sin despliegue** (a la espera de tu autorización). **No** se declara lista para 60 000 dispositivos.

## 2. Resuelto / parcial / pendiente

| Estado | Ítem |
|---|---|
| **Resuelto** | C1 idempotencia con ventana de commandId · C2 `incarnation` (sesión re-creada) · A1 ACK/pendientes del Master · A2 creación atómica de sesión · A3 agregación del generador · A4 límites por IP/NAT (incluye HTTP estático) · A5 reconciliación de pub/sub · M1 bucle de render (batería) · M2 pings · M3 `ackRate` global · M4 Host/XFP · M5 configuración efectiva de Redis verificable · M6 buckets de histogramas · validación de payload y tope de strobe en el cliente |
| **Parcial** | Precisión temporal: medida (1–9 ms en red simétrica; **193 ms** con asimetría 400/20 ms), pero el error por asimetría **no se corrige**. Límites por IP: el login del operador sigue vulnerable a agotamiento por otra persona del mismo NAT (documentado). Carga: sin pérdidas hasta 10 000, pero latencia fuera de criterio desde 5 000 en este equipo (generador saturado). |
| **Pendiente** | 60 000 · Linux/Render · Valkey real · dispositivos móviles reales · Redis Cluster (claves sin hash tags) · autenticación individual/MFA · prueba de strobe con personas |

## 3. Archivos modificados (21 modificados + archivos nuevos; sin commit)

**Servidor**: `src/store/redis.js` (Lua de idempotencia con ventana, creación atómica, vista tolerante, reconciliación al resuscribirse, costura `_test`) · `src/store/memory.js` (ventana de commandId) · `src/store/common.js` (`incarnation`) · `src/hub.js` (incarnation, reconciliación, límites por IP, presencia global, contadores internos, fix del log de duplicados) · `src/app.js` (límite HTTP solo para API, Host/XFP seguros, configuración de almacenamiento enmascarada, `hub.internals`) · `src/config.js` (variables y valores por defecto nuevos) · `src/protocol.js` (`incarnation` en `state`) · `src/metrics.js` (buckets).
**Cliente**: `public/js/pending.js` (nuevo: rastreador de comandos) · `public/js/master.js` (usa el rastreador, ACK por id, stop rastreado) · `public/master.html` · `public/js/remote.js` (bucle de render a demanda, ping único con jitter, incarnation, validación, temporizadores de desconexión) · `public/js/effects.js` (clamps y `validPayload`).
**Herramientas/pruebas**: `tools/loadtest.js` (reescrito) · `scripts/check-syntax.js` · `test/{idempotencia,robustez,pending,auditoria,loadtest}.test.js` · `test/effects.test.js` (+3) · `e2e/{master-ack,red-movil}.test.js` · `e2e/browser.test.js` (+3) · `package.json` (scripts) · `loadtest-results/v2/*.json` · documentación (`AUDITORIA_V3.1.md`, `PROTOCOLO.md`, `CONFIGURACION.md`, `SEGURIDAD.md`, `OBSERVABILIDAD.md`, `DESPLIEGUE_RENDER.md`, `CARGA.md`, este informe).
No se agregaron dependencias (`ioredis` 6.0.0 existe como versión mayor: **no** se actualizó a ciegas; `npm audit`: 0 vulnerabilidades).

## 4. Pruebas ejecutadas (comandos y resultados reales, 2026-10-09)

| Orden | Comando | Resultado |
|---|---|---|
| 1 Sintaxis | `npm run check` | 36 archivos OK |
| 2–6 Unitarias, integración, protocolo, reconexión, ACK/idempotencia | `REDIS_SERVER=<redis-server> npm test` | **94 / 94 pasan, 0 omitidas** (231 s): efectos 10 · rastreador de ACK 14 · funcional 10 · seguridad 15 · WebSocket 13 · compatibilidad 3 · idempotencia 3 · robustez 5 · auditoría 12 · distribución 6 · generador 3 |
| 7 E2E Chrome real | `npm run test:browser` | **14 / 14 pasan** (143 s): navegador 5 · ACK del Master 3 · red móvil 6 |
| 8 Carga local aislada | `tools/loadtest.js` (ver `CARGA.md`) | 6 etapas ejecutadas; veredictos en §6 |
| 9 Revisión del diff | `git diff --stat` | 21 archivos modificados (+722/−175) más los nuevos |

Pruebas **sin Redis** (`npm test` sin `REDIS_SERVER`): las que lo requieren se **omiten y se informa**; no se cuentan como pasadas. **Redis usado**: 5.0.14 (port de Windows). **No verificado**: Valkey 8.

Reproducciones "en rojo" antes de corregir (todas pasaron a verde): idempotencia (3), sesión perdida (1), sesión a medio crear (1), suscriptor caído (2), límite HTTP/NAT (1), `Host` (1, falló por un error de mi propio parche y se corrigió), ACK original (script contra el `master.js` original), bucle de render (121 frames/2 s con color fijo → ≤ 3).

Descartado con medición: pre-codificar el mensaje como `Buffer` (no mejora: 51,9 vs 56,7 µs/envío).

## 5. Pruebas pendientes y motivo

Linux/Render y generador distribuido (no hay entorno); Valkey real (no disponible); dispositivos iPhone/Android reales; 60 000 conexiones; Redis Cluster; prueba de efectos con personas; reconexión masiva de 10 000 en Windows (límite de puertos del SO).

## 6. Carga y comparación

Ver tabla completa en `CARGA.md` ("Ronda de la auditoría V3.1"). Resumen: 100 y 1 000 conexiones (1 proceso) **APROBADAS**; 5 000 (1 proceso, 2 instancias + Redis y 4 procesos + Redis) y 10 000 (4 instancias + Redis) **NO aprobadas** por latencia/tiempo de conexión **con el generador saturado** (no concluyente); pérdida 0 en todas.
**Comparación con la ronda anterior**: solo es válida para las métricas del lado cliente y los picos. La aprobación anterior de 5 000 en 2 instancias **no se reproduce** (variación entre corridas). Los contadores del servidor de las corridas multi-instancia anteriores eran parciales (bug A3).

## 7. Riesgos que permanecen

* Contraseña única del operador, sin MFA; login limitable por otra persona del mismo NAT.
* Sin pruebas en Linux/Render ni con teléfonos reales; error de reloj por asimetría de red (~mitad de la asimetría).
* Redis gratuito de Render: sin persistencia y 50 conexiones; el pub/sub es "como máximo una vez" (mitigado con reconciliación cada 15 s, no instantáneo).
* Un Redis que pierde datos reinicia las versiones de la sesión: mitigado con `incarnation`, pero requiere que el panel re-cree la sesión.
* Claves de Redis sin hash tags (no apto para Redis Cluster).
* Un solo equipo para toda la carga; una ejecución por fila.

## 8. Capacidad demostrada vs no demostrada

| Demostrada (en este equipo) | No demostrada |
|---|---|
| 0 % de pérdida y estado correcto con 10 000 conexiones (4 instancias + Redis) | 60 000; 5 000+ dentro de los criterios de latencia |
| Todos los criterios cumplidos hasta 1 000 conexiones (1 proceso) | Rendimiento en Linux/Render, redes móviles y dispositivos reales |
| Recuperación tras corte masivo de 100/1 000/5 000 clientes | Reconexión masiva de 10 000 |
| Idempotencia, ACK y estado correctos entre 2 instancias con Redis real | Comportamiento con Valkey 8 y con el Key Value gratuito de Render |

## 9. Configuración recomendada

Ver `DESPLIEGUE_RENDER.md` ("Configuraciones recomendadas por entorno") y `CONFIGURACION.md`. En producción: `NODE_ENV=production`, `MASTER_PASSWORD` ≥ 12 caracteres, `PUBLIC_BASE_URL`, `REDIS_URL` (Key Value pago, 2 conexiones por proceso), plan pago siempre activo, `COMMAND_LEAD_MS` 2000–3000 para audiencias grandes y verificar `/api/admin/status → store.config` antes del evento.

## 10. Próximos pasos priorizados

1. Autorizar el commit de estos cambios (y, si querés, un tag) tras revisar el diff.
2. Prueba de carga distribuida en Linux sobre un staging equivalente a producción (generador fuera de Render, varias máquinas), repetida ≥ 3 veces por etapa.
3. Probar con Valkey 8 (Key Value de Render) y verificar la sintaxis del Blueprint.
4. Ensayo con ~20 teléfonos reales (iOS/Android, Wi-Fi y datos) midiendo la desviación visual.
5. Evaluar corrección de asimetría del reloj (p. ej. muestreo con RTT mínimo en ambos sentidos no es posible; considerar tolerancia mayor en `leadMs`).
6. Añadir autenticación individual/MFA del operador y segundo operador en otra red.
7. Decidir sobre `ioredis` 6 (versión mayor) con sus propias pruebas.

## 11. Confirmación

**No se realizaron despliegues, pushes, commits ni operaciones destructivas** durante esta fase. Los cambios están sin commit en el árbol de trabajo. Para reproducir los defectos originales se usó `git stash` temporalmente sobre dos archivos del cliente y se restauró de inmediato (la lista de stash quedó vacía). No se ejecutaron pruebas de carga contra servicios externos ni contra producción; Redis de pruebas fue un binario local (fuera del repositorio).
