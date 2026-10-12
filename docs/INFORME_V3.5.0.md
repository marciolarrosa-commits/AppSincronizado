# Informe V3.5.0: auditoría y remediación de ciberseguridad

Versión 3.4.3 → **3.5.0** (cambia configuración y añade un endpoint). Partió de `AUDITORIA_SEGURIDAD_V3.4.md`; cada hallazgo se **verificó contra el código actual y las versiones instaladas** antes de corregirlo. Entorno de las pruebas: Windows 11, Node 24.18, Chrome 154, Redis 5.0.14 (port de Windows). **No se tocó Render ni producción, no se hizo ninguna prueba de intrusión externa y Valkey no se probó.** Una auditoría estática y pruebas automáticas **no demuestran que la aplicación sea segura al 100 %**.

## 1. Cambios implementados

| Archivo | Cambio |
|---|---|
| `package.json`, `package-lock.json` | `ioredis` `^5.4.1` → `^6.0.0` (instalado 6.0.0); se añaden las pruebas nuevas a los scripts. |
| `src/store/redis.js`, `src/store/common.js` | `protocol: 2` (RESP2) **explícito**; lo que llega por pub/sub y los registros de sesión se **validan** (forma de estado); límite compartido atómico (`INCR`+`PEXPIRE` en Lua), revocación de tokens, contador de generación y `sessionExists`. |
| `src/store/memory.js` | Misma interfaz nueva (límites, revocación, generación, existencia). |
| `src/ratelimit.js` | Nuevo `SharedLimiter`: ventana fija compartida por Redis, **respaldo local** y disyuntor si Redis falla o tarda (150 ms), métricas y aviso. |
| `src/auth.js` | Tokens con versión/emisión/vencimiento/`jti`/huella de contraseña/generación; verificación estricta de reclamaciones; **vida máxima 7 días**; revocación por `jti` y por generación; `validateTokenSecret` y derivación **scrypt**. |
| `src/config.js` | Valida `TOKEN_SECRET`, `MASTER_PASSWORD` (≥ 6 caracteres distintos), `ALLOWED_ORIGINS`; **`PUBLIC_BASE_URL` obligatoria en producción** (con `RENDER_EXTERNAL_URL` como alternativa en Render); operador 8 h, topes de 24 h; variables nuevas (`RATE_LIMIT_BACKEND`, `LOGIN_GLOBAL_FAIL_PER_MIN`, `STATUS_MISS_PER_MIN`, `FORCE_HTTPS`). |
| `src/app.js` | Límites compartidos; IP normalizada (IPv6 /64); login con `application/json` obligatorio, `Sec-Fetch-Site`, duración igual y demora ante intento distribuido; `POST /api/master/logout`; límite propio para estado inexistente; redirección http→https; Origin canónico (sin `Host` en producción); `/healthz` sin uptime; CORP; upgrade asíncrono con la comprobación de conexiones contigua al alta; bloque `security` en el estado de operador. |
| `src/hub.js` | El vencimiento del `hello` ya no cuenta como unión fallida; una sesión inexistente se rechaza **antes** de crear sala y suscribirse. |
| `src/logger.js` | Depuración de **valores** (tokens, `Bearer`/`Basic`, credenciales en URL) y de caracteres de control. |
| `public/master.html`, `public/js/master.js` | «Salir» y «Salir en todos» revocan el token en el servidor. |
| `tools/release.js` | Empaquetado por Git + raíces permitidas + denegación + **escaneo de secretos**; atómico (no escribe nada si falla). |
| `render.yaml`, `server.js`, `.env.example` | `TOKEN_SECRET` con `generateValue`; avisos de arranque (sin valores); comentarios sobre despliegue, Key Value y dominio propio. |
| `docs/` | `SEGURIDAD.md`, `CONFIGURACION.md`, `DESPLIEGUE_RENDER.md`, `RUTAS.md`, `AUDITORIA_SEGURIDAD_V3.4.md` (estado de cada hallazgo) y este informe. |
| `test/helpers.js`, `test/navegacion.test.js` | El helper reintenta si el SO asigna un puerto que `fetch` bloquea por estándar (falló una vez de forma intermitente); la prueba de configuración usaba `xxxxxxxxxxxx` como contraseña «válida», que la regla nueva rechaza: ahora usa una contraseña real y **conserva todas sus aserciones originales** (más una nueva). |

Pruebas nuevas (8 archivos): `auth-seguridad`, `limitador`, `limitador-redis`, `seguridad-http`, `logger`, `robustez-seguridad`, `release-seguridad` y el E2E `e2e/seguridad-panel`.

