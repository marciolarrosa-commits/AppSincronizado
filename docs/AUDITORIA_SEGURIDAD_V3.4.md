# Auditoría de seguridad (ciberseguridad) — V3.4.2

**Alcance y método.** Revisión de código **solo lectura** de `src/`, `server.js`, `public/js/`, `public/*.html`, `render.yaml`, `tools/` y las dependencias (`npm audit`: **0 vulnerabilidades**; `ws` 8.22.0, `ioredis` 5.11.1). **No se ejecutó ninguna prueba de intrusión, de carga ni de explotación**, no se tocó Render ni producción y no se auditó la infraestructura de la plataforma. Por eso **ningún hallazgo está confirmado con una prueba**: cada uno cita el código que lo origina y qué habría que verificar. Complementa `SEGURIDAD.md` (controles ya implementados y sus riesgos residuales).

**Contexto de amenaza.** El riesgo dominante de este producto no es el robo de datos (no hay datos personales ni cuentas de público), sino la **disponibilidad durante el evento** y el **control del Master**.

## Resumen

| # | Severidad | Hallazgo | Estado |
|---|---|---|---|
| S-01 | Alta | Los límites «por IP» se comparten dentro de un NAT: un solo usuario puede bloquear a miles | Por verificar |
| S-02 | Alta | Pocos clientes con el código público pueden agotar el tope global de conexiones | Por verificar |
| S-03 | Media | El secreto de firma de tokens se deriva de la contraseña con una función rápida | Por verificar |
| S-04 | Media | El token de operador no se puede revocar durante 12 h | Confirmado en código |
| S-05 | Media | El login acepta peticiones «simples» de otro sitio y tiene una diferencia de tiempo | Por verificar |
| S-06 | Media | Límites por IP sin agrupar IPv6; dependencia de `TRUST_PROXY_HOPS` | Depende del despliegue |
| S-07 | Media | `hello` a sesiones inexistentes provoca trabajo en Redis antes de validar | Confirmado en código |
| S-08 | Baja | Telemetría autodeclarada manipulable (`applied`, `ping.rtt`) | Confirmado en código |
| S-09 | Baja | Defensa en profundidad: plantilla Lua, empaquetado, cabeceras, registros | Confirmado en código |
| S-10 | Informativa | Requisitos de seguridad para funciones futuras (mosaico, imágenes, GPS) | — |

## Hallazgos

### S-01 · Alta · Bloqueo colectivo por NAT
`app.js` (`badJoinLimiter`, `upgrade`) y `hub.js` (`onBadJoin`, `ipState.pre`). Las operadoras móviles y el Wi-Fi del recinto hacen que miles de teléfonos compartan pocas IP públicas (así lo documenta `SEGURIDAD.md`). Tres señales cuentan contra el límite **de esa IP compartida** (120 fallos/min → bloqueo de 1 min) y una cuarta limita las conexiones sin `hello` (1 000):
* códigos inexistentes, token inválido y violaciones de protocolo (`onBadJoin`);
* **`HELLO_TIMEOUT` de 5 s** (`hub.js:200`): en una red saturada del estadio, teléfonos legítimos lentos suman fallos a su propia IP y pueden provocar el bloqueo de todos, que luego reintentan: **bucle de realimentación**;
* `GET /api/sessions/:id/status` con una sesión inexistente (`app.js`, rama 404) también suma, y es una petición HTTP barata y pública.

*Impacto:* un asistente malicioso (o la propia congestión) puede impedir **nuevas conexiones** de todo el NAT. Los ya conectados siguen.
*Verificar:* en un entorno propio, ver si 120 peticiones inválidas desde un cliente bloquean a otro cliente con la misma IP.
*Corrección:* no contar `HELLO_TIMEOUT` ni el `status` público; que el bloqueo sea por **(IP, identificador de cliente)** y de tipo «demora» antes que «corte»; permitir una lista de IP del recinto (`TRUSTED_NAT_IPS`) con umbrales altos; mantener el contador visible en `/metrics`.

