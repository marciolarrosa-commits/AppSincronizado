# Informe de seguridad (V3.1)

Alcance: código de este repositorio. **No** se hizo una prueba de intrusión externa ni se auditó la infraestructura de Render.

## Controles implementados y cómo se verifican

| Requisito | Implementación | Prueba automática |
|---|---|---|
| Autenticación del Master | `MASTER_PASSWORD` → token de operador firmado (HMAC-SHA256, vence). La comparación es de tiempo constante. | `seguridad: el panel Master exige autenticación…`, `token … vencido o manipulado…` |
| Autorización por sesión | Token de Master con `{sid, epoch}`: solo sirve para **su** sesión; `epoch` rotable → revoca todos los tokens anteriores (el Master conectado es expulsado al siguiente comando). | `un token de Master solo sirve para SU sesión…`, `revocar tokens…` |
| Participante ≠ Master | `command/stop/setConfig` solo se aceptan de conexiones con rol `master` verificado en el servidor; el rol sale del token, no del cliente. | `un participante NO puede enviar órdenes administrativas…`, `…no puede presentarse como Master…` |
| Aislamiento de sesiones | Salas por sesión; mensajes publicados por canal de sesión. | `las sesiones están aisladas…` |
| Credenciales fuera de la URL | El token viaja en el primer mensaje (`hello`), no en la query string. | `compatibilidad: el Master antiguo… ya NO es compatible` |
| CSWSH | Validación de `Origin` en el upgrade (mismo host, `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS`); sin `Origin` solo si `ALLOW_NO_ORIGIN`. Además no hay cookies de sesión: la autenticación es por token, así que un sitio ajeno no hereda credenciales. | `Origin no autorizado es rechazado (CSWSH)…` |
| Rate limiting | Por capas (ver "Límites por IP y NAT"): API por IP, login por IP, mensajes por conexión (token bucket), órdenes del Master; tras 20 infracciones se corta. | `límite de intentos de login…`, `abuso de frecuencia…`, `capa 2/3/5…` |
| Fuerza bruta de códigos | Los fallos por IP (sesión inexistente, token inválido, hello vencido, violaciones de protocolo) cuentan contra `BAD_JOIN_PER_MIN_PER_IP` (120/min); al superarlo la IP queda bloqueada un minuto. Código = 32⁶ ≈ 10⁹ combinaciones; conocerlo solo permite unirse como participante (no enviar órdenes). | `capa 3…` |
| Límite de tamaño | `maxPayload` de `ws` (1009) + cuerpo HTTP ≤ 4 KB (413). | `mensajes demasiado grandes…` |
| Validación estricta | Esquemas por tipo, campos desconocidos rechazados, rangos de color/efecto/frecuencia/duración. | `validación estricta de órdenes…`, `mensajes malformados…` |
| CORS | Cerrado por defecto (sin `Access-Control-Allow-Origin`); solo orígenes de `ALLOWED_ORIGINS`. (Antes: `*`.) | `el servidor protege las rutas estáticas… cabeceras` |
| Cabeceras / CSP | `default-src 'none'`; `script-src 'self' blob:` + **hash** de cada script en línea (sin `unsafe-inline` en scripts); `frame-ancestors 'none'`; `nosniff`; HSTS en producción. El panel Master no tiene scripts en línea. | mismo test + revisión en Chrome (0 violaciones) |
| Rutas estáticas | Solo archivos de `public/` precargados en memoria (lista cerrada): sin *path traversal*, sin acceso a `src/`, `package.json`, `.git`. | idem |
| Separación público/admin | API del operador y `/api/admin/status`, `/metrics` exigen token; `/api/sessions/:id/status` público solo dice `exists:true`. | `el estado público… no revela…`, `métricas… solo con credenciales` |
| Secretos | Solo variables de entorno; sin valores por defecto inseguros en producción (arranque abortado sin contraseña). | `src/config.js` |
| Logs | Redacción automática de campos `token/password/secret/authorization/cookie/key`; los tokens nunca se loguean. | `los logs no contienen tokens ni contraseñas` |
| Errores internos | Respuesta genérica `SERVER_ERROR` / `INTERNAL`; el detalle solo va al log. | — |
| Seguridad visual | Strobe ≤ 3 Hz, siempre con duración máxima, deshabilitado por defecto, habilitación con reconocimiento explícito del riesgo, "Efectos: desactivados" y `prefers-reduced-motion` en el teléfono. | `effects.test.js`, `efectos: … strobe (con habilitación explícita)` |