## 2. Vulnerabilidades

Clasificación por riesgo **real en este sistema**. «Confirmada con prueba» = la prueba nueva **falla contra el código 3.4.3** y pasa ahora (se ejecutó el archivo `seguridad-http.test.js` contra el ZIP 3.4.3: **11 de 13 fallan**).

| # | Sev. | Hallazgo | Tipo | Impacto y condiciones | Mitigación |
|---|---|---|---|---|---|
| V-01 | **Alta** | Un solo usuario (o la congestión) bloquea nuevas conexiones de todo un NAT: el vencimiento del `hello` y las consultas a sesiones inexistentes sumaban fallos a la IP compartida | Confirmada con prueba | Disponibilidad del evento; basta compartir IP (Wi-Fi/CGNAT) | Ya no cuentan; límite propio de consultas. **Residual:** adivinar códigos por WebSocket (120/min) aún bloquea las *nuevas* uniones de esa IP. |
| V-02 | **Alta** (potencial) | Agotamiento del tope de conexiones (`MAX_CONNECTIONS`) por clientes con el código público | Potencial, **no resuelto** | Disponibilidad; no se probó con carga | Fuera del código: CDN/WAF, `MAX_CONN_PER_IP` según topología, capacidad. |
| V-03 | Media | Límites de frecuencia **por proceso**: con N instancias el efectivo se multiplica por N | Confirmada con prueba (modo local: 8 intentos pasan con límite 4 entre 2 instancias) | Fuerza bruta de login más rápida con varias instancias/workers | Contadores compartidos en Redis (atómicos); 60 intentos simultáneos entre 2 instancias → **exactamente 10 pasan** con límite 10. |
| V-04 | Media | Token de operador **no revocable** durante 12 h | Confirmada con prueba | Un token robado vale hasta 12 h | Cierre de sesión (por `jti` y global), TTL 8 h. |
| V-05 | Media (condicionada) | Con `TOKEN_SECRET` fijo, **rotar la contraseña no invalidaba** los tokens | Confirmada en código | Tras sospechar compromiso, rotar la contraseña no expulsaba al atacante | Huella de contraseña en cada token. |
| V-06 | Media (condicionada) | Secreto de firma derivado de la contraseña con HKDF (rápido): un token de Master filtrado permite adivinar una contraseña **débil** sin conexión | Confirmada en código; no explotada | Requiere un token y una contraseña débil | scrypt; `TOKEN_SECRET` validado y recomendado. |
| V-07 | Media-Baja | Login aceptaba `text/plain` (petición «simple» entre sitios) y tardaba distinto si acertaba | Confirmada con prueba | Intentos repartidos por navegadores ajenos; señal de tiempo | `415`, `Sec-Fetch-Site`, duración igual, demora ante ataque distribuido. |
| V-08 | Media-Baja | Un `hello` a una sesión inexistente creaba sala y **suscripción en Redis** | Confirmada y medida: **25 `hello` inventados → 25 SUBSCRIBE + 25 UNSUBSCRIBE + 25 HGETALL** (75 operaciones); ahora **0** | Amplificación hacia Redis | Se comprueba `EXISTS` antes. |
| V-09 | Media-Baja (potencial) | IPv6 sin agrupar (un /64 evita los límites) y `X-Forwarded-For` sin validar en logs | IPv6 potencial (depende de si Render entrega IPv6: **no verificado**); logs confirmado en código | Evasión de límites; contenido arbitrario en logs | Normalización /64, validación de IP, `TRUST_PROXY_HOPS` documentado. |
| V-10 | Media (condicionada) | `ioredis` 5.11.1: aviso **SNYK-JS-IOREDIS-19963957** (alta, «Uncontrolled Recursion», rango `<6.0.0-beta.1`) | Aviso de tercero; **no reproducido** | Un endpoint Redis malicioso o comprometido (o un enlace sin TLS) podría tumbar el proceso | `ioredis` 6.0.0 (ver §3). |
| V-11 | Media (proceso) | Empaquetador sin lista segura de archivos | Riesgo, **sin fuga confirmada** (historial de Git y ZIP revisados) | Un `.env` o clave local podría entrar en un ZIP | Política de 4 filtros + escaneo; probado con señuelos. |
| V-12 | Baja | Origen WebSocket validado también contra `Host`; URL pública no obligatoria | Endurecimiento | El navegador no puede falsificar `Origin`; riesgo bajo | URL canónica obligatoria; sin `Host` en producción. |
| V-13 | Baja | `/healthz` mostraba el tiempo de actividad | Confirmada con prueba | Revelación menor | Eliminado (sigue en el estado de operador). |
| V-14 | Baja | Datos de Redis sin validar (pub/sub, registros) | Endurecimiento | Requiere acceso a Redis | Validación de forma; registro corrupto = «no existe». |
| V-15 | Baja | Registros: valores sensibles dentro de textos; caracteres de control | Endurecimiento (cubierto con pruebas nuevas; no reproducido contra el código anterior) | Fuga o falsificación de líneas | Depuración por valor y de caracteres de control. |

