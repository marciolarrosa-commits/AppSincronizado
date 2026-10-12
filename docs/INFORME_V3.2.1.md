# Informe V3.2.1: ciclo de vida finito de las órdenes y corrección de efectos

Versión 3.2.0 → **3.2.1**. Entorno de las pruebas: Windows 11, Node 24.18, Chrome 154, Redis 5.0.14 (port de Windows). **Nada se ejecutó en iPhone/Android físicos ni contra Render.** Detalle del protocolo: `PROTOCOLO.md` («Ciclo de vida de una orden»).

## 1. Diagnóstico (causa real, efecto por efecto)

Recorrido verificado de punta a punta (panel → servidor → almacenamiento/publicación → teléfono → evaluación del efecto → confirmación) con el panel y el teléfono REALES en Chrome, con el servidor en memoria y con Redis real entre dos instancias.

| Efecto | Qué se verificó | Resultado / causa |
|---|---|---|
| **Fijo (`solid`)** | validación, `ack`, publicación, recepción, color mostrado | Correcto. Sin defecto. |
| **Transición (`fade`)** | con los parámetros por defecto del panel (`color`, `color2`, `fadeMs` 500) | **El servidor, Redis y el cliente funcionan** (aceptada, publicada, llega íntegra a otra instancia, el teléfono pasa de `color` a `color2` en `fadeMs` y se queda). **No pude reproducir un fallo propio de Transición con valores por defecto.** Lo que sí produce «ENVIANDO…» para siempre (causas B y C): un valor fuera de rango tecleado (`fadeMs` > 10 000 → `OUT_OF_RANGE`), un descarte por límite de frecuencia o un error sin identificador. |
| **Pulso (`pulse`)** | `periodMs` 2000, `durationMs` 10 000, `color2` | Igual que Transición: correcto con valores por defecto; falla de forma visible solo por las causas B/C (p. ej. `periodMs` < 600). |
| **Strobe** | habilitación, `hz`, `duty`, duración, límites | **Causa cierta**: viene **deshabilitado por defecto** (protección de fotosensibilidad). El servidor respondía `STROBE_DISABLED` *con `commandId`* pero el panel solo mostraba una alerta de 6 s y dejaba `kAccepted` en `ENVIANDO…` (**causa C**). Además el panel permitía duraciones de strobe de hasta 600 s mientras el servidor admite 30 s (`MAX_STROBE_DURATION_MS`): cualquier valor > 30 s era rechazado (**causa D, desajuste panel↔servidor**). |

Causas transversales encontradas y corregidas (cada una reproducida):

* **A. Descarte sin respuesta (`hub.js`)**: al superar el límite general de mensajes, la orden se descartaba sin contestar → el panel la dejaba pendiente.
* **B. Errores sin identificador (`hub.js`)**: `protoError()` no llevaba `commandId` y además **suprimía todo error si había otro hace < 1 s**; los errores de orden reflejaban `msg.commandId` crudo (`|| null`) sin validarlo.
* **C. Indicador desacoplado del resultado (`master.js`)**: `kAccepted` solo se escribía al enviar y al recibir `ack`; un `error` o el agotamiento de reintentos no lo actualizaban; una orden en cola sin conexión no caducaba nunca.
* **D. Panel ↔ servidor**: duración de strobe (600 s vs 30 s).
* **E. Cliente remoto (`remote.js`, preexistente)**: al cargar, `pageshow` → `onVisible()` mientras el primer WebSocket aún conectaba programaba una **reconexión innecesaria que cerraba el socket sano**. Una orden enviada en esa ventana llegaba por la bienvenida como estado «inicial» y **ese teléfono no informaba `applied`** → el panel quedaba en «esperando confirmaciones» sin fin.
* **F. Confirmaciones (`hub.js`)**: `applied` no se validaba contra el `commandId` de esa versión ni se deduplicaba por dispositivo.

**Limitación honesta**: sobre los síntomas exactos de Transición y Pulso en producción, no puedo afirmar cuál de B/C/E fue la que viste (no tengo acceso a tu Render ni a sus logs). El panel nuevo muestra ahora `RECHAZADA: CÓDIGO — motivo` o `SIN CONFIRMACIÓN`, así que la próxima prueba lo dirá explícitamente; el contador `commands_rejected`/`protocol_errors` de `/metrics` y los logs `command_accepted` lo confirman en el servidor.