## Resultado de las pruebas de seguridad

15 pruebas de seguridad (`test/seguridad.test.js`) + 3 de compatibilidad: **todas pasan** (ver `INFORME_FINAL.md` para el resumen con fecha).

## Riesgos residuales y límites

* **Contraseña única compartida** para el operador: no hay usuarios individuales ni MFA. Mitigación: contraseña larga generada por Render, token de 12 h, límite de login. Si se filtra, rotarla (invalida todos los tokens).
* **Tokens en `sessionStorage`** de la pestaña del Master: un XSS en el panel los robaría. Mitigación: sin HTML dinámico (`textContent`), CSP sin scripts en línea. No se hizo una auditoría de XSS externa.
* **La página pública conserva `blob:` en `script-src`** (el modo micrófono crea un AudioWorklet desde un Blob). No hay entrada de usuario que se refleje en HTML, pero es una concesión de CSP.
* **El código de sesión es el único "secreto" del público**: quien lo conozca puede unirse (es lo esperado: está en el QR). No puede enviar órdenes.
* **NAT de estadio / carriers**: los límites por IP pueden bloquear a usuarios legítimos si se dejan en el valor por defecto (ver `WS_CONNECT_PER_MIN_PER_IP`).
* **DoS volumétrico** (L3/L4/L7): fuera del alcance del código; depende de la protección de Render/Cloudflare.
* El servidor de **Redis gratuito no tiene autenticación** en la red interna de Render por defecto: mantenerlo solo interno (`ipAllowList: []`).
* `npm audit`: 0 vulnerabilidades conocidas en las dependencias al momento de instalar (`ws`, `ioredis`).

## Límites por IP y NAT (auditoría V3.1)

**Problema**: los límites por IP son peligrosos en un evento masivo: operadoras móviles (CGNAT) y el Wi-Fi del lugar hacen que **decenas de miles de teléfonos compartan unas pocas IP públicas**.
Los valores anteriores (`WS_CONNECT_PER_MIN_PER_IP=3000`, `BAD_JOIN_PER_MIN_PER_IP=30`, `HTTP_RATE_PER_MIN=600` también sobre las páginas) cortaban a ~85 % de un NAT de 20 000 personas que se unen en un minuto y
bloqueaban incluso la **carga de la página** (2 200 de 2 800 peticiones de 700 teléfonos → 429; reproducido en `test/auditoria.test.js`).

**Diseño por capas** (cada capa cubre una amenaza distinta y ninguna depende de que la IP sea "un solo usuario"):

| Capa | Control | Defecto | Falsos positivos |
|---|---|---|---|
| 1 | Tope global por proceso (`MAX_CONNECTIONS`; `/readyz` 503; upgrades 503) | 20 000 | No depende de la IP: protege la capacidad. |
| 2 | Conexiones **sin hello** simultáneas por IP (`PRE_HELLO_MAX_PER_IP`) + `HELLO_TIMEOUT_MS` 5 s | 1000 | Un cliente legítimo completa el hello en milisegundos: con 1 000 uniones/s y 100 ms por hello hay ~100 pendientes. |
| 3 | **Fallos** por IP/min (`BAD_JOIN_PER_MIN_PER_IP`): código inexistente, token inválido, hello vencido, protocolo violado | 120 | Raros en el uso normal (el QR no falla); 119 códigos mal tecleados desde una IP no bloquean a nadie (probado). Visibles en `ws_rejected_badjoin`. |
| 4 | Tasa de conexiones por IP/min (`WS_CONNECT_PER_MIN_PER_IP`) | 60 000 | Equivale a ~1 000 uniones/s desde una sola IP: ya no es "un teléfono". Probado: 3 500 uniones desde una IP en 9 s sin rechazos. |
| 5 | Conexiones totales por IP (`MAX_CONN_PER_IP`) | 0 = apagado | Un NAT de estadio puede tener 60 000: activarlo solo si se conoce la topología. |
| API | `HTTP_RATE_PER_MIN` solo para **API/administración**; `LOGIN_RATE_PER_MIN` | 600 / 8 | Uso humano. Las páginas estáticas no se limitan por IP (`HTTP_STATIC_RATE_PER_MIN=0`): la protección volumétrica es de Render/CDN. |

