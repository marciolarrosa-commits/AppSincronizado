# Sistema multi-evento (V4.0)

Varios espectáculos independientes sobre la misma infraestructura y las mismas instancias, cada uno con su QR, configuración, estado y operación.

## Idea central (qué se reutilizó y qué se añadió)

La V3 ya aislaba **sesiones**: una sala del hub por código, un canal Redis `ch:<código>`, y estado, versión monotónica, presencia y confirmaciones por código. La V4 **no** reescribe nada de eso: un **evento** es un registro del operador que *posee* una sesión.

| Concepto | Dónde vive | Notas |
|---|---|---|
| Evento (nombre, fecha, estado, configuración, pico de participantes) | Almacenamiento compartido (`ds:ev:<id>`), **sin vencimiento** | Memoria con un solo proceso; Redis/Valkey con varias instancias. |
| Código público de 6 caracteres | `ds:evcode:<código>` → id (alta atómica y única) | **Es también el código de la sesión** del evento. No es el id interno (`ev_` + 16 hex). |
| Sesión/sala del evento | La de siempre (`ds:s:<código>`) | Existe **solo mientras el evento está «activo»**. |
| Auditoría | `ds:evaudit:<id>` (lista acotada a 300) | Quién, cuándo, qué. Sin secretos. |
| Instancias vivas | `ds:instances` (vencen solas) | Para el panel general. |

No hay estado global compartido entre eventos: ni variables de módulo, ni canal común, ni contador común. Los ajustes del servidor (límites, strobe) son globales por diseño; el **estado, las órdenes, los participantes, la presencia, las estadísticas y los permisos de efectos** son por evento.

## Estados y transiciones

```
borrador ⇄ programado → activo ⇄(desactivar: vuelve a «programado»)
   │           │            ├→ finalizado   (definitivo)
   └→ cancelado ←───────────┘                ·  cancelado → borrador (reabrir)
```

| Transición | Efecto sobre la sala |
|---|---|
| → `active` | Crea la sesión con el código del evento. Los teléfonos que escaneen su QR entran. |
| `active` → `scheduled` (desactivar) | Borra la sesión y **cierra** las conexiones con **4404** («espera»: los teléfonos reintentan cada 5–15 s hasta que se reactive). |
| `active` → `finished` / `cancelled` | Igual, pero cierra con **4410** (definitivo: el cliente muestra «Evento finalizado» y **no reintenta**). |
| Archivar («eliminar») | Solo si **no** está activo y confirmando con el código. Archivado **lógico**: se conservan registro, estadísticas y auditoría; el código queda reservado (no se reutiliza). Se puede restaurar. |

El cierre se publica por el bus del evento (`{"k":"close","reason":"ENDED"|"DEACTIVATED"}`), así que llega a las salas de **todas** las instancias (probado con Redis real y 2 instancias) y se reparte en lotes (`BROADCAST_CHUNK`) para no provocar una avalancha de bajas.

## QR y enlace

* Enlace del evento: `<PUBLIC_BASE_URL>/e/<CÓDIGO>` (p. ej. `https://dominio/e/K7M2QX`). Es estable mientras el evento exista y no contiene el id interno.
* `GET /e/<6 caracteres>` entrega **siempre la misma página** del participante, exista o no el evento: no sirve para enumerar eventos. El cliente lee el código de la ruta y se une por WebSocket; si el evento no está activo recibe `SESSION_NOT_FOUND`.
* **QR antiguos:** `/?s=<código>&mode=remote`, `/flash` y `/?s=` siguen funcionando sin cambios (una sesión suelta es lo mismo que antes). El código de un evento también funciona con el formato antiguo, porque es el de su sesión.
* El panel ofrece: copiar enlace, ver el QR ampliado, descargar **PNG** (1024 px) y **SVG** (vectorial, con zona de silencio). Se generan en el navegador con la librería local (sin servicios externos).
* Protección frente a enumeración: espacio de 32⁶ ≈ 10⁹ códigos; `hello` a un código inexistente cuenta contra el límite de uniones fallidas por IP (`BAD_JOIN_PER_MIN_PER_IP`); la consulta pública `/api/sessions/:id/status` tiene su propio límite de fallos. **Límite honesto:** un NAT de estadio comparte IP, por lo que estos límites protegen contra barridos masivos, no contra quien tenga el QR (que es público por naturaleza).