## 2. Archivos modificados (desde 3.2.0)

| Archivo | Cambio |
|---|---|
| `src/protocol.js` | `safeCommandId()` y `peekControl()`; `server.error()` incluye `commandId` solo si es válido. |
| `src/hub.js` | `protoError(conn, e, commandId)`; `replyRateLimited()` con presupuesto propio; errores del Master con `commandId` seguro (también `SESSION_NOT_FOUND`/`UNAUTHORIZED`); `applied` validado por `commandId` de la versión y deduplicado; memoria acotada `cmdByVersion`. |
| `public/js/orders.js` (nuevo) | Máquina de estados de la orden: etapas **Servidor** y **Dispositivos**, tiempos finitos, texto derivado del resultado real, códigos de error explicados. |
| `public/js/master.js`, `public/master.html` | Indicadores derivados de `orders.js`; `error` con `commandId` cierra su orden; reintentos agotados / tiempo máximo / sin conexión → `SIN CONFIRMACIÓN`; límites de duración alineados con el servidor (se ajusta y se avisa); historial de órdenes recientes; estilos por estado. |
| `public/js/pending.js` | Las órdenes en cola sin conexión > 15 s se declaran fallidas (`failReason`). |
| `public/js/remote.js` | **Una sola línea de lógica**: `connecting()` evita la reconexión espuria al cargar (E). |
| `test/ordenes.test.js` (13), `test/ordenes-servidor.test.js` (10), `e2e/ordenes.test.js` (5), `e2e/master-ack.test.js` (+2), `test/distribucion.test.js` (+1 y 1 ampliada), `package.json` | Pruebas nuevas y scripts. |
| `docs/PROTOCOLO.md`, `docs/SEGURIDAD.md`, este informe, `README.md` | Documentación. |

No se tocaron: autenticación, límites de frecuencia, validación del protocolo, restricciones de Strobe, formato del QR, `effects.js`, el almacenamiento Redis (salvo lo ya hecho en 3.2.0).

## 3. Qué hace cada corrección

1. **Respuesta a lo descartado (A)**: si un Master supera el límite general y lo descartado era `command`/`stop`/`setConfig` con `commandId` válido, recibe `RATE_LIMITED` + ese `commandId`, con presupuesto propio (2/s, ráfaga 4). Lo que excede el presupuesto, la telemetría de participantes y lo que no trae `commandId` se descarta sin responder (se cuenta en métricas). A las 20 infracciones se corta con 4429, como antes. **No hay bucle**: una respuesta de error nunca genera otra.
2. **`commandId` en errores (B)**: solo si cumple `^[A-Za-z0-9_-]{8,64}$`; si no, el campo se omite (nunca se refleja ni se inventa). Los errores de orden ya no se suprimen por el límite de 1 s (los sin `commandId` conservan ese límite).
3. **Ciclo de vida en el panel (C)**: `ENVIANDO…` → `ACEPTADA POR EL SERVIDOR` / `RECHAZADA: CÓDIGO — motivo` / `SIN CONFIRMACIÓN` / `REEMPLAZADA`; y, aparte, `APLICADA` / `APLICADA PARCIALMENTE` / `SIN CONFIRMACIÓN DE DISPOSITIVOS` / `SIN DISPOSITIVOS CONECTADOS`. Solo la orden más reciente gobierna los indicadores; una respuesta tardía actualiza únicamente su orden (un ACK tardío corrige una orden ya «sin confirmación»).
4. **Confirmaciones (D/F)**: aceptación ≠ aplicación. La aplicación solo se declara con `stats` de **esa** versión; el servidor ignora `applied` ajenos (otro `commandId`) y duplicados.
5. **Cliente remoto (E)**: no se fuerza una reconexión mientras un intento recién iniciado (< 4 s) sigue conectando.

## 4. Pruebas nuevas y resultados (ejecutadas)

| Comando | Resultado |
|---|---|
| `npm ci` | 0 vulnerabilidades. |
| `npm run check` | sintaxis OK (47 archivos). |
| `npm test` con Redis 5.0.14 real | **138 / 138 pasan**. |
| `npm test` sin Redis | 138 pruebas: **120 pasan, 0 fallan, 18 omitidas** (necesitan `redis-server`; NO verificadas en esa corrida). |
| `npm run test:browser` (Chrome 154 de escritorio) | **31 / 31 pasan**. |

