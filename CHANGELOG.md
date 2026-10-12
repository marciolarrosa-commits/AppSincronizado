# Historial de versiones — Destello·Sync

Cada modificación de la app genera una versión nueva (ver `docs/VERSIONADO.md`): sube `package.json`, queda registrada aquí y se empaqueta como `DestelloSync-V<versión>-Render.zip`. Las versiones anteriores a 3.2.0 se reconstruyeron a partir de sus informes; el detalle está en `docs/INFORME_*.md`.

Formato: `MAYOR.MENOR.PARCHE` — **mayor** = rompe el protocolo o el formato del QR; **menor** = función o página nueva; **parche** = corrección, diagnóstico, documentación o herramientas sin cambio de comportamiento.

<!-- release:next -->

## [3.5.0] — 2026-10-12

- Auditoría y remediación de ciberseguridad (informe en docs/INFORME_V3.5.0.md): ioredis 5.11.1 → 6.0.0 con protocolo RESP2 fijado; límites de frecuencia compartidos entre instancias (Redis, atómicos, con respaldo local si Redis falla); tokens con reclamaciones estrictas, revocación (POST /api/master/logout, «Salir en todos») y huella de contraseña; TOKEN_SECRET validado y derivación scrypt; login con application/json, Sec-Fetch-Site y tiempo igual; URL pública canónica obligatoria en producción y origen sin Host; redirección https; datos de Redis validados; registros depurados por valor; empaquetado de releases con lista permitida, denegación y escaneo de secretos.
- CAMBIOS AL DESPLEGAR: todos los tokens anteriores dejan de valer (el operador vuelve a ingresar); PUBLIC_BASE_URL (o RENDER_EXTERNAL_URL en Render) es obligatoria en producción; TOKEN_SECRET recomendado; vigencia del token de operador 8 h. Ver docs/DESPLIEGUE_RENDER.md.
- Pruebas: 224/224 con Redis 5.0.14 real y 41/41 en Chrome; 0 pruebas eliminadas (205 → 265 test, 1 180 → 1 517 aserciones); npm audit 0. No verificado: Valkey, entorno real de Render, carga, prueba de intrusión.

## [3.4.3] — 2026-10-11

- Auditoría de ciberseguridad por revisión de código: docs/AUDITORIA_SEGURIDAD_V3.4.md con 10 hallazgos priorizados (S-01 a S-10), enlazada desde README y SEGURIDAD.md.
- Solo documentación: no se cambió código ni comportamiento y no se hicieron pruebas de intrusión. Verificación: sintaxis OK, npm audit 0 vulnerabilidades, 17/17 en test/release y test/navegacion (batería completa no repetida).

## [3.4.2] — 2026-10-11

- Versionado de cada modificación: CHANGELOG.md con el historial 3.1.0–3.4.1, herramienta tools/release.js (sube versión, registra la nota y genera el ZIP verificado) y docs/VERSIONADO.md.
- Pruebas: test/release.test.js (versiones, ZIP real con CRC, exclusiones, CHANGELOG). 165/165 con Redis; no se tocó código de la app ni del cliente.

## [3.4.1] — 2026-10-11

- Página de calibración de color `/colores` (escala de blanco atenuado, amarillos, pares blanco/amarillo, campo completo y entorno del teléfono) para diagnosticar blanco→gris y amarillo→marrón en Samsung y blanco≈amarillo en iPhone.
- `docs/COLOR.md`: modelo colorimétrico (luminancia, L*, ΔE2000), hipótesis por plataforma, ensayo y ajustes para el público. No se cambió la paleta del panel.
- Pruebas: ruta `/colores` (integración) y E2E en Chrome. 160/160 con Redis, 40/40 en navegador.

## [3.4.0] — 2026-10-11

- Sincronía de teléfonos que escanean en momentos distintos: reloj compensado con el viaje `hello→welcome`, se conserva el reloj al reconectar, dibujo exacto en cada frontera de la secuencia y reloj único entre instancias (`Redis TIME`, `CLOCK_SOURCE`).
- Telemetría: `ping.rtt` opcional, histograma `clockRttMs`, fila «Reloj de los teléfonos» en el panel.
- Banco de medición `npm run sync:bench`; `docs/SINCRONIZACION.md`, `docs/INFORME_V3.4.0.md`.

## [3.3.0] — 2026-10-11

- Efecto nuevo «Secuencia de colores» (`effect: "sequence"`, 2–12 pasos, segundos por color, ininterrumpida hasta DETENER TODO). Ver `docs/INFORME_V3.3.0.md`.

## [3.2.3] — 2026-10-11

- Corrección: con el strobe deshabilitado, la duración «0» (infinita) volvía a 0,5 s en el panel.

## [3.2.2] — 2026-10-11

- Colores atenuados en Samsung: Wake Lock con reintentos, estado y error visibles en el diagnóstico, datos de entorno de color. Ver `docs/INFORME_V3.2.2.md`.

## [3.2.1] — 2026-10-11

- Ciclo de vida finito de las órdenes (`public/js/orders.js`), errores con `commandId`, límite de frecuencia con respuesta propia y corrección de efectos. Ver `docs/INFORME_V3.2.1.md`.

## [3.2.0] — 2026-10-11

- Navegación corregida (la raíz deja de mostrar la app Flash anterior), panel `/master`, formatos de QR y convivencia con la app Flash con interruptor del operador. Ver `docs/INFORME_V3.2.md`.

## [3.1.2] — 2026-10-09

- Auditoría lumínica y cobertura total de pantalla. Ver `docs/INFORME_COBERTURA_V3.1.2.md`.

## [3.1.1] — 2026-10-09

- Correcciones de la auditoría técnica V3.1. Ver `docs/INFORME_AUDITORIA_V3.1.md`.

## [3.1.0] — 2026-10-09

- Base de la auditoría (commit `289bbac`, tag `v3.1.0`).
