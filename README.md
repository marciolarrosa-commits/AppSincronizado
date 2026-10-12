# Destello·Sync V3.5.0

Sincroniza las pantallas de los teléfonos de un público: cada persona abre una web (sin instalar nada) escaneando un QR y un operador controla colores y
efectos en tiempo real desde `/master`. WebSocket real (`ws`), estado autoritativo en el servidor, ejecución programada (`executeAt`) con reloj sincronizado,
reconexión automática y, opcionalmente, Redis/Valkey para varias instancias.

> **Estado honesto**: probado y funcionando en una instancia y en 2 instancias + Redis (ver `docs/CARGA.md`). **No** está validado para 60 000 dispositivos:
> ese es el objetivo de ingeniería, no una capacidad demostrada. Ver `docs/OPERACION_EVENTO_MASIVO.md`.

## Rutas (tabla completa y verificada contra el código: `docs/RUTAS.md`)

| Ruta | Descripción |
|---|---|
| `GET /` | **Portada de Destello·Sync V3** con el botón «Abrir panel del operador». |
| `GET /?s=CODIGO&mode=remote` | **Pantalla del participante** (el QR de la sesión apunta acá; formato V3.0 conservado). `/?mode=remote` = app instalada sin código. |
| `GET /master` | Panel del operador (contraseña): crea sesiones, QR, colores y efectos, **interruptor de la app Flash**. |
| `GET /flash` · `/?s=CODIGO` | **App Flash anterior** (micrófono + linterna). Solo responde si el operador la habilitó en `/master`; si no, `403`. Su QR propio lo genera el panel. |
| `WS /ws` | Canal de tiempo real (protocolo en `docs/PROTOCOLO.md`). |
| `POST /api/master/login`, `POST/GET /api/sessions`, `POST /api/sessions/:id/master-token`, `…/revoke`, `GET/POST /api/admin/flash` | API del operador (Bearer). |
| `GET /api/sessions/:id/status` | Público: solo `exists`. Con token de operador: estado y conteos. |
| `GET /healthz` · `/readyz` · `/api/admin/status` · `/metrics` | Vivo · listo · detalle (operador) · Prometheus (token). |

## Inicio rápido (local)

```bash
npm install
npm start                 # imprime una contraseña temporal para /master si no definís MASTER_PASSWORD
# abrir http://localhost:10000/master  →  ingresar  →  Crear sesión  →  escanear el QR (o abrir el enlace en otra pestaña/teléfono)
```

Producción: `NODE_ENV=production MASTER_PASSWORD=<≥12 caracteres> npm start`. Varias instancias: `REDIS_URL=redis://…` (ver `docs/DESPLIEGUE_RENDER.md`).

## Pruebas

```bash
npm test                  # 159 pruebas (con Redis real; 20 se omiten sin REDIS_SERVER): navegación, efectos, plataforma/PWA, rastreador de ACK, funcionales, seguridad, WebSocket, compatibilidad, idempotencia, robustez, auditoría, distribución, generador de carga
REDIS_SERVER=/ruta/a/redis-server npm test    # incluye distribución con 2 instancias + Redis REAL (si no, esas 6 se omiten y se informa)
npm run check             # sintaxis de todo el JavaScript
npm run test:browser      # 39 E2E en Chrome/Edge real (incluye portada → panel → QR → participante y el interruptor Flash), con la cobertura de pantalla con emulación móvil (puppeteer-core; CHROME_PATH opcional)
node tools/loadtest.js --spawn --clients 1000 --commands 5 --storm 1   # prueba de carga (ver docs/CARGA.md)
```

## Documentación

* `docs/RUTAS.md` — todas las rutas HTTP/WS: método, autenticación, respuestas y errores.
* `docs/INFORME_V3.5.0.md` — auditoría y remediación de ciberseguridad (ioredis 6, límites compartidos, tokens revocables, empaquetado seguro, Render): hallazgos, pruebas, configuración y riesgos residuales.
* `docs/AUDITORIA_SEGURIDAD_V3.4.md` — auditoría de ciberseguridad por revisión de código (10 hallazgos priorizados; sin pruebas de intrusión).
* `CHANGELOG.md` y `docs/VERSIONADO.md` — historial de versiones y regla de versionado (cada modificación = versión + nota + ZIP; `npm run release`).
* `docs/COLOR.md` — por qué blanco/amarillo se ven distintos según el teléfono (gris/marrón en Samsung, iguales en iPhone), modelo colorimétrico, ensayo con `/colores` y ajustes.
* `docs/SINCRONIZACION.md` — qué pasa cuando miles de teléfonos escanean en momentos distintos, fuentes de error, mediciones y operación en estadio.
* `docs/INFORME_V3.4.0.md` — sincronía: reloj compensado al unirse, dibujo exacto, reloj único entre instancias y telemetría.
* `docs/INFORME_V3.3.0.md` — efecto «Secuencia de colores» (2–12 colores, segundos por color, ininterrumpida hasta DETENER TODO).
* `docs/INFORME_V3.2.2.md` — colores atenuados en Samsung: Wake Lock con reintentos y diagnóstico de color.
* `docs/INFORME_V3.2.1.md` — ciclo de vida finito de las órdenes, causas por efecto, pruebas y despliegue de ensayo.
* `docs/INFORME_V3.2.md` — navegación corregida, convivencia con la app Flash, pruebas ejecutadas, publicación y plan en dispositivos.
* `docs/ARQUITECTURA.md` — qué había, defectos corregidos, componentes, estado autoritativo, etapas de escalado.
* `docs/PROTOCOLO.md` — mensajes, esquemas, códigos, sincronización de reloj.
* `docs/CONFIGURACION.md` — todas las variables de entorno.
* `docs/SEGURIDAD.md` — controles, pruebas y riesgos residuales.
* `docs/OBSERVABILIDAD.md` — logs, salud, métricas, alertas.
* `docs/CARGA.md` — metodología, criterios (definidos antes) y resultados por volumen.
* `docs/DESPLIEGUE_RENDER.md` — límites de Render verificados, despliegue, recuperación y **rollback**.
* `docs/COBERTURA_PANTALLA.md` — cobertura total de pantalla, modo espectáculo, Android vs iOS, PWA, protocolo de ensayo físico.
* `docs/OPERACION_EVENTO_MASIVO.md` — requisitos y checklist para un evento grande; limitaciones de navegadores móviles.
* `docs/AUDITORIA_V3.1.md` y `docs/INFORME_AUDITORIA_V3.1.md` — auditoría posterior: hallazgos por gravedad, correcciones, pruebas y riesgos (`INFORME_FINAL.md` es el informe de la etapa anterior).

## Seguridad visual

El strobe está **deshabilitado por defecto**, limitado a 3 Hz y con duración máxima; se habilita por sesión confirmando una advertencia de fotosensibilidad.
Los teléfonos pueden desactivar efectos ("Efectos: desactivados") y respetan `prefers-reduced-motion`. **DETENER TODO** (tecla Esc en el panel) apaga todas las pantallas.