### S-02 · Alta · Agotamiento del tope global
`config.js`: `MAX_CONNECTIONS=20000` por instancia y `MAX_CONN_PER_IP=0` (apagado, a propósito por el NAT). El código de sesión es público por diseño (está en el QR), y la capa 1 (`503`) protege la capacidad pero **no distingue a quién la ocupa**: pocos clientes que completen el `hello` y se mantengan conectados pueden llenar el cupo y dejar fuera al público. Además el objetivo del evento (60 000) **supera el tope por defecto** y el plan `free` de Render (0,1 CPU) no está dimensionado para eso (`CARGA.md`).
*Corrección:* protección volumétrica delante (CDN/WAF con límites por conexión), `MAX_CONN_PER_IP` ajustado a la topología real, cupo reservado, y escalar instancias con Redis. *Sin evidencia medida de cuántos clientes hacen falta.*

### S-03 · Media · Secreto de tokens derivado de la contraseña
`config.js:40-41`: `TOKEN_SECRET` = HKDF-SHA256 de `MASTER_PASSWORD` con sal fija; HKDF no es una función de estiramiento de contraseñas. Un **token de Master** (con alcance de sesión, pensado para delegar) permite a quien lo tenga **probar contraseñas sin conexión** y, de acertar, convertirse en **operador**. La contraseña generada por Render (`generateValue`) lo hace inviable; una elegida por una persona (mínimo 12 caracteres, sin control de entropía) no lo garantiza.
*Corrección:* exigir en producción un `TOKEN_SECRET` aleatorio independiente (o derivarlo con `scrypt` con coste alto); avisar si la contraseña es débil. Documentar que rotar `TOKEN_SECRET` invalida todo.

### S-04 · Media · Token de operador no revocable
`auth.js`: la verificación solo comprueba firma, rol y vencimiento; no hay lista ni contador de revocación. Un token robado vale hasta 12 h; solo rotar la contraseña (redespliegue) lo invalida. Los tokens de Master sí se revocan (`epoch`).
*Corrección:* contador de generación guardado en el almacenamiento, comprobado al verificar, y un «cerrar sesión en todos lados» en el panel.

### S-05 · Media · Login
`app.js` (`readJson`, `/api/master/login`): el cuerpo se interpreta **sin comprobar `Content-Type`**; una petición «simple» entre sitios (`text/plain`) llega al login sin pre-vuelo CORS. El servidor tarda 250 ms solo cuando la contraseña es **incorrecta**, lo que da una señal de tiempo. Un sitio ajeno podría usar navegadores de visitantes para repartir intentos entre muchas IP y esquivar el límite de 8/min por IP (no puede leer la respuesta, pero sí medir su duración). Las demás rutas sensibles exigen cabecera `Authorization`, por lo que ya están protegidas.
*Corrección:* exigir `Content-Type: application/json` (el panel ya lo envía: `master.js:32`) y rechazar `Sec-Fetch-Site: cross-site`; igualar la duración de éxito y fallo; contador global de fallos de login con alerta.

### S-06 · Media · Dirección IP del cliente
`app.js` (`clientIp`) usa la dirección tal cual como clave. (a) **IPv6:** un cliente con un bloque /64 dispone de un número enorme de direcciones y evita todos los límites por IP (login incluido); además las tablas de límites podrían crecer. *Depende de si la plataforma entrega tráfico IPv6; no verificado.* (b) `TRUST_PROXY_HOPS` vale 1 en Render: si se pone un CDN delante hay que subirlo a 2; **demasiado bajo** colapsa a todos los usuarios en pocas IP del CDN y **demasiado alto** permite fijar la IP con una cabecera falsa.
*Corrección:* agrupar IPv6 por /64 y normalizar `::ffff:a.b.c.d`; verificar al arrancar que el número de saltos coincide con el despliegue; documentarlo en `DESPLIEGUE_RENDER.md`.