**No resuelto o sin cambio:** V-02; telemetría autodeclarada (`applied`, `ping.rtt`); contraseña única del operador sin MFA; `script-src blob:`; despliegue automático por commit.

## 3. Dependencias

| Paquete | Antes | Ahora | Notas |
|---|---|---|---|
| `ioredis` | 5.11.1 | **6.0.0** (`^6.0.0`) | Requiere Node ≥ 20 (el proyecto exige ≥ 20 < 26). **Aviso verificado en dos fuentes:** la página de Snyk lista una vulnerabilidad alta («Uncontrolled Recursion», `<6.0.0-beta.1`, afecta 5.9.0–5.11.1, corregida desde 6.0.0-beta.1) y la ficha de VulnCheck de `redis-parser` ≤ 3.0.0 (**CVE-2026-97057**, CVSS 8.7: longitud multibulk sin validar → `RangeError` no capturado que tumba el proceso). **No hay aviso GHSA** (la API de GitHub devolvió 0 para `ioredis` y `redis-parser`), por eso `npm audit` daba 0 **antes y después**; no lo tomes como prueba de ausencia. Un identificador adicional de Mend (CVE-2026-93435) apareció solo en un resumen de búsqueda y **no se verificó**. |
| `redis-parser` | 3.0.0 | (eliminada) | ioredis 6 trae su propio analizador. |
| `@ioredis/commands` | 1.10.0 | 2.0.0 | Dependencia de ioredis. |
| `ws` | 8.22.0 | 8.22.0 | Sin cambios. |

**Compatibilidad (RESP3).** ioredis 6 usa **RESP3 por defecto** (nota de versión: «Set `protocol: 2` to retain the v5 wire protocol»). No se cambió el protocolo: `protocol: 2` está fijado y probado (`redisOptions()`), de modo que pub/sub, `EVAL`, `HGETALL`, `TIME`, `INFO` se comportan como con ioredis 5. Se comprobó contra Redis 5.0.14 con el protocolo por defecto y con `protocol: 2` (ambos funcionan; el cliente degrada solo), y la batería con Redis real cubre reconexiones, sesiones, pub/sub, idempotencia entre instancias, caída/recuperación del suscriptor y errores. **No se probó Valkey** (el servicio de Render) ni Redis ≥ 6.

`npm ci` desde el lockfile en una carpeta limpia: correcto; 33 paquetes, **todos con hash de integridad**; `npm audit` (producción y desarrollo): **0 vulnerabilidades**. Árbol de producción: `ioredis` 6.0.0 (+ 6 dependencias) y `ws` 8.22.0. Mantenimiento: `denque`, `redis-errors` y `standard-as-callback` no se publican desde 2022–2023 (bibliotecas pequeñas y estables, sin avisos).

## 4. Pruebas (resultados reales)

| Comando / comprobación | Resultado |
|---|---|
| Línea base (antes de cambiar nada), `npm test` con Redis | 165 / 165 |
| `npm run check` | sintaxis OK (65 archivos) |
| **`npm test` con Redis 5.0.14 real, estado final** | **224 / 224**, 0 omitidas, 0 fallos (≈ 6,5 min) |
| **`npm run test:browser` (Chrome 154)** | **41 / 41** |
| Cobertura (`--experimental-test-coverage`, 162 pruebas de las áreas de seguridad, sobre `src/`) | 99,3 % de líneas, 90,9 % de ramas; `auth.js` 100 % / 98,3 %, `app.js` 100 % / 90,7 %, `hub.js` 99,8 % / 91,2 %, `ratelimit.js` 96,8 %, `redis.js` 98,7 % |
| `seguridad-http.test.js` contra el **código 3.4.3** | **11 de 13 fallan** (confirma V-01, V-04, V-07, V-12, V-13 y la IP); contra el actual: 13 / 13 |
| Amplificación hacia Redis (script contra Redis real, 25 `hello` inventados) | 3.4.3: 75 operaciones · actual: 0 |
| `npm ci` en carpeta limpia + `npm audit` | OK · 0 vulnerabilidades |
| Escaneo del historial de Git (10 commits) y del paquete (122 archivos) con las reglas de secretos | 0 hallazgos; ningún archivo sensible versionado alguna vez |
| Tests eliminados | 0 (comparado con el ZIP 3.4.3): 205 → 265 `test(...)`, 1 180 → 1 517 llamadas `assert` |