**Riesgo residual que NO se resuelve**: el login del operador (8 intentos/min por IP) puede ser agotado por otra persona detrás del **mismo NAT** (denegación del acceso del operador).
Mitigaciones: iniciar sesión antes del evento (el token dura 12 h y sobrevive a recargas), tener 2 operadores en redes distintas y rotar `MASTER_PASSWORD` si hay sospecha.
Una contraseña correcta no debe saltarse el límite (sería un oráculo de fuerza bruta).
Para el evento, vigilar `ws_rejected_*` y `http_rate_limited`: cualquier valor distinto de cero durante la audiencia es un falso positivo a investigar.

## Respuestas de error y confirmaciones de aplicación (V3.2.1)

* **No se debilitó ningún límite**: siguen vigentes el límite general por conexión (Master 20/s, ráfaga 40; participante 5/s, ráfaga 30), el cupo de órdenes (5/s, ráfaga 10), el cierre con 4429 a las 20 infracciones y los límites por IP.
* **Sin amplificación**: responder a una orden descartada tiene su propio presupuesto por conexión (2/s, ráfaga 4); los errores de órdenes válidas ya limitadas por el límite general llevan otro (20/s, ráfaga 40); los errores sin `commandId` siguen a 1 por segundo. La telemetría de participantes (`ping`/`applied`) y todo lo no asociable a una orden se descarta **sin responder**. Lo que excede el presupuesto se cuenta (`rate_limited_replies_suppressed`) y el panel lo resuelve por tiempo.
* **No se refleja ni se inventa información del cliente**: `commandId` solo se devuelve si cumple `^[A-Za-z0-9_-]{8,64}$` (si no, el campo se omite); el JSON ilegible no se «adivina»; un participante que intenta dar órdenes recibe `FORBIDDEN` sin ningún dato suyo.
* **`applied` no se puede falsear fácilmente**: debe coincidir con el `commandId` de esa versión y se cuenta una vez por dispositivo y versión (`applied_mismatch`, `applied_duplicate`, `applied_out_of_window` en `/metrics`). Sigue siendo una **muestra autodeclarada**: un cliente malicioso podría confirmar una orden que no mostró; por eso el panel la presenta como indicador operativo, no como prueba forense.
* Probado en `test/ordenes-servidor.test.js` (A1–A3, B, F), reproducible contra el `hub.js` anterior (6 de 10 fallan allí).

## Interruptor de la app Flash (V3.2)

* Cambiar el estado exige token de **operador** (el token de Master de sesión no sirve); el cuerpo se valida (`enabled` booleano, 400 si no) y el tamaño se limita (413). Se registra `flash_toggled` (sin tokens) y se cuenta en `/metrics`.
* Deshabilitada, `/flash` y `/?s=` responden `403` con `cache-control: no-store`; la comprobación ocurre **antes** de cualquier `304`, así que una copia en caché no la salta. La pantalla del participante V3 (`mode=remote`) no depende del interruptor.
* Límite conocido: el interruptor protege las direcciones de entrada, no el archivo (`flash.html` también contiene el cliente de V3). La app Flash no usa el servidor ni maneja datos sensibles.
* Se dejaron de publicar los `*.artifact.json` (metadatos del editor) que antes se servían como estáticos.
