# Protocolo WebSocket (versión 1)

Endpoint: `wss://<host>/ws` (en local `ws://localhost:10000/ws`). Mensajes de **texto JSON**; los binarios se rechazan (cierre 1003).
Tamaño máximo por mensaje entrante: `MAX_MESSAGE_BYTES` (2048 por defecto; el excedente cierra con 1009).
Todo mensaje puede llevar `protocolVersion: 1`; otra versión se rechaza (`UNSUPPORTED_VERSION`). Los servidor→cliente siempre la incluyen.

Los campos desconocidos se **rechazan** (`UNKNOWN_FIELD`): nada se acepta "por las dudas".

## Handshake

La URL no lleva datos sensibles. Lo primero que debe enviar el cliente (antes de `HELLO_TIMEOUT_MS`, 5 s) es `hello`:

```jsonc
// participante (público)
{ "protocolVersion":1, "type":"hello", "role":"public", "sessionId":"K7M2QD", "deviceId":"<8-80 [A-Za-z0-9_-]>", "resumeVersion":12, "reconnect":true }
// Master
{ "protocolVersion":1, "type":"hello", "role":"master", "sessionId":"K7M2QD", "token":"<token de Master de ESA sesión>" }
```

Respuesta `welcome`:

```jsonc
{ "protocolVersion":1, "type":"welcome", "serverTimestamp":1791570000000, "sessionId":"K7M2QD", "role":"public", "deviceId":"...",
  "state": { "commandId":"c9f…", "stateVersion":12, "serverTimestamp":…, "executeAt":…, "payload": {…} },
  "config": { "heartbeatMs":20000, "clockPingIntervalMs":15000, "onTimeToleranceMs":100, "minLeadMs":300,
              "maxStrobeHz":3, "strobeEnabled":false, "strobeAllowed":true, "maxStrobeDurationMs":30000 } }
```

`state` en el `welcome` es el estado **vigente** (autoritativo); el cliente lo toma como nueva línea base de versiones (también tras un reinicio del servidor).
Si su `executeAt` aún no llegó, se programa (no se aplica antes de tiempo).

## Cliente → servidor

| `type` | Quién | Campos | Notas |
|---|---|---|---|
| `hello` | todos | ver arriba | obligatorio y único |
| `ping` | todos | `t0` (número, reloj monotónico local) | respuesta `pong`; sirve para sincronizar el reloj y como señal de vida |
| `applied` | público | `commandId`, `stateVersion`, `deviationMs` (aplicado − `executeAt`), `receiveLeadMs?` | **muestreado** (`ackRate`); el servidor agrega, no guarda uno por teléfono |
| `command` | Master | `commandId?`, `leadMs?`, `payload` | orden visual validada |
| `stop` | Master | `commandId?` | **parada de emergencia**: prioritaria (sin límite de tasa), `executeAt = ahora`, vuelve a pantalla apagada |
| `setConfig` | Master | `strobeEnabled`, `acknowledgeRisk` | habilitar strobe exige `acknowledgeRisk:true` |

### `payload` de `command`

| Campo | Efectos | Rango / valor |
|---|---|---|
| `effect` | todos | `off` · `solid` · `fade` · `pulse` · `strobe` |
| `color` | ≠ off | `#RRGGBB` |
| `color2` | fade, pulse, strobe | `#RRGGBB` (por defecto `#000000`) |
| `intensity` | todos | 0,05 … 1 |
| `fadeMs` | solid, fade | 0 … 10 000 (fade: 1 500 por defecto) |
| `periodMs` | pulse | 600 … 10 000 (2 000) |
| `hz` | strobe | 0,5 … `MAX_STROBE_HZ` (≤ 3) |
| `duty` | strobe | 0,1 … 0,5 |
| `durationMs` | pulse, strobe | pulse: 0 (sin límite) … `MAX_PULSE_DURATION_MS`; **strobe siempre con duración**: 500 … `MAX_STROBE_DURATION_MS` (30 s) |

