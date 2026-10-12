# Despliegue en Render, recuperación y rollback

## Límites de Render verificados (documentación oficial consultada el 2026-10-09)

Fuentes: render.com/docs/websocket, /free, /scaling, /key-value, /compute-plans.

| Tema | Dato oficial |
|---|---|
| Conexiones WebSocket simultáneas | "Sin límite fijo", pero muchas conexiones exigen CPU/RAM: hay que subir de plan o escalar horizontalmente. |
| Duración de una conexión | Sin timeout fijo; dura hasta que la instancia se apaga. Recomiendan ping/pong periódicos (ya implementado). |
| Despliegues / reinicios | Render envía **SIGTERM** y espera **30 s** por defecto (ampliable hasta 300 s con `shutdown delay`). Las conexiones abiertas se cierran al reemplazar la instancia: los clientes deben reconectar con backoff (implementado). |
| Varias instancias | El balanceador asigna **cada conexión nueva a una instancia al azar**; un cliente que reconecta puede caer en otra. Por eso el diseño usa estado compartido (Redis). |
| Tráfico | Una sola puerta pública (`10000` por defecto), incluidos los upgrades. Usar `wss` (con `ws` Render responde 301 a TLS). El tráfico **saliente** por Internet (incluye los mensajes WebSocket del servidor) cuenta para el ancho de banda saliente; el entrante y la red privada no. |
| Plan **Free** (web) | 0,1 CPU, 512 MB; **una sola instancia** (no escala); **se duerme tras 15 min sin tráfico** (arranque ≈ 1 min); 750 h/mes por workspace; sistema de archivos efímero; Render puede reiniciarlo en cualquier momento. |
| Escalado | Planes pagos: hasta 100 instancias (hasta `8c-32g`) y hasta 5 instancias para `8c-64g` o más (más, a pedido). El autoescalado requiere workspace Pro o superior. |
| Planes de cómputo (web) | `free` 0,1 CPU/512 MB · `0.5c-512mb` · `1c-2g` · `2c-4g` · `2c-8g` · `2c-16g` · `4c-8g` · `4c-16g` · `4c-32g` · `8c-16g` · `8c-32g` · `8c-64g` · `12c-24g` · `12c-48g` · `12c-96g`. |
| Key Value (Valkey 8) | `free` 25 MB / **50 conexiones** / sin persistencia · `256mb` 250 con. · `1g` 1 000 · `3g` 3 000 · `5g` 5 000 · `10g` 10 000 · … `50g` 50 000. Pago: persistencia cifrada. URL interna sin autenticación por defecto. |
| Precios | **No se pudieron verificar** en las páginas consultadas (la documentación no los lista). Consultar render.com/pricing antes de cotizar. No se creó ningún recurso pago. |

**El plan Free es un entorno de desarrollo/validación, no una garantía para un evento.** Esta aplicación no cambia el plan ni crea recursos pagos.

Cada proceso de la app usa **2 conexiones** a Redis (comandos + suscripción). Con K instancias/procesos: 2·K conexiones (el Key Value gratuito admite 50).

## Variables de entorno en Render (V3.5.0 — qué hay que configurar y qué cambia al desplegar)

| Variable | ¿Qué hacer? |
|---|---|
| `NODE_ENV` | `production`. |
| `MASTER_PASSWORD` | Aleatoria y larga (el Blueprint la genera con `generateValue`). Mínimo 12 caracteres y ≥ 6 distintos. |
| `TOKEN_SECRET` | **Nueva, recomendada:** secreto de firma de tokens aleatorio de ≥ 32 bytes (hex o base64). El Blueprint la genera con `generateValue: true`. En un servicio **existente** (no gestionado por Blueprint) hay que **añadirla a mano** en *Environment*: `openssl rand -base64 48`. Si no existe, se deriva de `MASTER_PASSWORD` con scrypt (el arranque avisa). |
| `PUBLIC_BASE_URL` | **Ahora obligatoria en producción.** Si no la defines, en Render se toma `RENDER_EXTERNAL_URL` (la define Render; **no verificado en el entorno real**: confirma en los logs de arranque el mensaje `public_base_url_from_render` y que el QR sale con la URL correcta). Con dominio propio, defínela con ese dominio. |
| `ALLOWED_ORIGINS` | Opcional: orígenes https adicionales separados por comas, sin comodines. No dejes valores de ejemplo. |
| `REDIS_URL` | La enlaza el Blueprint al Key Value. Sin ella = memoria, **una sola instancia**. |
| `SHUTDOWN_GRACE_MS` | `25000`. |