### S-07 · Media · Trabajo en Redis antes de validar la sesión
`hub.js:323-329`: `join()` llama a `ensureRoom()` (crea la sala y **se suscribe** al canal en Redis) **antes** de `store.getSession()`; si la sesión no existe, se desuscribe. Cada `hello` con un código bien formado pero inexistente cuesta una suscripción, una baja y una lectura, y la lista de salas crece mientras tanto. Está limitado por S-01, pero con muchas IP (o S-06) es una amplificación hacia Redis, cuyo plan gratuito tiene límites bajos.
*Corrección:* comprobar la existencia de la sesión (con una caché negativa corta) antes de crear la sala.

### S-08 · Baja · Telemetría manipulable
`applied` y `ping.rtt` son autodeclarados (`SEGURIDAD.md` ya lo advierte para `applied`). Un cliente puede falsear el histograma «Reloj de los teléfonos» (`rtt` hasta 60 000) o los porcentajes de «a tiempo». Impacto: el operador puede ser engañado sobre la calidad de la sincronía; no afecta a lo que se muestra. *Mitigación:* presentarlas como orientativas y recortar valores extremos.

### S-09 · Baja · Defensa en profundidad
* **Plantilla Lua** (`redis.js`): el estado se arma sustituyendo marcadores `"__V__"`/`"__I__"` en un JSON que incluye el `commandId`. Hoy es seguro porque `commandId` y todos los campos pasan por listas blancas y expresiones estrictas; conviene una prueba que lo fije y no depender de ello.
* **Empaquetado** (`tools/release.js`): incluiría un `.env` si existiera en la carpeta (hoy solo hay `.env.example`; no hubo filtración). Excluir `.env*`.
* **Cabeceras:** `permissions-policy` bloquea `geolocation`, lo que impediría una página de pruebas GPS; `style-src-attr 'unsafe-inline'` y `script-src blob:` ya figuran como concesiones documentadas.
* **Registros:** los fallos de login registran la IP (dato personal); fijar un período de retención. `unhandledRejection` solo registra y sigue.
* **Redis** sin autenticación en la red interna (ya documentado): quien llegue a Redis podría **publicar estados** a todos los teléfonos. Preferir `rediss://` con contraseña si el proveedor lo ofrece.
* **`status` público:** revela si un código existe; combinado con S-01 conviene limitarlo más.

### S-10 · Requisitos para funciones futuras
* **Mosaico / imágenes:** el panel recibiría imágenes → validar tipo, tamaño y dimensiones, rechazar SVG, procesar en el navegador a una paleta pequeña y enviar solo índices; moderación de contenido (un Master comprometido podría mostrar algo ofensivo a todo el estadio).
* **Asiento/sector por QR:** firmar los parámetros (HMAC) para que no se puedan inventar posiciones; no guardar la posición más allá del evento.
* **GPS:** consentimiento explícito y no registrar coordenadas.

## Revisado sin hallazgos
Comparación de contraseña y firma en tiempo constante (`auth.js`); validación estricta de todos los mensajes con listas blancas (`protocol.js`); rutas estáticas con lista cerrada y sin recorrido de rutas; CSP con hashes y `frame-ancestors 'none'`; CORS cerrado; aislamiento por sala; claves de Redis construidas solo con códigos validados; sin `innerHTML`/`eval` en el cliente (el panel usa `textContent`); código de sesión generado con `crypto.randomInt`; registros con redacción de campos sensibles; dependencias sin vulnerabilidades conocidas; contraseña mínima de 12 caracteres y arranque abortado sin ella en producción.

## Prioridad sugerida
1. **S-01 y S-02** (disponibilidad el día del evento).
2. **S-03, S-04, S-05** (control del Master).
3. **S-06, S-07**.
4. **S-08, S-09** y los requisitos de S-10 cuando se implemente cada función.