Semántica: `solid` = ir al color (con transición opcional desde lo que se ve); `fade` = transición programada de `color` a `color2`;
`pulse` = oscila entre `color2` y `color`; `strobe` = destellos on/off. Al cumplirse `durationMs`, pulse/strobe quedan en **color fijo**.
Strobe bloqueado por defecto: error `STROBE_DISABLED` hasta que el Master lo habilite confirmando el riesgo.

## Servidor → cliente

| `type` | Destino | Contenido |
|---|---|---|
| `welcome` | quien se une | ver arriba |
| `state` | todos | `{sessionId, commandId, stateVersion, serverTimestamp, executeAt, payload, ackRate}` (+ `resync:true` si es un reenvío tras contrapresión) |
| `pong` | quien envió `ping` | `{t0, serverTimestamp}` |
| `ack` | Master emisor | **la orden fue aceptada y publicada** (`commandId`, `stateVersion`, `executeAt`, `duplicate`) |
| `stats` | Masters | agregado de **aplicación real** (muestra): `responded`, `onTime`, `late`, `lateArrival`, `onTimePct`, `deviationP50/P95/P99Ms`, `connected` |
| `presence` | Masters | `connected` (suma de todas las instancias, sin Master), `localConnected`, `health` (estado de salud para advertencias) |
| `config` | Masters | `strobeEnabled` |
| `restart` | todos | el servidor se está reiniciando: `reconnectAfterMs` sugerido (con jitter) |
| `error` | quien lo causó | `code`, `message`, `commandId?` (solo si es un identificador válido; ver «Ciclo de vida de una orden») |

**Aceptada ≠ aplicada**: `ack` solo prueba que el servidor validó y publicó; `stats` informa cuántos dispositivos (de una muestra) ya la aplicaron y con qué desviación.

### Códigos de error

`INVALID_JSON`, `INVALID_MESSAGE`, `UNKNOWN_TYPE`, `UNKNOWN_FIELD`, `INVALID_FIELD`, `OUT_OF_RANGE`, `INVALID_COLOR`, `INVALID_EFFECT`, `INVALID_ROLE`,
`INVALID_SESSION`, `UNSUPPORTED_VERSION`, `MESSAGE_TOO_LARGE`, `NOT_JOINED`, `ALREADY_JOINED`, `FORBIDDEN`, `UNAUTHORIZED`, `SESSION_NOT_FOUND`, `SESSION_FULL`,
`TOO_MANY_MASTERS`, `RATE_LIMITED`, `STROBE_DISABLED`, `RISK_NOT_ACKNOWLEDGED`, `PUBLISH_FAILED`, `UNAVAILABLE`, `DRAINING`, `DEVICE_REPLACED`.

### Códigos de cierre WebSocket y qué debe hacer el cliente

| Código | Significado | Cliente |
|---|---|---|
| 1012 | reinicio/despliegue | reconectar con jitter (usa `restart.reconnectAfterMs`) |
| 1013 | reintentar luego (capacidad, sesión llena, drenaje) | backoff |
| 1008 | violación de protocolo | corregir; no reintentar en bucle |
| 1009 / 1003 | mensaje demasiado grande / binario | — |
| 4401 | token inválido, vencido o revocado | Master: pedir token nuevo |
| 4404 | sesión inexistente o vencida | público: esperar y reintentar despacio; Master: re-crear la sesión con el mismo código |
| 4408 | no envió `hello` a tiempo | reconectar |
| 4413 | consumidor lento (buffer saturado) | reconectar |
| 4429 | abuso de frecuencia | backoff largo |
| 4002 | el mismo dispositivo se abrió en otra pestaña | **no** reintentar |

## Sincronización del reloj

Cliente: ráfaga de 6 `ping` al conectar y 3 cada `clockPingIntervalMs`. Para cada `pong`: `rtt = t1 − t0`, `offset = serverTimestamp + rtt/2 − t1`
(con `t0`, `t1` de `performance.now()`). Se conservan las últimas 12 muestras y se usa la de **menor RTT**. Hora del servidor = `performance.now() + offset`.
No se usa el reloj del teléfono como autoridad.

Con varias instancias, cada instancia tiene su propio reloj: confiamos en que los hosts estén sincronizados por NTP (error esperable de pocos ms; **no medido** en Render).