**Qué cambia al desplegar esta versión (hay que saberlo antes):**
1. **Todos los tokens anteriores dejan de valer** (cambia el formato y el secreto de firma): el operador debe volver a ingresar en `/master` y los paneles Master conectados reconectan con un token nuevo. No desplegar durante un evento en curso.
2. Si se define `TOKEN_SECRET` por primera vez más adelante, ocurre lo mismo (otra rotación). Rotar `MASTER_PASSWORD` o `TOKEN_SECRET` invalida todos los tokens (operador y Master).
3. La vigencia por defecto del token de operador baja de 12 h a **8 h**.
4. Un `ALLOWED_ORIGINS` o `PUBLIC_BASE_URL` inválidos ahora **impiden el arranque** con un mensaje claro en los logs (no hay arranque a medias).
5. `/healthz` ya no informa el tiempo de actividad (sigue siendo `200`; Render lo sigue sondeando igual).

**Límites del plan gratuito (siguen vigentes; esta versión no los cambia):** el servicio gratuito (0,1 CPU, 512 MB, una instancia, se duerme tras 15 min) y el Key Value gratuito (25 MB, 50 conexiones, **sin persistencia**: un reinicio borra sesiones, revocaciones de tokens y contadores de límites) no son aptos para un evento de decenas de miles de personas. Con varias instancias hace falta Redis de un plan que persista y aguante la carga. **No se cambió ningún plan ni se tocó el entorno real.**

**Redis/Key Value:** la conexión interna de Render no exige contraseña ni TLS por defecto; la seguridad depende de que el servicio **no** tenga acceso externo (`ipAllowList: []`). Esto no se puede comprobar desde el repositorio: revisar en el panel de Render que el Key Value no está expuesto, y usar `REDIS_URL` con credenciales o `rediss://` si el plan lo ofrece. Quien tenga acceso a Redis puede leer sesiones y **publicar estados a todos los teléfonos**.

Ver `CONFIGURACION.md`. Mínimo: `NODE_ENV=production`, `MASTER_PASSWORD` (el Blueprint la genera), `REDIS_URL` (la enlaza el Blueprint al Key Value), `PUBLIC_BASE_URL`, `SHUTDOWN_GRACE_MS=25000`.
La contraseña generada se lee en el panel de Render (Environment). **No va en el código ni en Git** (`.env` está en `.gitignore`; `render.yaml` solo pide generarla).
`PUBLIC_BASE_URL` debe ser exactamente el dominio público (`https://appsincronizado.onrender.com`, sin barra final ni ruta): se valida al arrancar y se usa en el QR y en el origen WebSocket permitido. `FLASH_DEFAULT_ENABLED` es opcional (ver `CONFIGURACION.md`). Con más de un proceso/instancia, `MASTER_PASSWORD` (o `TOKEN_SECRET`) debe ser la misma en todos: es la misma variable del servicio.

## Procedimiento de despliegue

1. **Antes**: `npm ci && npm test` verde (y, si hay Redis local, `REDIS_SERVER=… npm test`). Registrar el commit.
2. Servicio existente `appsincronizado` (conserva la URL): cargar `MASTER_PASSWORD`, `NODE_ENV=production` y (opcional) `REDIS_URL`; luego `git push` a la rama conectada. Servicio nuevo: aplicar `render.yaml` (Blueprint).
3. Render ejecuta `npm ci --omit=dev` y arranca `npm start`; espera a `/healthz`.
4. **Después**: `GET /readyz` → `{"ready":true}`; abrir `/master`, ingresar, crear sesión, abrir el QR en 2 teléfonos y cambiar el color; revisar el panel "Estado del sistema".
5. No desplegar durante un evento en curso: cada despliegue desconecta a todos (se recuperan solos, pero hay un corte de segundos).

### Qué pasa durante un despliegue

SIGTERM → la instancia deja de aceptar upgrades (503), envía `restart` con `reconnectAfterMs` aleatorio (0,5–4,5 s) y cierra **escalonadamente** con 1012 durante `SHUTDOWN_SPREAD_MS`;
los teléfonos reconectan con jitter a la instancia nueva (o a otra) y reciben el estado vigente.
Con Redis la sesión y su estado sobreviven. **Sin Redis la sesión se pierde**: los teléfonos muestran "Esperando al operador" y reintentan cada 5–15 s; el panel Master la **re-crea automáticamente con el mismo código** (si su token de operador sigue vigente) y vuelven a obedecer sin recargar.
(Probado en Chrome real: `e2e/browser.test.js`, segunda prueba.)

## Rollback