## Lo que NO se hizo
Pruebas de intrusión dinámicas, fuzzing, pruebas de carga contra producción, revisión de la infraestructura de Render y de Redis gestionado, revisión de teléfonos físicos, ni análisis del código de `flash.html` más allá de buscar fuentes de inyección HTML. Los hallazgos «por verificar» deben confirmarse en un **entorno de ensayo propio** antes de corregirlos.

## Estado tras la remediación (V3.5.0)

Cada hallazgo se verificó contra el código actual antes de corregirlo. Detalle, comandos y resultados: `INFORME_V3.5.0.md`.

| # | Hallazgo | Estado en V3.5.0 | Qué se hizo / qué queda |
|---|---|---|---|
| S-01 | Bloqueo colectivo por NAT | **Mitigado** (queda un riesgo menor) | El vencimiento del `hello` ya no cuenta como unión fallida; las consultas de estado inexistente tienen límite propio (`STATUS_MISS_PER_MIN`). **Queda:** una persona detrás del mismo NAT aún puede bloquear las **nuevas** uniones de esa IP adivinando códigos (120/min); es el costo de proteger la fuerza bruta de códigos (ver `SEGURIDAD.md`). |
| S-02 | Agotamiento del tope global de conexiones | **No resuelto en código** | Depende de CDN/WAF, `MAX_CONN_PER_IP` ajustado a la topología y capacidad (`MAX_CONNECTIONS`, plan de Render). No se probó con carga. Documentado como riesgo residual. |
| S-03 | Secreto de tokens derivado de la contraseña con función rápida | **Corregido** | scrypt en lugar de HKDF; `TOKEN_SECRET` validado (≥ 32 bytes, hex/base64, entropía y patrones); huella de contraseña en cada token (rotar la contraseña invalida los tokens aunque haya `TOKEN_SECRET`). Recomendado definir `TOKEN_SECRET` (el Blueprint lo genera). |
| S-04 | Token de operador no revocable | **Corregido** | `POST /api/master/logout` (por `jti`) y `{"all":true}` (generación), compartidos por Redis; panel con «Salir» y «Salir en todos»; TTL de 8 h. Retraso de hasta 5 s entre instancias; sin Redis persistente un reinicio borra las revocaciones (residual). |
| S-05 | Login: petición «simple» entre sitios y diferencia de tiempo | **Corregido** | `415` salvo `application/json`; `403` con `Sec-Fetch-Site: cross-site`; duración mínima igual para éxito/fallo; límite compartido y demora (no bloqueo) ante intento distribuido. |
| S-06 | IP del cliente: IPv6 y `TRUST_PROXY_HOPS` | **Corregido en código; depende del despliegue** | IPv6 agrupada por /64, IPv4 mapeada normalizada, `X-Forwarded-For` ilegible → IP del socket. Con un CDN delante hay que subir `TRUST_PROXY_HOPS` (documentado; no se puede verificar desde el repositorio). |
| S-07 | `hello` a sesión inexistente trabaja en Redis antes de validar | **Corregido** | Se comprueba la existencia (`EXISTS`) antes de crear la sala y suscribirse; probado con Redis real (0 suscripciones con 25 códigos inventados). |
| S-08 | Telemetría autodeclarada (`applied`, `ping.rtt`) | **No cambiado** | Sigue siendo orientativa (documentado); no afecta a lo que se muestra. |
| S-09 | Defensa en profundidad | **Corregido en lo aplicable** | Empaquetado con lista permitida + denegación + escaneo de secretos (`tools/release.js`); plantilla Lua fijada con prueba; logs con depuración por valor; datos de Redis validados; `/healthz` sin uptime. **Sin cambio:** `Permissions-Policy` bloquea geolocalización (necesario ajustarla en una futura página GPS) y la retención de logs con IP depende de Render. |
| S-10 | Requisitos de funciones futuras | **Sin cambio** | Siguen vigentes como requisitos de diseño. |
