# Informe final — Destello Sync V3.1 (2026-10-09)

## 1. Resumen

Se auditó y reescribió el backend y los clientes de sincronización **conservando** las rutas (`/`, `/master`, `/?s=CODIGO&mode=remote`, `/ws`, `/healthz`),
la interfaz de la app del público y el formato de los QR. Se pasó de un único `server.js` sin pruebas a un backend modular, con protocolo versionado y validado,
autenticación del Master, estado autoritativo, ejecución programada, Redis opcional para varias instancias, observabilidad, apagado ordenado, 54 pruebas automáticas,
2 pruebas E2E en Chrome real y una herramienta de carga.

**No se afirma** que esté listo para 60 000 dispositivos: no hay pruebas que lo demuestren (ver §6 y §8).

## 2. Archivos

Commit base (`48bbb12`) = contenido exacto del zip. Cambios (`git diff --stat 48bbb12 HEAD`: 56 archivos, +6 298 / −848):

* **Nuevos**: `src/{app,hub,protocol,auth,config,logger,metrics,ratelimit,sessions}.js`, `src/store/{index,common,memory,redis}.js`,
  `public/js/{effects,remote,master,qrcode}.js`, `public/favicon.svg`, `test/*.test.js` + `test/helpers.js`, `e2e/browser.test.js`, `tools/loadtest.js`,
  `docs/*.md`, `loadtest-results/*.json`, `.gitattributes`, `package-lock.json`.
* **Modificados**: `server.js` (ahora solo arranque, señales y cluster opcional), `public/index.html` (se reemplazó solo el bloque remoto y su marcado/CSS; el modo micrófono no se tocó),
  `public/master.html` (panel nuevo, con el mismo aspecto), `package.json`, `render.yaml`, `.env.example`, `README.md`.
* **Eliminados** (documentación obsoleta, sigue en el historial de Git): `README-RENDER.md`, `README-V3.md`.
* No se eliminó código de funcionalidad: el SSE ya no existía en el zip; la lógica de la V3.0 se reemplazó por equivalentes (y el adaptador V3.0 para participantes).

## 3. Migraciones / compatibilidad

* Sin base de datos: no hay migraciones. El estado vive en memoria o Redis con TTL.
* **Cambios incompatibles (intencionales)**: `POST /api/sessions` y el Master ahora exigen autenticación (contraseña de operador) y el token de Master ya no va en la URL. El panel V3.0 no funciona con el servidor nuevo.
* **Compatible**: páginas del público V3.0 ya abiertas (adaptador `/ws?session=&role=public`), URL pública, `/master`, QR/enlaces `…/?s=CODIGO&mode=remote`, `process.env.PORT`, campo `code` de la respuesta de creación de sesión.

## 4. Pruebas ejecutadas (resultados reales)

| Conjunto | Comando | Resultado |
|---|---|---|
| Efectos (unitarias) | `test/effects.test.js` | 7/7 |
| Funcionales | `test/funcional.test.js` | 10/10 |
| Seguridad | `test/seguridad.test.js` | 15/15 |
| WebSocket / resiliencia | `test/websocket.test.js` | 13/13 |
| Compatibilidad V3.0 | `test/compat.test.js` | 3/3 |
| Distribución (2 instancias + **Redis 5.0.14 real**) | `test/distribucion.test.js` | 6/6 con `REDIS_SERVER`; **6 omitidas (skipped) sin él** |
| **Total** `npm test` (con Redis) | | **54 pasan, 0 fallan, 0 omitidas (116 s)** |
| E2E Chrome real | `npm run test:browser` | **2/2**: 10 "teléfonos" aislados, color/pulso/strobe/Esc/corte y reconexión; reinicio del servidor sin Redis |
| CSP | carga de `/`, `/?s=…`, `/master` en Chrome | 0 violaciones |
| `npm audit` | | 0 vulnerabilidades |

Cubre: crear sesión, múltiples dispositivos, color, efectos y parada, aislamiento, el Master no cuenta, recuperación tras reconectar, desconexión inesperada, heartbeat fallido, mensajes malformados/grandes/binarios,
orden duplicada y fuera de secuencia (versiones monotónicas), cliente lento (contrapresión con socket simulado), reinicio/apagado ordenado, reconexión simultánea (400 clientes), Master no autenticado, participante que manda órdenes admin,
token inválido/vencido/revocado, acceso a otra sesión, abuso de frecuencia, Origin no autorizado, y la entrega entre instancias (una orden en A llega a B y viceversa) con presencia, acks y estado agregados y Redis caído/recuperado.

Medición en navegador real (desktop, mismo equipo/reloj): desviación entre el instante programado y la aplicación visual **1–6 ms** en 10 contextos de Chrome (`e2e`). **No** es representativa de teléfonos reales ni de redes móviles.

## 5. Hallazgos