* **Código**: Render → servicio → *Events/Deploys* → **Rollback** al despliegue anterior, o `git revert <commit>` + push. El protocolo es v1; las páginas V3.0 abiertas siguen funcionando como participantes (adaptador).
* **Datos**: no hay base de datos persistente propia; el estado vive en memoria/Redis y caduca (`SESSION_TTL_S`). Un rollback no requiere migraciones. Con Redis, las claves usan el prefijo `REDIS_PREFIX`; si una versión futura cambiara el formato, usar otro prefijo.
* **Panic button operativo**: el botón **DETENER TODO** (tecla Esc) del Master lleva todas las pantallas a negro. Si el servidor no responde, los teléfonos conservan el último estado; los strobe terminan solos (duración máxima) y los efectos animados pasan a color fijo tras 10 s sin conexión.
* Volver temporalmente a memoria (una instancia): quitar `REDIS_URL` y `CLUSTER_WORKERS`.

## Recuperación ante incidentes

| Síntoma | Causa probable | Acción |
|---|---|---|
| `/readyz` 503, panel "almacenamiento no responde" | Redis caído/reiniciado | Verificar el Key Value. Las órdenes fallan con `PUBLISH_FAILED` mientras tanto; los teléfonos siguen conectados. Al volver Redis se recupera solo (probado). Si Redis perdió los datos (plan free): re-crear la sesión desde el panel (mismo código). |
| Teléfonos con banner "Sin conexión" | Red del lugar / reinicio | Esperan y reintentan con jitter; revisar `heartbeat_timeouts` y capacidad. |
| Panel "salud: degraded" | Lag/almacenamiento/clientes lentos | Subir margen (Seguro 3 s), agregar instancias, reducir efectos. |
| 429 en el login del operador | Intentos fallidos | Esperar 1 min; si no fuiste vos, rotar `MASTER_PASSWORD`. |
| Servicio dormido (plan free) | 15 min sin tráfico | La primera visita tarda ≈ 1 min: abrir `/healthz` con antelación (o usar un plan pago siempre activo). |

---

## Configuraciones recomendadas por entorno (auditoría V3.1)

Marcado: **[medido]** = hay una ejecución propia que lo respalda (en un equipo Windows, ver `CARGA.md`); **[estimado]** = deducción sin prueba; **[pendiente]** = debe validarse antes de usarlo.

| Entorno | Almacenamiento | Instancias | Variables clave | Notas |
|---|---|---|---|---|
| **Desarrollo local** | memoria | 1 proceso | `npm start` (contraseña temporal impresa); `LOG_LEVEL=debug` opcional | Hasta ~1 000 conexiones sin problema **[medido]**. |
| **Pruebas de integración con Redis** | Redis/Valkey local (`redis-server` ≥ 5) | 2 procesos | `REDIS_SERVER=/ruta/redis-server npm test` (arranca el suyo en un puerto libre) | Verificado con Redis 5.0.14 (port de Windows). Valkey 8 (Render) **[pendiente]**. |
| **Pruebas de carga aisladas** | `--spawn-redis` o memoria | 1–4 procesos locales | `node tools/loadtest.js --spawn …` (el servidor se lanza con un entorno controlado: no hereda `REDIS_URL`) | Nunca contra producción. Para ≥ 10 000 conexiones, repartir el generador en varias máquinas **[medido: un solo generador se satura]**. |
| **Staging** (réplica de producción) | Key Value del mismo plan que producción | Mismo número de instancias | `NODE_ENV=production`, `MASTER_PASSWORD`, `PUBLIC_BASE_URL`, `REDIS_URL`; `LOG_LEVEL=info` | Aquí se ejecuta la prueba de carga previa al evento con el generador **fuera** de Render. **[pendiente]** |
| **Producción: demo / evento pequeño (≤ 1 000)** | memoria o Key Value | 1 (plan pago, siempre activo) | Igual; `COMMAND_LEAD_MS=1500` | 1 000 conexiones en 1 proceso cumplen todos los criterios **[medido]**. Sin Redis, un reinicio pierde la sesión (el panel la re-crea con el mismo código). |
| **Producción: evento mediano (≈ 5 000)** | Key Value **pago** (persistencia) | ≥ 2 instancias (o 1 instancia ≥ 2 CPU con `CLUSTER_WORKERS=2` y Redis) | `COMMAND_LEAD_MS=2000–3000`, `ALLOWED_ORIGINS` | 5 000 en **2 instancias + Redis** cumple los criterios **[medido, un equipo]**; en 1 proceso la difusión tarda ~0,5 s y no cumple p95 ≤ 250 ms. |
| **Producción: evento grande (10 000 → 60 000)** | Key Value pago, plan con conexiones ≥ 2 × procesos | muchas instancias | `COMMAND_LEAD_MS ≥ 2 × difusión medida (+250 ms)`; subir `MAX_CONNECTIONS` solo tras medir | 10 000 en 4 instancias **no** cumplió los umbrales en el equipo de prueba (limitado por el generador y la CPU compartida). 60 000: **no demostrado**. Ver `OPERACION_EVENTO_MASIVO.md`. |