## Aislamiento (cómo se garantiza y cómo se prueba)

1. **Sala por código**: el hub guarda las conexiones en `rooms[código]`; una orden se difunde solo a su sala.
2. **Canal Redis por código**: `ds:ch:<código>`. Un mensaje de otro canal no llega a esta sala; lo que llega por el canal se valida (forma de estado o `close`).
3. **El servidor no confía en el cliente**: un `command` no lleva `sessionId`; la sesión sale del token de Master ya verificado (firmado, con `sid` y `epoch`). Un token del evento A **no sirve** en B (probado: `UNAUTHORIZED`).
4. **Política por evento en el servidor** (`policyFor`): cada orden de un Master de un evento consulta el evento por su código: debe seguir **activo** (`EVENT_NOT_ACTIVE`) y el efecto debe estar en `effectsAllowed` (`EFFECT_NOT_ALLOWED`); el margen del evento (`leadMs`) es un **mínimo**.
5. **Dispositivos por sala**: el mismo `deviceId` en dos eventos son dos participantes distintos (uno no reemplaza al otro).
6. **Versiones propias**: cada evento lleva su `stateVersion`; las confirmaciones (`applied`) solo cuentan para la orden de **su** versión y **su** sala.
7. **Códigos únicos y reservados**: alta atómica (Lua en Redis); una sesión suelta no puede ocupar el código de un evento (`POST /api/sessions {sessionId}` → 409) ni se genera un código aleatorio que lo coincida.

Pruebas: `test/eventos.test.js` (memoria), `test/eventos-redis.test.js` (Redis real, 2 instancias), `e2e/eventos.test.js` (Chrome real). La de aislamiento (`AISLAMIENTO: dos eventos activos…`) comprueba, con participantes y Masters de dos eventos conectados a la vez: que ningún mensaje `state` cruza, que las versiones son independientes, que el `deviceId` repetido no se pisa, que un participante no puede dar órdenes, que un token de Master no sirve en otro evento, que la presencia/estadísticas son por evento, y que **finalizar A no desconecta ni frena a B**.

## Configuración de cada evento

`name` (≤ 80), `description` (≤ 500, opcional), `startsAt` (opcional), y `config`:

| Campo | Regla |
|---|---|
| `colors` | 1–12 colores `#RRGGBB`. Son la paleta del panel al operar el evento. |
| `sequences` | hasta 10; cada una: `name`, 2–12 pasos `{color, holdMs 500–600000}`, `fadeMs 0–10000`, `durationMs 0–600000`. Se cargan con un clic al operar. |
| `effectsAllowed` | subconjunto de `solid, fade, pulse, strobe, sequence`. Predeterminado: sin `strobe`. **`strobe` se rechaza si el servidor tiene `STROBE_ALLOWED=false`** (predeterminado). |
| `leadMs` | 300–8000, margen **mínimo** de sincronización del evento (opcional). |

Cualquier campo desconocido se rechaza (no se guarda basura del cliente). Un evento `finished` o archivado no se edita.

## Concurrencia entre operadores

Cada evento tiene una revisión (`rev`). La edición y los cambios de estado usan escritura optimista (Lua `EVENT_UPDATE` en Redis): si otro operador lo cambió entre la lectura y la escritura, se responde **409 `EVENT_CONFLICT`** en vez de pisarlo. Probado: 12 ediciones simultáneas con la misma revisión desde 2 instancias → **exactamente 1** gana.

## API (solo operador; `Authorization: Bearer`)

