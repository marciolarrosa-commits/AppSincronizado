# Informe V3.2: navegación corregida y convivencia con la app Flash

Versión 3.1.2 → **3.2.0**. Rutas completas: `RUTAS.md`. Resultados medidos en un equipo Windows 11, Node 24.18, Chrome 154 y Redis 5.0.14 (port de Windows). **Nada se ejecutó en iPhone/Android físicos ni contra Render.**

## 1. Diagnóstico de la causa

En `src/app.js`, `serveStatic()` convertía `/` en `/index.html`. Pero **`public/index.html` era la app Flash anterior** (micrófono + linterna, «El flash de cada celular, al compás de la música del lugar», botón «Crear sesión» que solo genera un código local en el navegador, sin servidor). Ese mismo archivo incluía, incrustado, el cliente remoto de V3 (`remote.js`), que se activa solo con `?mode=remote`. Por eso:

* la raíz mostraba la app anterior y su «Crear sesión» nunca tocaba `/api/sessions`;
* los QR de V3 (`/?s=CODIGO&mode=remote`) funcionaban porque el script de cabecera detecta `mode=remote` y oculta la interfaz anterior (esto es lo que se validó en dos iPhone);
* `/master` siempre fue correcto (`master.html`).

No había redirecciones, ni caché, ni otra ruta involucrada: era un mapeo de archivo.

## 2. Solución (sin reescribir el cliente móvil)

* `public/index.html` → **`public/flash.html`** (contenido idéntico: se conserva lo validado en iPhone).
* Nuevo `public/index.html` = **portada de V3** con «Abrir panel del operador» (`/master`) y un campo para unirse con el código.
* Enrutado explícito en `pickPage()` (sin redirecciones, sin depender de caché): `/` portada · `/?s=X&mode=remote` y `/?mode=remote` participante (siempre) · `/master` panel · `/flash` y `/?s=X` app Flash **solo si el operador la habilita**.
* **Flash convive y se controla desde `/master`**: tarjeta «App Flash» con interruptor, QR propio (`/flash?s=CODIGO`, código aleatorio, botón «Nuevo código») distinto del QR de la sesión. Estado en el almacenamiento (memoria o Redis), compartido entre instancias (refresco ≤ 5 s, sin consulta por petición). Por defecto **deshabilitada** (`FLASH_DEFAULT_ENABLED=false`): el operador la activa para el evento que la necesite.

## 3. Archivos modificados

| Archivo | Motivo |
|---|---|
| `public/index.html` (nuevo), `public/flash.html` (antes `index.html`), `public/flash-disabled.html` (nuevo) | Portada V3; app Flash + cliente remoto sin cambios; página de «no habilitada». |
| `src/app.js` | `pickPage()`; interruptor Flash (`GET/POST /api/admin/flash`); 403 sin caché; no publicar `*.artifact.json`; `flash` en `/api/admin/status`. |
| `src/store/memory.js`, `src/store/redis.js` | `getSetting/setSetting` (ajustes del operador compartidos). |
| `src/config.js` | `FLASH_DEFAULT_ENABLED`; validación de `PUBLIC_BASE_URL` (solo origen, `https` en producción); mensaje de `MASTER_PASSWORD` accionable. |
| `server.js` | Validación temprana: error de configuración = una línea JSON `startup_config_invalid` y salida 1 (sin traza ni bucle de reinicios); aviso `single_instance_memory_state`. |
| `public/master.html`, `public/js/master.js` | Tarjeta/lógica de la app Flash (QR, copiar, abrir, nuevo código). |
| `test/navegacion.test.js` (10), `e2e/navegacion.test.js` (1), `test/distribucion.test.js` (+1 Redis real), `test/plataforma.test.js` | Cobertura de la navegación; la prueba de metadatos ahora apunta a `/?mode=remote` (donde vive el cliente móvil). |
| `package.json` (+ lock) | 3.2.0; nuevos tests en los scripts. |
| `.env.example`, `README.md`, `docs/RUTAS.md` (nuevo), `ARQUITECTURA`, `CONFIGURACION`, `SEGURIDAD`, `DESPLIEGUE_RENDER`, este informe | Documentación alineada al código. |

No se tocaron: protocolo WebSocket, `hub.js`, `remote.js`, `effects.js`, límites de seguridad, formato del QR.

## 4. Auditoría de rutas

Tabla definitiva y verificada contra el código en `RUTAS.md` (páginas, estáticos, login, sesiones, tokens, estado, salud, métricas, administración, WebSocket). Verificada además con un servidor real en modo producción (sección 5).