Un fallo intermitente de la línea base de esta sesión (`ordenes-servidor`, «bad port» de `fetch`) se explicó (puerto asignado por el SO) y se corrigió en el helper; pasó al repetirlo.

Lo que cubren las pruebas nuevas: validación del secreto (con 50 000 secretos aleatorios de cada formato: 0 a 2 rechazos), reclamaciones de tokens (≈ 40 casos malformados), rotación de contraseña/secreto, revocación; límites (ventana, concurrencia exacta, aislamiento, caída de Redis real a mitad de prueba, disyuntor, demora); login/cierre de sesión/`Sec-Fetch-Site`/redirección/origen canónico/IPv6/NAT; mensajes fragmentados, `__proto__`, JSON profundo, confusión de roles, errores sin detalles; aislamiento entre prefijos de Redis; ausencia de sinks de HTML en el cliente; ZIP con 31 señuelos.

**No ejecutado / no verificable:** Valkey y Redis ≥ 6; el entorno real de Render (`RENDER_EXTERNAL_URL`, exposición del Key Value, TLS, IPv6 entrante); pruebas de carga con los límites compartidos (cada petición de API/login y cada unión fallida añade **una consulta a Redis**); teléfonos físicos; prueba de intrusión externa.

## 5. Configuración de Render (qué hacer a mano)

1. **Servicio nuevo por Blueprint:** `render.yaml` genera `MASTER_PASSWORD` y `TOKEN_SECRET`; `PUBLIC_BASE_URL` es opcional si `RENDER_EXTERNAL_URL` existe.
2. **Servicio existente (`appsincronizado`):** en *Environment* añadir **`TOKEN_SECRET`** (`openssl rand -base64 48`) y, si hay dominio propio, `PUBLIC_BASE_URL`. Comprobar en los logs de arranque `public_base_url_from_render` y que el QR sale con la URL correcta (`RENDER_EXTERNAL_URL` **no se pudo verificar**).
3. **Al desplegar caducan todos los tokens** (formato y secreto nuevos): el operador vuelve a ingresar. No desplegar durante un evento.
4. Revisar en el panel que el **Key Value no tiene acceso externo** (`ipAllowList: []`) y, si el plan lo permite, usar credenciales o `rediss://`.
5. Con un CDN delante: `TRUST_PROXY_HOPS=2`. Con varias instancias: Redis obligatorio (los límites compartidos solo valen con él).
6. Opcional: `autoDeployTrigger: off` (hoy `commit`).
7. Sin cambios de plan: el plan gratuito sigue sin ser apto para un evento masivo (0,1 CPU, 512 MB, Key Value de 25 MB sin persistencia: un reinicio borra sesiones, revocaciones y contadores).

## 6. Riesgos residuales

V-02 (agotamiento de conexiones; depende de CDN/WAF y capacidad), contraseña única sin MFA y token en `sessionStorage`, revocación entre instancias con retraso de hasta 5 s y sin persistencia en el plan gratuito, telemetría autodeclarada, `script-src blob:`/`style-src-attr 'unsafe-inline'`, despliegue automático por commit, retención de logs con IP, y todo lo listado como «no verificable». Un secreto aleatorio legítimo puede ser rechazado por la validación de `TOKEN_SECRET` (≈ 1 de cada 25 000); basta regenerarlo.

## 7. Preparación para release

* **Listo para pruebas y para staging** (Render con Redis/Valkey de pago): código, pruebas (224 + 41), dependencias y documentación están verificados en local.
* **No lo declaro listo para producción con decenas de miles de personas.** Antes: (1) probar en un staging real con Valkey y confirmar `RENDER_EXTERNAL_URL`/Key Value/TLS; (2) prueba de carga con los límites compartidos activos; (3) decidir la mitigación de V-02 (CDN/WAF, topes por IP); (4) una prueba de intrusión externa. Para un uso moderado en **una instancia**, con `TOKEN_SECRET` definido y los pasos manuales hechos, el riesgo residual es el descrito en §6.
* Compatibilidad: protocolo WebSocket v1, formato del QR (`/?s=CODIGO&mode=remote`), contratos de API y cliente **sin cambios**; cambian configuración (URL canónica obligatoria, `TOKEN_SECRET` recomendado) y el hecho de que los tokens anteriores dejan de valer.
