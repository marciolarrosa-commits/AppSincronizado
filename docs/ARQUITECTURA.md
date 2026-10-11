# Arquitectura (V3.1)

## Qué existía realmente al empezar (inspección inicial)

| Elemento | Hallazgo |
|---|---|
| Repositorio | El zip no incluía `.git`: sin historial. Se creó un commit base idéntico al zip para poder comparar y volver atrás. |
| Comunicación | **WebSocket real** con `ws` (la V3 ya estaba en el zip; la documentación antigua hablaba de SSE, pero no queda código SSE). Endpoint `/ws`. |
| Backend | Un único `server.js` (~330 líneas), estado en `Map` en memoria. |
| Tests | Ninguno. |
| Puerto | `process.env.PORT` (correcto para Render). |
| Páginas | `/` (**la app Flash anterior** —micrófono + linterna— con el cliente remoto de V3 incrustado y activado por `?s=CODIGO&mode=remote`), `/master`. QR generado en el navegador con una librería incluida. **Esta es la causa de que la raíz mostrara «El flash de cada celular…»**: `serveStatic` mapeaba `/` a `public/index.html`, y ese archivo ERA la app Flash. |

Defectos reproducibles / verificados por lectura de código y corregidos:

1. `POST /api/sessions` era **público**: cualquiera podía crear sesiones ilimitadas. → exige operador autenticado y hay tope de sesiones.
2. El token del Master viajaba en la **URL** del WebSocket (queda en logs y proxies). → ahora va en el primer mensaje (`hello`).
3. Cada conexión/desconexión enviaba la presencia a **todos** los teléfonos: O(N²) mensajes (60 000 altas = 3,6 × 10⁹ envíos). → la presencia solo se envía a los Master, con límite de frecuencia.
4. El cliente aplicaba cualquier `state` recibido: sin descarte de versiones viejas ni duplicados; el pulso/strobe eran animaciones CSS que arrancan en **momentos distintos** en cada teléfono (no sincronizadas).
5. Durante la espera hasta `executeAt` el cliente ocultaba toda la pantalla (`visibility:hidden`) y dejaba ver la pantalla de inicio de la app. → se mantiene el estado anterior hasta el instante programado.
6. Reloj: una sola muestra de ping con `Date.now()` (reloj del teléfono, no monotónico). → varias muestras, se elige la de menor RTT y se usa `performance.now()`.
7. Reconexión sin jitter (avalancha tras un corte). Sin manejo de `SIGTERM`.
8. Ruta estática: `startsWith(PUBLIC)` sin separador y `decodeURIComponent` sin protección. CORS abierto `*`.
9. Sin límites de tasa, de tamaño de mensaje a nivel de aplicación, sin contrapresión y con heartbeat de todos los sockets a la vez.
10. Si el Master recargaba la página perdía la sesión (el token solo vivía en memoria).

## Componentes

```mermaid
flowchart LR
  subgraph Navegadores
    P1[Teléfono 1..N<br/>/?s=CODIGO&mode=remote]
    M[Panel Master<br/>/master]
  end
  subgraph Instancia de la app  (1..K, también cluster de procesos)
    HTTP[HTTP: páginas, API del operador,<br/>/healthz /readyz /metrics]
    WS[Upgrade /ws<br/>Origin, límites, capacidad]
    HUB[Hub: salas, heartbeat, difusión,<br/>contrapresión, presencia, acks]
    ST[Store]
  end
  R[(Redis / Valkey<br/>estado · pub/sub · presencia · acks)]
  P1 -- wss --> WS
  M -- wss + token --> WS
  M -- https + Bearer --> HTTP
  WS --> HUB --> ST
  ST -. sin REDIS_URL: memoria .-> ST
  ST <--> R
```

* `server.js` — entrada; `CLUSTER_WORKERS=N` crea N procesos (requieren `REDIS_URL`).
* `src/app.js` — HTTP (páginas con CSP por hash, API, salud, métricas), upgrade WebSocket (Origin, tasa, capacidad), apagado ordenado.
* `src/hub.js` — conexiones por sesión, `hello`, difusión por lotes, contrapresión, heartbeat repartido, presencia, estadísticas de aplicación, drenaje.
* `src/protocol.js` — esquemas y validación estricta de cada mensaje.
* `src/auth.js` — contraseña del operador, tokens HMAC con alcance a una sesión.
* `src/store/*` — misma interfaz con dos implementaciones: **memoria** (una instancia) y **Redis** (varias).
* `public/index.html` — **portada de V3** (V3.2). `public/flash.html` — app Flash anterior + cliente remoto de V3 (el archivo que antes era `index.html`, sin cambios de contenido). `public/flash-disabled.html` — respuesta `403` cuando el operador no habilitó Flash. Enrutado en `pickPage()` de `src/app.js`; tabla completa en `RUTAS.md`.
* `public/js/effects.js` — motor de efectos puro (función del tiempo del servidor). `public/js/remote.js` — cliente del público. `public/js/master.js` — panel.