## Adaptador V3.0 (solo participantes)

`/ws?session=CODIGO&role=public&deviceId=ID` sin `hello` → el servidor traduce a los mensajes antiguos (`hello`, `state{version,color,effect,intensity,executeAt,active,label}`, `pong{clientTime,serverTime}`).
El Master V3.0 no es compatible.

---

# Semántica de estado, comandos y confirmaciones (auditoría V3.1)

## Cuatro cosas distintas

| Concepto | Qué es | Dónde vive | Cómo se garantiza |
|---|---|---|---|
| **Estado deseado actual** | Lo que TODAS las pantallas deberían mostrar ahora: un único registro por sesión (`stateVersion`, `executeAt`, `payload`, `incarnation`). | Servidor (memoria o Redis). | Versión monotónica asignada de forma atómica. Es lo que recibe quien entra o reconecta (`welcome.state`) y lo que reenvía la reconciliación. |
| **Comando transitorio** | Una orden del Master (`command`/`stop`) con `commandId`. Se convierte en el nuevo estado deseado. | Viaja una vez por el bus; solo se recuerda su `commandId` (ventana de 500) para la idempotencia. | Idempotencia por `commandId`: un reenvío NO se vuelve a aplicar ni a publicar. |
| **Confirmación de recepción** (`ack`) | "El servidor validó, aceptó y publicó tu orden" (`commandId`, `stateVersion`, `executeAt`, `duplicate`). | Mensaje al Master emisor. | Solo prueba la aceptación. **No demuestra que ninguna pantalla haya cambiado.** |
| **Confirmación de aplicación** (`applied` → `stats`) | Un teléfono informa que ejecutó el estado y con qué desviación respecto de `executeAt` (medida con su reloj sincronizado). | Se agrega por versión (HINCRBY) y se muestra al Master. | Es una **muestra** (`ackRate`) y la mide el propio cliente: prueba que el código del cliente aplicó el estado, **no** que el panel físico mostró el color en ese instante (latencia de pantalla no medible desde la página). |

**Una pantalla desconectada recupera el estado actual sin reproducir órdenes antiguas**: al reconectar recibe `welcome.state` (un solo estado, el vigente); además,
la **reconciliación** (al recuperarse el suscriptor de Redis y cada `RECONCILE_INTERVAL_MS`) entrega el estado vigente a los teléfonos de una instancia que se
haya perdido una publicación. Nunca se reproduce el historial.

## `incarnation`

Cada estado incluye `incarnation` = instante de creación de la sesión. Si una sesión se pierde y se re-crea con el mismo código, las versiones vuelven a empezar
en 1: hub y clientes comparan `incarnation` y reinician su línea base en lugar de descartar las órdenes nuevas como "viejas". Un cliente que desconoce el campo
(V3.0) lo ignora.

## Idempotencia de comandos (servidor)

* Ventana de los últimos `COMMAND_HISTORY` (500) `commandId` por sesión, con la misma caducidad que la sesión. En Redis: hash `cmd:<sesión>` + zset `cmdz:<sesión>` recortados **dentro del mismo script Lua atómico** que asigna la versión y publica; en memoria: un `Map` con el mismo límite.
* `commandId` ya visto → `ack` con `duplicate:true` y la **versión y `executeAt` ORIGINALES** de ese comando; no se publica ni cambia el estado, aunque ya existan comandos más nuevos (A, B, reenvío de A → el estado sigue siendo B).
* Funciona entre instancias (el registro es del almacenamiento compartido). Fuera de la ventana (más de 500 órdenes después) un `commandId` viejo se trataría como nuevo: el Master solo reenvía comandos de ≤ 15 s (ver abajo), por lo que la ventana cubre con holgura el límite de 5 órdenes/s.

## Política de comandos pendientes del Master (`public/js/pending.js`)

