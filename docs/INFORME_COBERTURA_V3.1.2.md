# Informe: auditoría lumínica y cobertura total de pantalla (V3.1.1 → V3.1.2)

Detalle técnico, tablas de plataformas y protocolo físico: `COBERTURA_PANTALLA.md`.

## 1. Resumen

La capa de color ya cubría el viewport, pero **la interfaz de la app quedaba siempre encima del color** (3,3–3,8 % de píxeles distintos del color ordenado), `html/body` conservaban el fondo oscuro de la app, la página original seguía desplazable debajo y no había `theme-color`, manifiesto ni metadatos de iOS. Se separó la **superficie lumínica** de la **interfaz de incorporación**, se añadió un **modo espectáculo** con salida segura, gestión de pantalla completa por plataforma y una **PWA instalable**. En Chrome con emulación móvil la captura de pantalla coincide con el color pedido en el **100 % de los píxeles** en 6 perfiles. **No** se declara compatibilidad real con Safari/iPhone ni con un Android físico: el ensayo físico está **pendiente**.

## 2. Archivos

**Modificados**: `public/index.html` (metadatos, CSS de capas, marcado, puente), `public/js/remote.js` (modos, capa lumínica, gestos, pantalla completa, aviso compacto, fondo/`theme-color`), `src/app.js` (MIME del manifiesto y `manifest-src` en la CSP), `package.json` (3.1.2, scripts), `README.md`, `docs/OPERACION_EVENTO_MASIVO.md`.
**Nuevos**: `public/js/platform.js`, `public/manifest.webmanifest`, `public/icons/*.png` (generados por `tools/make-icons.js`), `test/png.js`, `test/plataforma.test.js`, `e2e/cobertura.test.js`, `docs/COBERTURA_PANTALLA.md`, este informe.
No se tocaron el protocolo, el servidor de tiempo real, el motor de efectos ni los límites de seguridad (strobe ≤ 3 Hz, duración máxima, autorización, movimiento reducido); el formato del QR no cambió.

## 3. Cobertura, Android e iOS

Ver `COBERTURA_PANTALLA.md` §2–§5. Resumen: capa `#remote-light` con 1 px de sangrado y `100lvh`; áreas seguras solo en la interfaz; fondo de `html/body` y `theme-color` sincronizados; Android/Chrome: Fullscreen API con gesto (primer toque o botón); iPhone/Safari: **sin Fullscreen API** → consejo honesto («aA → Ocultar barra de herramientas» o instalar), PWA con `apple-mobile-web-app-capable` y `black-translucent`.

## 4. Pruebas (comandos y resultados reales)

| Comando | Resultado |
|---|---|
| `npm run check` | 41 archivos, sintaxis OK |
| `REDIS_SERVER=<redis-server> npm test` | **102 / 102 pasan** (94 anteriores + 8 de plataforma/PWA), 0 omitidas |
| `npm run test:browser` | **23 / 23 pasan** (14 anteriores + 9 de cobertura, en Chrome real) |

Evidencia clave (mismo script antes/después, emulación): interfaz visible sobre el color **4 → 0**; píxeles distintos **3,3–3,8 % → 0,00 %**; `htmlBg`/`theme-color` ahora = color; horizontal sin scroll. Capturas PNG decodificadas: bordes y malla = color exacto en iPhone 14 (vertical/horizontal), Pixel 7 (DPR 2,625, vertical/horizontal), 360×640 y tableta. Giro/redimensionado en 5 tamaños: cubre y **no reinicia la fase** del efecto. Sincronización tras los cambios: 2–4 ms entre 4 teléfonos (Chrome de escritorio, mismo reloj). CPU del hilo principal (escritorio): sin regresión (fijo 0,13→0,04 %, pulso 2,23→1,47 %, strobe 2,85→1,50 %).
Defectos hallados **por las propias pruebas** y corregidos: fondo de `html`/`theme-color` un paso atrás al terminar una transición; aviso de desconexión del 5,7 % de pantalla; toque residual sobre «Salir» al abrir el panel.

**Etiqueta de las pruebas**: todo lo de iOS/Android es **emulación o entorno simulado** sobre Chrome de escritorio.

## 5. Limitaciones que una web no puede resolver

La barra de estado (hora/batería) y el indicador de inicio de iOS; ocultar la barra de Safari sin acción del usuario; brillo del sistema, True Tone/Night Shift, ahorro de batería y modo oscuro; los recortes físicos (notch, Dynamic Island, esquinas redondeadas, cámara perforada); la uniformidad fotométrica entre paneles distintos; la suspensión de WebSockets/animaciones con la pantalla bloqueada.

## 6. Instrucciones para participantes y protocolo físico

`COBERTURA_PANTALLA.md` §8 (texto para mostrar junto al QR) y §9 (protocolo de ensayo con planilla, incluida la medición de sincronía con cámara lenta). **Resultado del ensayo físico: PENDIENTE.**

## 7. Riesgos pendientes

Navegadores internos de apps y Samsung Internet sin verificar; `display: fullscreen` del manifiesto en Android y la instalación sin service worker (a propósito) sin verificar en dispositivo; `lvh`/barras reales de iOS; Wake Lock no garantizado; apertura accidental del panel con 5 toques; consumo de batería real no medido.