### Corregidos
Los 10 listados en `ARQUITECTURA.md` (§ "Defectos"), más los hallados durante las pruebas:
a) un teléfono que se conectaba durante el margen de una orden podía mostrarla **antes** de tiempo (visto como −1 398 ms en el E2E) → se programa para su `executeAt` y mientras tanto muestra pantalla apagada;
b) un fallo de Redis en una orden dejaba una promesa sin atrapar → ahora responde `PUBLISH_FAILED`;
c) `/api/admin/status` fallaba con 500 si Redis estaba caído → degrada;
d) respuesta 413 abortaba el socket antes de responder → ahora responde y drena;
e) favicon 404 en consola.

### Pendientes / no verificados
1. **60 000 dispositivos: no probado.** Máximo probado: 10 000 conexiones (4 instancias, un equipo), sin cumplir los umbrales de latencia por límites del propio equipo de prueba.
2. Nada probado en **Linux/Render**, ni con **Valkey** real (solo Redis 5.0.14 para Windows), ni el Blueprint `render.yaml` (la sintaxis `type: keyvalue` + `fromService` no se pudo ejecutar; verificar en el primer despliegue).
3. **Dispositivos reales** (iPhone/Safari, Android/Chrome): no probados; sí Chrome desktop emulando móvil. Wake Lock, pantalla bloqueada, cambio Wi-Fi↔datos: solo simulado (offline en CDP).
4. Reloj entre instancias (NTP de los hosts de Render): no medido.
5. El **modo micrófono** de la app (no modificado) no se re-probó funcionalmente; solo se comprobó que la página carga sin violaciones de CSP.
6. Las advertencias del panel Master (salud/llegadas tardías) están implementadas y alimentadas por pruebas de servidor, pero la UI de esas alertas no tiene prueba E2E propia.
7. Corte masivo de 10 000 clientes en un equipo Windows: no concluyente.
8. Precios de Render: no se obtuvieron.
9. Sin autenticación individual de operadores ni MFA (contraseña compartida).

## 6. Criterios de aceptación (§18 del encargo)

| Criterio | Estado | Evidencia |
|---|---|---|
| Todos los clientes de una sesión reciben las órdenes | Cumplido hasta lo probado (10 000 conexiones, 0 % de pérdida) | `CARGA.md`, tests |
| Sesiones aisladas | Cumplido | `funcional` |
| Master autenticado y autorizado | Cumplido | `seguridad` |
| Estado vigente se recupera tras desconexión | Cumplido | `funcional`, `distribucion`, E2E |
| Órdenes antiguas no sobrescriben las nuevas | Cumplido (versión monotónica en servidor y cliente) | `funcional`, `distribucion` |
| Efectos se detienen de forma fiable | Cumplido (parada prioritaria, sin límite de tasa; strobe con duración máxima) | `websocket`, E2E |
| Conexiones muertas se detectan y limpian | Cumplido | `websocket` (heartbeat, desconexión) |
| Despliegues/reinicios con procedimiento de recuperación | Cumplido y probado (apagado ordenado, reconexión, re-creación de sesión) | `websocket`, E2E, `DESPLIEGUE_RENDER.md` |
| Pruebas de seguridad y funcionalidad pasan | Cumplido | 54/54 + 2/2 |
| **Pruebas de carga cumplen los umbrales para el evento** | **NO cumplido** (el evento de 60 000 no se probó; 5 000 en 1 proceso y 10 000 en 4 instancias no cumplen todos los umbrales en este equipo) | `CARGA.md` |
| Se conocen los límites de la infraestructura contratada | Parcial: límites de Render verificados en su documentación; precios y comportamiento real no | `DESPLIEGUE_RENDER.md` |
| Plan operativo de emergencia y rollback | Cumplido (documentado) | `DESPLIEGUE_RENDER.md`, `OPERACION_EVENTO_MASIVO.md` |

**Veredicto**: apta para pruebas de campo y eventos pequeños/medianos con la configuración recomendada; **no** declarada lista para un evento de 60 000 hasta completar una prueba de carga en la infraestructura real.

## 7. Riesgos residuales

Ver `SEGURIDAD.md` (contraseña compartida, NAT, DoS volumétrico) y `OPERACION_EVENTO_MASIVO.md` (ancho de banda, red del lugar, suspensión en segundo plano de iOS/Android, plan Free dormido).
Además: una sola ejecución por fila de carga (sin repeticiones); los criterios de latencia usan reloj de loopback.

## 8. Qué falta para operar a gran escala

Prueba de carga distribuida en Linux sobre la infraestructura contratada (≥ 1,2 × audiencia), Key Value de plan pago, ≥ 2 instancias con CPU suficiente, ensayo con teléfonos reales,
ajuste de `WS_CONNECT_PER_MIN_PER_IP`/`COMMAND_LEAD_MS`, y congelar despliegues. Detalle en `OPERACION_EVENTO_MASIVO.md`.