* Varios comandos en vuelo, **cada uno rastreado por su `commandId`**; un ACK solo confirma el suyo.
* **El último gana**: al crear un comando nuevo los anteriores quedan *superados* (no se reintentan ni se reenvían tras reconectar: el protocolo es de estado y reenviar una orden vieja podría revertir la nueva).
* Sin ACK en 3 s (la parada de emergencia, 1,5 s) se reenvía el **mismo** `commandId`, hasta 3 intentos; después se avisa al operador.
* Si cae la conexión con comandos pendientes: al reconectar se reenvía **solo el más reciente** y únicamente si tiene ≤ 15 s.
* ACK **duplicado**, **desconocido** (id inexistente o sin id) o **tardío** (de un comando ya superado) se clasifican y se ignoran: nunca limpian a otro comando ni tocan el estado mostrado.
* Un `error` con `commandId` cierra solo ese comando.

## Efecto `sequence` — secuencia de colores (V3.3.0)

Lista de **2 a 12 colores**; cada uno se muestra `holdMs` y al terminar pasa al siguiente. Tras el último **vuelve al primero y repite sin fin** (`durationMs: 0`) hasta que el Master envíe `stop` u otra orden. Todos los teléfonos evalúan el mismo tiempo de servidor desde `executeAt`, por lo que cambian de color **a la vez**.

```json
{ "protocolVersion": 1, "type": "command", "commandId": "seq-0001-abcd", "leadMs": 1500,
  "payload": { "effect": "sequence",
               "steps": [ { "color": "#75AADB", "holdMs": 3000 }, { "color": "#FFFFFF", "holdMs": 3000 } ],
               "fadeMs": 0, "durationMs": 0 } }
```

| Campo | Regla |
|---|---|
| `steps[]` | 2–12 objetos `{ color: "#RRGGBB", holdMs }`; campos desconocidos → `UNKNOWN_FIELD`; más/menos pasos → `INVALID_FIELD` |
| `steps[].holdMs` | entero 500–600 000 ms (0,5 s – 10 min), **por color** (cada color puede durar distinto) |
| `fadeMs` | 0–10 000 y **≤ el paso más corto**; 0 = corte seco (por defecto); >0 = fundido al entrar en cada paso |
| `durationMs` | 0 = ininterrumpida hasta DETENER TODO (por defecto); >0 = termina a ese tiempo y queda en el color activo (máx. `MAX_PULSE_DURATION_MS`) |
| `color` | se ignora; el servidor lo deriva de `steps[0]` (los clientes antiguos que lo leen muestran el primer color) |

**Seguridad visual.** Un paso < 1 s equivale a un parpadeo: exige **habilitar el strobe** de la sesión (`setConfig` con la advertencia) o se rechaza con `STROBE_DISABLED` (+ `commandId`); además la frecuencia de cambio nunca supera `MAX_STROBE_HZ` (`OUT_OF_RANGE`). Pasos ≥ 1 s no requieren strobe. En el teléfono: «Efectos: desactivados» o más de 10 s sin conexión la dejan **fija en el primer color**; «reducir movimiento» del sistema solo la afecta si hay pasos < 1 s (los cambios lentos no son movimiento ni parpadeo).

**Compatibilidad.** Páginas de participante **antiguas** (JS anterior a 3.3.0, ya abiertas) no conocen `sequence` y la ignoran (siguen mostrando lo anterior): hay que **recargar** esas páginas. Las páginas de V3.0 (sin `hello`) reciben un estado sólido con el primer color.

## Ciclo de vida de una orden (V3.2.1: `public/js/orders.js`)

Toda orden tiene dos etapas, derivadas de lo que realmente ocurrió (el texto del panel nunca es fijo):

| Etapa | Estados | Qué los produce |
|---|---|---|
| **Servidor** | `ENVIANDO…` → `ACEPTADA POR EL SERVIDOR` · `RECHAZADA: CÓDIGO — motivo` · `SIN CONFIRMACIÓN` · `REEMPLAZADA` | `ack` con su `commandId` · `error` con su `commandId` · reintentos agotados / tope de tiempo / sin conexión · envío de una orden más nueva |
| **Dispositivos** (solo si fue aceptada) | `esperando…` → `APLICADA` · `APLICADA PARCIALMENTE` · `SIN CONFIRMACIÓN DE DISPOSITIVOS` · `SIN DISPOSITIVOS CONECTADOS` | `stats` de **su** `stateVersion` (muestra): se considera aplicada con ≥ 80 % de la muestra esperada (`ackRate × connected`); al vencer el plazo (`executeAt` + 6 s) queda en lo último informado |