Cobertura pedida → prueba:

| Requisito | Prueba |
|---|---|
| 1 Rechazo por límite de frecuencia con `commandId` | `ordenes-servidor` A1, A2 |
| 2 Error con y sin `commandId` | `ordenes-servidor` B (8 variantes) |
| 3 Orden resuelta por error del servidor | `ordenes` (unidad), `master-ack` «Errores del servidor», `e2e/ordenes` (Strobe rechazado) |
| 4 Reintentos agotados | `ordenes` (unidad), `master-ack` «SIN ninguna respuesta» |
| 5 Timeout sin respuesta | `ordenes` (tope 20 s, cola offline 15 s), `master-ack` |
| 6 Respuesta tardía tras el timeout | `ordenes` (unidad), `master-ack` (ACK inyectado tarde) |
| 7 Dos órdenes consecutivas | `ordenes` (unidad), `master-ack` |
| 8 Publicación fallida | `ordenes-servidor` C (memoria con fallo inyectado), `distribucion` «Redis caído» (Redis real) |
| 9 Desconexión/reconexión del participante | `ordenes-servidor` E3 |
| 10 Integración de los 4 efectos | `ordenes-servidor` D (hasta `effects.js` real), `e2e/ordenes` (panel + teléfono reales), `distribucion` (Redis, 2 instancias) |
| 11 Confirmaciones parciales | `ordenes-servidor` E1, E2; `e2e/ordenes` |
| 12 Regresión del QR/formato | `navegacion` (3.2.0) y `e2e/ordenes` (el teléfono entra por `joinUrl`) |
| 13 Almacenamiento no disponible | `ordenes-servidor` C (lectura y publicación), `distribucion` Redis caído |
| 14 Seguridad | `ordenes-servidor` F, A1–A3 |

Tipos: **unidad** (`ordenes.test.js`, módulos puros con reloj simulado), **integración** (`ordenes-servidor.test.js`: servidor, WebSocket y almacenamiento reales; el fallo de almacenamiento es una inyección de fallos explícita sobre el store real), **E2E** (Chrome real). Reproducibilidad: contra el `hub.js` anterior fallan 6 de las 10 de integración; contra el `remote.js` anterior falla la regresión del cliente (3/3 ejecuciones).

## 5. Evidencia: una orden rechazada ya no queda en «ENVIANDO…»

Misma secuencia con el panel real (Strobe sin habilitar), antes y después:

```
ANTES   strobe: kAccepted="ENVIANDO…"   alertas=["STROBE_DISABLED: …"]  (6 s y desaparece)
DESPUÉS strobe: kAccepted="RECHAZADA: STROBE_DISABLED — el strobe está deshabilitado en esta sesión; habilitalo con la advertencia de fotosensibilidad y volvé a enviar"
```

Y las pruebas `e2e/ordenes` y `master-ack` demuestran los otros finales: sin respuesta → `SIN CONFIRMACIÓN: el servidor no respondió tras 3 intentos` (con 3 envíos del mismo `commandId` y el estado aplicado una sola vez); error sin `commandId` → alerta y la orden termina por tiempo; la siguiente orden recupera el indicador.

## 6. Evidencia: los cuatro efectos en el cliente

`ordenes-servidor` D evalúa, con el `effects.js` real, la carga que llega al teléfono: Fijo (del color actual al pedido en 500 ms), Transición (`color`→`color2`, termina en `color2`), Pulso (`color2` a mitad de período, vuelve a color fijo a los `durationMs`), Strobe (alterna a 2 Hz con `duty` 0,25 y termina). `e2e/ordenes` lo repite en pantalla: muestrea el fondo del teléfono real (el pulso recorre ambos extremos y valores intermedios; el strobe alterna color/`color2`) y comprueba que cada orden llega a **`APLICADA: 1 dispositivos confirmaron`**. En Redis (2 instancias) la carga llega íntegra a la otra instancia.

## 7. Prueba con dos iPhone y un Android (PENDIENTE: no se ejecutó)