## 5. Resultados reales de comandos y pruebas

| Comando | Resultado |
|---|---|
| `npm ci` | 0 vulnerabilidades; instalación según `package-lock.json`. |
| `npm run check` | sintaxis OK, 43 archivos. |
| `npm test` **sin** Redis | 113 pruebas: **96 pasan, 0 fallan, 17 omitidas** (necesitan `redis-server`; marcadas como NO verificadas). |
| `REDIS_SERVER=…redis-server.exe npm test` | **113 / 113 pasan** (Redis 5.0.14; incluye el interruptor Flash entre 2–3 instancias). Valkey 8 de Render: **no probado**. |
| `npm run test:browser` | **24 / 24 pasan** en Chrome real de escritorio (incluye portada → panel → login → sesión + QR → participante y Flash habilitable). |
| Arranque real en producción (`NODE_ENV=production`, `PUBLIC_BASE_URL` https, contraseña descartable) | `/healthz` 200, `/readyz` 200, `/` y `/master` 200, `/flash` 403 → 200 tras habilitarla, `/metrics` y API sin token 401, login erróneo 401, `joinUrl` con el dominio público, HSTS presente, **ni la contraseña ni el token aparecen en los logs**. |
| `NODE_ENV=production node server.js` sin `MASTER_PASSWORD` | Sale con código 1 y una línea `startup_config_invalid` clara. |
| Barrido de secretos en el árbol y el historial | Sin secretos reales (solo marcadores de ejemplo y constantes de prueba). |

Defecto propio hallado y corregido durante el trabajo: mis primeras rutas de navegador del E2E nuevo usaban barras mal escapadas y la prueba se **omitía** en silencio; se corrigió y se verificó que ahora se ejecuta (no se cuenta como aprobada una prueba omitida).

## 6. Ejecutar localmente

```bash
cd destello-sync-v3/DestelloSync-Render
npm ci
npm start            # imprime una contraseña temporal para /master (solo desarrollo)
# http://localhost:10000/            portada
# http://localhost:10000/master      ingresar → Crear sesión nueva → QR; tarjeta «App Flash» para habilitarla
```

## 7. Variables en Render (sin valores secretos)

| Variable | Obligatoria | Valor |
|---|---|---|
| `NODE_ENV` | sí | `production` |
| `MASTER_PASSWORD` | **sí** | secreta, ≥ 12 caracteres; **solo en el panel de Render** (el Blueprint puede generarla) |
| `PUBLIC_BASE_URL` | recomendada | `https://appsincronizado.onrender.com` (sin barra ni ruta) |
| `REDIS_URL` | solo si > 1 instancia/proceso | la enlaza el Blueprint al Key Value; con una sola instancia puede omitirse |
| `SHUTDOWN_GRACE_MS` | recomendada | `25000` |
| `ALLOWED_ORIGINS`, `METRICS_TOKEN`, `FLASH_DEFAULT_ENABLED`, `COMMAND_LEAD_MS` | opcionales | ver `CONFIGURACION.md` |
| `PORT` | no | la inyecta Render |

Sobre el fallo de `a6b1031` («Falta MASTER_PASSWORD»): el error se lanza si y solo si `NODE_ENV=production` y la variable está vacía; es independiente del commit. **No pude ver el panel de Render**, así que no puedo confirmar el estado actual: revisá *Environment* antes de desplegar. Health check del Blueprint: `/healthz` (existe y devuelve 200).

## 8. Publicar en GitHub y verificar (no se hizo push ni commit: no hay `remote` configurado y no lo autorizaste)

El repositorio local de `DestelloSync-Render` **no tiene remoto** y su historial no incluye los commits `a6b1031`/`b4e58a5` de GitHub, así que no conviene empujar directo. Camino seguro:

```bash
git clone https://github.com/marciolarrosa-commits/AppSincronizado.git AppSincronizado-repo
# copiar el contenido de DestelloSync-Render (sin node_modules ni .git) sobre el clon, respetando su estructura
cd AppSincronizado-repo && git status && git diff --stat     # revisar que no haya secretos ni node_modules
git switch -c v3.2-navegacion
git add -A && git commit -m "feat: portada V3 en /, app Flash habilitable desde /master, validacion de arranque"
git push -u origin v3.2-navegacion       # revisar en GitHub y fusionar a main cuando esté conforme
```