### Mecanismos de comunicación

Solo existe **un** canal de sincronización: WebSocket. No hay SSE. HTTP se usa únicamente para páginas, autenticación del operador y salud/métricas.
Compatibilidad: las páginas V3.0 abiertas antes del despliegue siguen funcionando como *participantes* (adaptador `?session=&role=public`);
el Master V3.0 ya **no** es compatible porque ahora exige autenticación (decisión de seguridad).

## Modelo de sesión y estado autoritativo

Sesión = código de 6 caracteres (alfabeto sin ambigüedades) + registro `{createdAt, epoch, strobeEnabled, ver, state}` con TTL.
El servidor es la autoridad:

1. valida la orden (esquema y límites);
2. genera `commandId` (o usa el del Master: idempotencia);
3. **incrementa atómicamente** `stateVersion` (Lua en Redis / hilo único en memoria);
4. guarda el estado y **publica una sola vez** por sesión (canal `ch:<sesión>`);
5. cada instancia con teléfonos de esa sesión recibe el mensaje y lo difunde a sus sockets (serializado una vez, en lotes).

Las órdenes llevan `executeAt = serverTimestamp + lead` (lead configurable, adaptativo: nunca menor a 2 × p95 de difusión + 250 ms). Los clientes
estiman el reloj del servidor, programan la aplicación, descartan versiones ≤ la ya recibida y ante una reconexión reciben el estado **vigente** (no el historial).
El estado vigente sobrevive a reinicios solo con Redis; sin Redis la sesión se pierde y el panel puede re-crearla con el mismo código (los teléfonos reintentan y la retoman).

## Etapas de escalado

| Etapa | Qué hay | Estado |
|---|---|---|
| 1 | Una instancia, estado coherente, reconexión, pruebas | **Implementada y probada** |
| 2 | Varias instancias/procesos + Redis (pub/sub, estado, presencia, acks) | **Implementada y probada** con 2 instancias reales + Redis real (pruebas automáticas y carga) |
| 3 | Carga progresiva hasta la audiencia objetivo | **Parcial**: 100 / 500 / 1 000 / 5 000 (y 10 000 en 4 instancias) en un solo equipo. **60 000: no probado** |

## Diseño pensado para crecer

* El protocolo no depende de dónde esté el cliente: cualquier instancia puede atender cualquier teléfono (requisito de Render).
* Una consulta a Redis por **orden** (no por teléfono). La presencia y los acks son agregados por instancia (HINCRBY / HSET por instancia).
* Los acks de aplicación son **muestreados** (`ackRate = min(1, 500 / audiencia)`): 60 000 teléfonos no generan 60 000 mensajes de vuelta.
* La difusión es el cuello de botella medido (≈ 80–100 µs por envío en Windows): se escala agregando instancias/procesos, no conexiones a una sola.

Ver `PROTOCOLO.md`, `CONFIGURACION.md`, `OBSERVABILIDAD.md`, `SEGURIDAD.md`, `CARGA.md`, `DESPLIEGUE_RENDER.md`, `OPERACION_EVENTO_MASIVO.md`.

## Convivencia de V3 y la app Flash (V3.2)

* `/` = presentación de V3. `/master` = panel. El QR de una sesión V3 sigue siendo `/?s=CODIGO&mode=remote` y el servidor entrega el cliente remoto (`flash.html`) **sin redirecciones**.
* La app Flash anterior vive en `/flash` (y en los QR antiguos `/?s=CODIGO`). **Solo responde si el operador la habilita** desde `/master` (`POST /api/admin/flash`); si no, `403`. El valor se guarda en el almacenamiento (`getSetting/setSetting` en los stores memoria y Redis) y cada instancia lo refresca con su sondeo de 5 s: **no hay consulta al almacenamiento por petición**.
* El panel genera un QR **propio** de Flash (`/flash?s=CODIGO`, código aleatorio local) distinto del QR de la sesión V3.
* Decisión de diseño: `flash.html` sigue siendo un archivo único (app Flash + cliente remoto) porque el cliente remoto ya funcionó en dos iPhone y separarlo implicaba reescribir CSS/JS compartido. Consecuencia: el interruptor controla las direcciones de entrada, no los bytes del archivo. Futuro posible: extraer un `participante.html` mínimo para que los teléfonos descarguen menos (hoy ≈ 164 KB sin gzip).