1. Servicio en ensayo con HTTPS; `/master` en una PC; cada teléfono escanea el QR (Safari en iOS, Chrome en Android).
2. Fijo → `ACEPTADA…` y a los pocos segundos `APLICADA: 3 dispositivos confirmaron`. Transición, Pulso: ídem; mirar los tres teléfonos juntos (grabar a 240 fps) y anotar la desviación.
3. Strobe sin habilitar → debe mostrar `RECHAZADA: STROBE_DISABLED …`. Habilitar (tilde + botón) → aceptada; confirmar que alterna sin superar 3 Hz y termina sola.
4. Apagar el Wi-Fi de un teléfono 10 s y enviar una orden: ese teléfono no cuenta (parcial si es 1 de 3); al volver, muestra el estado vigente.
5. Bloquear la pantalla 30 s: el WebSocket puede cerrarse (limitación del navegador); al volver reconecta.
6. Cerrar el servidor con una orden en vuelo (o cortar la red de la PC): la orden termina en `SIN CONFIRMACIÓN`; no debe quedar `ENVIANDO…` más de ~20 s.
7. Registrar: versión de iOS/Android, navegador, desviaciones, capturas del panel.

## 8. Desplegar en Render (sin publicar automáticamente)

**No se agregan variables nuevas.** Las de 3.2.0 siguen: `NODE_ENV=production`, `MASTER_PASSWORD` (≥ 12, solo en Render), `PUBLIC_BASE_URL=https://appsincronizado.onrender.com`, `REDIS_URL` (si hay más de una instancia), opcionales `SHUTDOWN_GRACE_MS=25000`, `FLASH_DEFAULT_ENABLED`.

1. **Ensayo**: crear un segundo servicio Render (p. ej. `appsincronizado-staging`, mismo plan, su propio Key Value) apuntando a una rama `v3.2.1`; mismas variables con otra `MASTER_PASSWORD`. **No** usar la URL de producción para pruebas de carga.
2. Publicar la rama (ver los pasos de `INFORME_V3.2.md` §8: clonar el repositorio, copiar, rama, `git push`; no se hizo push desde aquí).
3. **Verificar que el código nuevo está activo** (cualquiera de estas, sin credenciales de Render):
   * `GET /js/orders.js` → **200** (en 3.2.0 devolvía 404);
   * `GET /api/admin/status` con token de operador → `version: "3.2.1"`;
   * log de arranque `listening` con `version`.
4. En el panel: enviar Fijo/Transición/Pulso → `ACEPTADA…`; Strobe sin habilitar → `RECHAZADA…`.
5. **Rollback**: Render → servicio → *Deploys* → *Rollback* al despliegue anterior (o `git revert` + push). El protocolo no cambió (v1): clientes y paneles de 3.2.0 siguen siendo compatibles con el servidor 3.2.1 (el error con `commandId` solo agrega un campo opcional) y viceversa; no hay migración de datos.

## 9. Limitaciones que aún impiden autorizar el sistema para un evento masivo

* **Sin pruebas en dispositivos reales** (iPhone/Android) ni contra Render/Valkey 8; todo lo móvil es emulación o escritorio.
* **Capacidad no demostrada**: las mediciones siguen siendo las de 3.1 (5 000 en 2 instancias + Redis cumple; 10 000 en 4 no cumple latencia). **No se afirma soporte para 60 000.** Esta versión no cambia el costo de difusión.
* La **aplicación es una muestra autodeclarada** (hasta 500 teléfonos por orden): sirve como indicador operativo, no como censo ni prueba forense; un teléfono defectuoso podría confirmar sin mostrar.
* El panel no puede saber qué pantallas se apagaron por suspensión del navegador.
* `flash.html` sigue pesando ≈ 164 KB sin comprimir en cada teléfono (mejora futura: página de participante mínima).
* El indicador de «SIN DISPOSITIVOS CONECTADOS» depende de la presencia agregada (puede tardar ~1 s en reflejar altas y bajas).
* Un solo operador activo es el caso probado; con varios paneles Master (hasta 3) cada uno ve sus propias órdenes y los `stats` globales.

Próximos pasos para capacidad: prueba de carga en staging con generador distribuido (`tools/loadtest.js`), medir Linux/Valkey, extraer la página de participante mínima y ejecutar el ensayo físico de §7 antes de cualquier evento.