* **Todas terminan**: reintento a los 3 s con el mismo `commandId` (máx. 3 intentos) → `SIN CONFIRMACIÓN`; en cola sin conexión > 15 s → `SIN CONFIRMACIÓN` (sin conexión); tope absoluto de 20 s; plazo de confirmación de dispositivos de 6 s tras `executeAt`.
* **Solo la orden más reciente gobierna los indicadores.** Una respuesta tardía (ACK, error, `stats`) actualiza el registro de SU orden —un ACK tardío corrige una orden ya declarada sin confirmación y la marca «confirmación tardía»— pero no toca la mostrada.
* **Aceptada ≠ aplicada**: si ningún teléfono informa, el panel dice «SIN CONFIRMACIÓN DE DISPOSITIVOS … aplicación NO demostrada»; nunca la da por aplicada.
* Un `error` **sin** `commandId` no se asocia a ninguna orden (no se inventa uno): se muestra el código y la orden termina por tiempo.

### Errores asociados a una orden (servidor)

* `error.commandId` se incluye **solo** si el cliente envió un identificador con el formato del protocolo (`^[A-Za-z0-9_-]{8,64}$`); un identificador inválido nunca se refleja ni se sustituye.
* Un Master que supera el límite general de mensajes recibe `RATE_LIMITED` + `commandId` para las órdenes de control descartadas, con presupuesto propio (2/s, ráfaga 4) para no agravar la saturación; lo que exceda ese presupuesto se descarta sin responder y el panel lo resuelve por tiempo. La telemetría de participantes (`ping`/`applied`) y los mensajes sin `commandId` se descartan sin responder. A las 20 infracciones la conexión se cierra con 4429.
* Los errores de envoltorio (`UNSUPPORTED_VERSION`, JSON de un Master con `commandId` legible) se asocian a la orden cuando es posible; un JSON ilegible no puede asociarse.
* Los errores de órdenes se responden aunque se haya respondido otro hace menos de 1 s (antes se suprimían); los errores sin `commandId` siguen limitados a 1 por segundo por conexión.
* `PUBLISH_FAILED` (almacenamiento o publicación caídos) lleva el `commandId` y **nunca** va precedido de un `ack`: el estado de la sesión queda intacto y el reintento con el mismo `commandId` se aplica una sola vez.

### Confirmaciones de aplicación (`applied`) — validación en el servidor

Solo cuenta si (a) la versión es la vigente o una de las 5 anteriores, (b) su `commandId` coincide con el de esa versión (`applied_mismatch` si no), y (c) es la primera del dispositivo para esa versión (`applied_duplicate`). Un teléfono que se reconecta recibe el estado vigente en `welcome` y no informa esa orden como aplicada (llegó como estado «inicial»).

## Validación en el cliente

El cliente no confía ciegamente en el servidor: un `state` con payload malformado (efecto desconocido, color inválido, números no finitos) se **ignora** y no altera la línea base de versiones; ante cualquier excepción de render se muestra el estado seguro (apagado). El strobe se limita en el cliente a 3 Hz y 30 s aunque el servidor enviara otra cosa.

## Precisión temporal medida (Chrome real, mismo reloj; `e2e/red-movil.test.js`)

| Condición de red | Desviación real respecto de `executeAt` |
|---|---|
| Sin latencia añadida (10 contextos) | 1–6 ms |
| 150 ms por sentido, simétrico | 9 ms |
| Bajada 400 ms / subida 20 ms (asimétrico) | **193 ms** (≈ asimetría / 2 = 190 ms): límite conocido de la estimación tipo NTP; no se corrige con más muestras |
| Bajada 2,5 s con margen de 1,5 s | la orden llega tarde: se aplica de inmediato y se contabiliza como `lateArrival` |

En redes móviles reales la asimetría de subida/bajada es habitual: la sincronía entre teléfonos no se promete mejor que ≈ la mitad de esa asimetría.