Luego en Render: confirmar variables (sección 7) → desplegar → verificar: `/healthz` 200 · `/readyz` `{"ready":true}` · `/` portada · `/master` login → crear sesión → QR · `/flash` 403 hasta habilitarla · logs sin `startup_config_invalid`.

## 9. Plan de pruebas físicas (2 iPhone + 1 Android) — **PENDIENTE**

Preparar: HTTPS real (Render), operador en PC, un teléfono 4G y otro Wi-Fi.
1. Escanear el QR de la sesión (cámara nativa) en ambos iPhone (Safari) y en Android (Chrome): carga directa de la pantalla de participante, sin login. Anotar versión de iOS/Chrome.
2. Entrada manual: desde `/` escribir el código → `Unirme`.
3. Enviar Fijo, Transición, Pulso, Strobe (tras confirmar la advertencia) y **DETENER TODO** (Esc): todos los teléfonos cambian juntos; grabar a 240 fps y medir la desviación entre pantallas.
4. Estado visible: «CONECTADO» y, en el panel, «Aceptada» / «n dispositivos confirmaron» / % a tiempo.
5. Apagar Wi-Fi 10 s y reactivar: reconecta y muestra el estado vigente (no el obsoleto).
6. Bloquear la pantalla 30 s y volver: reconecta (la web **no** puede mantener el WebSocket con la pantalla bloqueada).
7. iPhone: «Compartir → Añadir a pantalla de inicio» y abrir como app: pantalla completa y áreas seguras (notch/Dynamic Island).
8. Flash: en el panel habilitar la app Flash, escanear su QR en un teléfono, activar micrófono/linterna; deshabilitar y confirmar `403`.
9. Registrar resultados en `COBERTURA_PANTALLA.md` §9.

## 10. Checklist de aceptación

- [x] `/` muestra la portada V3, no la app Flash (prueba de servidor + E2E).
- [x] «Abrir panel del operador» lleva a `/master`.
- [x] Login, creación de sesión real, código y QR (E2E en Chrome).
- [x] El QR abre la pantalla de participante sin login; `/?s=CODIGO&mode=remote` y `/?mode=remote` siguen funcionando.
- [x] Órdenes por WebSocket (aceptada / aplicada) — pruebas de servidor y E2E existentes.
- [x] La app Flash no interfiere y es habilitable desde `/master` con QR propio.
- [x] Sin redirecciones; sin dependencia de caché (ETag/`no-store` verificados).
- [x] Errores de arranque claros; secretos fuera del código y de los logs.
- [ ] Prueba en 2 iPhone + 1 Android (**pendiente**).
- [ ] Despliegue y verificación en Render (**pendiente**: requiere tu autorización y credenciales).
- [ ] Valkey de Render (el Redis probado es 5.0.14) (**pendiente**).

## 11. Capacidad y límites (sin cambios; ver `CARGA.md` y `OPERACION_EVENTO_MASIVO.md`)

* **Medido** (un equipo Windows): 5 000 en 2 instancias + Redis cumple los criterios definidos (p95 182 ms); 10 000 en 4 instancias no cumple latencia (p95 427 ms).
* **Objetivo no demostrado**: 60 000 dispositivos. No se afirma.
* La portada y el cambio de rutas no alteran el WebSocket ni el costo de difusión. El participante sigue descargando `flash.html` (≈ 164 KB sin comprimir): una **mejora futura** es extraer una página de participante mínima.
* Procedimiento seguro: prueba de carga solo en un servicio de **staging** del mismo plan (nunca producción), con `tools/loadtest.js` desde varias máquinas, subiendo 500 → 1 000 → 5 000 y registrando p95/p99, pérdida de órdenes y recuperación tras un corte; `WS_CONNECT_PER_MIN_PER_IP` y `COMMAND_LEAD_MS` según `OPERACION_EVENTO_MASIVO.md`.

## 12. Limitaciones conocidas

* `flash.html` es un archivo único: el interruptor protege las direcciones de entrada, no los bytes (la app Flash no usa el servidor ni tiene datos sensibles).
* Con almacenamiento en memoria, un reinicio devuelve el interruptor Flash a `FLASH_DEFAULT_ENABLED` y pierde las sesiones (el panel las recrea con el mismo código).
* El texto de ayuda de `remote.js`/`flash.html` dice que el alfabeto de códigos excluye la «L», pero el servidor la acepta (`[A-HJ-NP-Z2-9]`): inconsistencia menor de texto, no se tocó el cliente validado.
* Navegadores internos de apps y Samsung Internet sin verificar; sincronía entre paneles OLED/LCD no garantizada; Wake Lock sin garantía.