| Método y ruta | Cuerpo → respuesta |
|---|---|
| `GET /api/events[?archived=1]` | `{events:[…]}` |
| `POST /api/events` | `{name, description?, startsAt?, config?}` → `201 {event}` |
| `GET /api/events/dashboard` | totales, conectados por evento, infraestructura (salud, almacenamiento, instancias), alertas y eventos con problemas |
| `GET /api/events/:id` · `…/stats` · `…/audit?limit=` | evento · `{connected, peakConnected, lastOrder, delivery{onTimePct, deviationP50/95Ms}}` · registro de acciones |
| `POST /api/events/:id/update` | `{name?, description?, startsAt?, config?, rev?}` |
| `POST /api/events/:id/status` | `{status}` (ver transiciones) |
| `POST /api/events/:id/duplicate` | copia como borrador con QR nuevo |
| `POST /api/events/:id/archive` | `{confirm: <código del evento>}` |
| `POST /api/events/:id/restore` | desarchiva |
| `POST /api/events/:id/master-token` | solo si está activo → `{sessionId, masterToken, joinUrl, event, …}` para el WebSocket de Master |

Errores: `INVALID_EVENT` 400, `EVENT_NOT_FOUND` 404, `EVENT_CONFLICT`/`INVALID_TRANSITION`/`EVENT_ACTIVE`/`EVENT_ARCHIVED`/`EVENT_FINISHED`/`EVENT_NOT_ACTIVE` 409, `CONFIRMATION_REQUIRED` 400, `TOO_MANY_EVENTS` 429 (`MAX_EVENTS`, 200 por defecto).

## Panel del operador (`/master`)

* **Panel general**: eventos, activos, participantes conectados (total y por evento), instancias vivas, estado del almacenamiento (Redis/memoria y latencia), salud, **alertas** (almacenamiento caído, sistema degradado, evento programado cuya hora pasó sin activarse, evento activo sin participantes) y marca «⚠ revisar» en los eventos con problemas.
* **Detalle del evento**: nombre grande, estado, QR y enlace, edición de colores/secuencias/efectos/margen, acciones (activar, programar, desactivar, finalizar, cancelar, duplicar, archivar/restaurar), estadísticas en vivo (conectados, pico, última orden, % a tiempo, desviación) y registro de acciones.
* **Operar**: reutiliza el control existente, pero con el token del evento. Una **franja verde con el nombre y el código del evento** queda fija arriba; el botón de parada de emergencia lleva el nombre («■ DETENER «Concierto» …»); solo aparecen los efectos permitidos y se ofrecen las secuencias del evento.
* **Acciones críticas** (activar, desactivar, finalizar, cancelar) piden confirmación **mostrando el nombre y el código**; archivar exige escribir el código. La parada de emergencia no pide confirmación (la velocidad es lo importante) pero muestra el nombre.
* Si el evento se desactiva o termina mientras el operador lo controla, el panel lo avisa y vuelve a la lista (no «recrea» una sesión suelta con ese código).

## Límites y pendientes (explícitos)

* **Permisos por evento y MFA: NO implementados.** Hoy hay **una contraseña de operador compartida** (`MASTER_PASSWORD`); cualquier operador autenticado puede gestionar todos los eventos. La auditoría registra la **sesión de operador** (`op:<jti>`), no a la persona. Ver `SEGURIDAD.md` («Pendiente»).
* El cierre de una sala viaja por Pub/Sub (como máximo una vez). Si una instancia pierde ese mensaje, sus teléfonos siguen conectados hasta que cierren por sí mismos; el hub **no** cierra salas por «sesión inexistente» en la reconciliación a propósito, para no romper la recuperación tras un reinicio del almacenamiento (los teléfonos reintentan y retoman).
* Los eventos no vencen y el archivado es lógico: no hay borrado físico ni purga automática (decisión de conservación; `MAX_EVENTS` acota los no archivados).
* El pico de participantes se actualiza al consultar las estadísticas (mejor esfuerzo): no es un máximo continuo.
* Las métricas Prometheus siguen siendo globales por instancia (con contadores `event_status_*`, `rooms_closed_by_operator`, `commands_effect_not_allowed`, `commands_event_inactive`); las **estadísticas por evento** salen de la API, no de etiquetas Prometheus. Los logs de acciones de evento llevan `eventId`.