### Infraestructura según objetivo (guía de dimensionamiento, no garantía)

* **Memoria por conexión** ≈ 18–22 KB en el servidor **[medido]** (RSS 54 MB a 100 conexiones → 141 MB a 5 000, un proceso) ⇒ 60 000 ≈ 1,1–1,3 GB repartidos entre instancias **[estimado]**.
* **CPU de difusión** ≈ 50–100 µs por envío en Windows **[medido]**; en Linux **[pendiente de medir]**. Regla práctica para dimensionar la PRUEBA: núcleos ≥ audiencia × costo_por_envío / (tiempo_objetivo_de_difusión) — p. ej. 60 000 × 75 µs / 0,5 s ≈ 9 núcleos.
* **Redis**: 2 conexiones por proceso; operaciones por orden ≈ 2 (script Lua + lectura de sesión) + 1 lectura de presencia/2 s y 1 reconciliación/15 s por sala e instancia **[derivado del código]**: con 12 instancias ≈ 10–15 operaciones/s, irrelevante frente a la capacidad de Valkey. El plan debe cubrir conexiones, no operaciones.
* **Ancho de banda saliente**: ≈ 280 B × audiencia por orden (≈ 17 MB para 60 000) + avisos de reconexión.

### Valores por entorno que NO deben cambiarse sin medir

`MAX_CONNECTIONS`, `COMMAND_MIN_LEAD_MS`, los límites de efectos (`MAX_STROBE_HZ` ≤ 3, `MAX_STROBE_DURATION_MS`), y los límites por IP (ver `SEGURIDAD.md`: se justifican por capas).

## Errores de arranque (cómo reconocerlos en los logs de Render)

Antes de iniciar, `server.js` valida la configuración y, si es inválida, escribe **una línea JSON** y termina con código 1 (Render marca el despliegue como fallido y conserva el anterior):

```
{"level":"fatal","msg":"startup_config_invalid","error":"Falta MASTER_PASSWORD (obligatoria con NODE_ENV=production). En Render: servicio > Environment > …"}
```

| Mensaje (`error`) | Causa | Solución |
|---|---|---|
| `Falta MASTER_PASSWORD…` | `NODE_ENV=production` y la variable no existe en el servicio | Render → servicio → *Environment* → agregar `MASTER_PASSWORD` (≥ 12 caracteres, secreta) → *Manual Deploy*. |
| `MASTER_PASSWORD debe tener al menos 12 caracteres…` | Contraseña corta | Usar una más larga. |
| `PUBLIC_BASE_URL inválida…` / `…debe usar https://…` | Tiene ruta/barra/espacios o es `http://` | Dejar solo el origen `https://…`. |
| `Variable X inválida` | Valor numérico mal escrito | Corregirlo (ver `CONFIGURACION.md`). |
| Aviso `single_instance_memory_state` | Producción sin `REDIS_URL` | Es válido **solo** con una instancia y un proceso (`CLUSTER_WORKERS=1`); con más, falta estado compartido. |

**Sobre el fallo del commit `a6b1031` ("Falta MASTER_PASSWORD") y el éxito de `b4e58a5`**: el código lanza ese error si y solo si `NODE_ENV=production` y `MASTER_PASSWORD` está vacía; no depende del commit. Lo más probable es que la variable no estuviera cargada en el servicio en el momento de ese despliegue (un servicio creado antes del Blueprint no recibe sus variables automáticamente). **No se pudo verificar el estado del panel de Render desde aquí**: revisar *Environment* y volver a desplegar.

## Una sola instancia vs varias

* `REDIS_URL` es **opcional solo** con una instancia y un proceso (estado en memoria; un reinicio pierde las sesiones, el panel las recrea con el mismo código).
* Más de una instancia, `CLUSTER_WORKERS>1` o escalado automático **exigen** `REDIS_URL`: `server.js` ignora `CLUSTER_WORKERS>1` sin Redis y avisa. Render no escala solo el plan *free* (una instancia).
* El `render.yaml` enlaza un Key Value al servicio; quitar ese bloque para usar memoria.
