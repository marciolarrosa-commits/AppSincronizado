# Cobertura de pantalla, modo espectáculo y plataformas (Android / iOS)

Auditoría lumínica de V3.1.1 (2026-10-09) y correcciones de V3.1.2. **Qué está comprobado y qué necesita un teléfono físico se separa explícitamente en cada sección.**

## 0. Cuatro validaciones distintas (no se confunden)

| Validación | Qué significa | Estado |
|---|---|---|
| **Cobertura web** | Toda la superficie web disponible (el viewport) está cubierta por el color, sin interfaz ni márgenes encima. | **Validada** en Chrome real con **emulación** móvil (§6): geometría, capas, estilos y **píxeles de captura**. No en Safari/iPhone ni en un Android físico. |
| **Pantalla completa del navegador** | El navegador acepta ocultar sus controles. | La lógica de solicitud/rechazo/ausencia está **probada con entornos simulados**; el efecto real en Safari y en Chrome Android **está pendiente de ensayo físico**. |
| **Cobertura física** | Un ensayo real demuestra qué partes visibles del panel (esquinas redondeadas, notch, barras) están iluminadas. | **Pendiente** (§9). |
| **Sincronización** | Las pruebas miden la desviación temporal entre dispositivos. | Medida en Chrome de escritorio (1–9 ms; **193 ms** con red asimétrica, `PROTOCOLO.md`). **No** medida en teléfonos reales (§9, método con cámara lenta). |

## 1. Qué determina el área iluminada (cadena de renderizado real)

`<html>` → `<body>` → `#remote-stage` (`position:fixed; inset:0`) → **`#remote-light`** (capa lumínica) → `#remote-ui` (interfaz) → `#remote-banner` (aviso mínimo).
El estado de conexión lo gestiona `remote.js` (`S.connected`, WebSocket); los comandos se aplican en `applyState()` y los efectos los calcula `effects.js` como función del tiempo del servidor; `paintLight()` es la **única** escritura de color.

## 2. Problemas encontrados y su causa (medidos en la versión V3.1.1)

Medición con Chrome real y emulación (iPhone 14 390×844 ×3, Pixel 7 412×915 ×2,625, horizontal 844×390), mismo script antes y después:

| # | Problema | Causa | Evidencia (antes → después) |
|---|---|---|---|
| 1 | **La interfaz tapaba el color todo el tiempo**: estado de conexión, código de sesión y botones «Pantalla completa» / «Efectos» quedaban siempre encima (y el texto cambiaba de color según el fondo). | No existía separación entre la interfaz de incorporación y la superficie lumínica: todo vivía dentro de `.remote-stage` con `position:fixed` y `z-index` mayores que el fondo. | Elementos de interfaz visibles: **4 → 0**. Píxeles distintos del color pedido: **3,3–3,8 % → 0,00 %**. |
| 2 | **`<html>`/`<body>` conservaban el fondo oscuro de la app** (`oklch(12% …)`): en iOS el rebote de scroll y las áreas bajo barras translúcidas lo muestran como franja oscura. | El color solo se aplicaba a `.remote-stage`. | `htmlBg`: `oklch(0.12 …)` → `rgb(255, 59, 48)`. |
| 3 | **La página original seguía en el DOM y podía desplazarse debajo** (en horizontal `scrollHeight > innerHeight`): rebote/scroll revela el fondo oscuro. | `<main class="stage">` y `.topbar` seguían visibles detrás de la capa. | Horizontal: `scrollable: true → false`; `html.remote-on` oculta la interfaz original y fija `overflow:hidden`, `overscroll-behavior:none`. |
| 4 | **Sin `theme-color`, sin manifiesto, sin metadatos de iOS**: las barras del navegador no se tintaban y no había forma de instalar la página en modo independiente. | Faltaban en `index.html`. | `theme-color: null → #ff3b30` (se actualiza con cada color); manifiesto e iconos presentes. |
| 5 | **Pantalla de incorporación visible un instante** al abrir el QR (la app original antes del modo remoto). | La clase de modo remoto se aplicaba al final del script. | Un script en `<head>` marca `remote-on` antes del primer pintado (autorizado por hash en la CSP). |
| 6 | **Riesgo de líneas finas en DPR fraccionario** (p. ej. 2,625) entre la capa y el borde del viewport. | Una capa `inset:0` exacta puede dejar un píxel físico sin cubrir por redondeo. | La capa lumínica tiene **1 px de sangrado** por lado (`top/right/bottom/left: -1px`) y `min-height: 100lvh + 2px` (viewport grande: sin franjas cuando la barra del navegador se retrae). Verificado con captura en DPR 2,625: 0 píxeles distintos. |
| 7 | **Parpadeo inicial**: el escenario arrancaba en `#050505` (casi negro, no negro). | Color de fondo del CSS. | Negro puro `#000` hasta recibir el estado vigente. |
| 8 | Defecto hallado por las pruebas: el fondo de `<html>`/`theme-color` podía quedar **un paso atrás** al terminar una transición (limitación de frecuencia mal resuelta). | `paintLight` descartaba el último cuadro si un cuadro anterior ya había producido el mismo texto de color. | Corregido y cubierto por la prueba «EFECTOS». |
| 9 | Defecto hallado por las pruebas: el aviso de desconexión ocupaba el **5,7 %** de la pantalla (texto largo). | El mismo texto de la pantalla de incorporación. | Pastilla compacta con texto corto y solo tras >10 s sin conexión. |
| 10 | Riesgo de UX hallado en el diseño: el **6.º toque** (tras abrir el panel con 5) caía sobre un botón (p. ej. «Salir»). | El panel aparece bajo el dedo. | Los botones ignoran toques 700 ms tras abrir el panel y «Salir» pide confirmación. |

Elementos **sin problema** encontrados: el escenario ya cubría exactamente el viewport (`0,0,W,H`), `viewport-fit=cover` ya estaba, las áreas seguras no creaban márgenes en el fondo (solo se usaban en la interfaz), y el motor de efectos pintaba la capa completa.

## 3. Solución aplicada

**Capas** (de abajo hacia arriba):

1. `html`/`body`: se sincronizan con el color de la capa lumínica (≈4 actualizaciones/s en animaciones; el valor final siempre se escribe) y con `<meta name="theme-color">`.
2. **`#remote-light`** — capa lumínica principal, `position:fixed`, sangrado de 1 px, `contain:strict`. **Es la única que recibe colores.**
3. `#remote-ui` — interfaz de incorporación / panel de diagnóstico. **`hidden` en modo espectáculo.** Las áreas seguras (`env(safe-area-inset-*)`) se aplican **solo aquí**.
4. `#remote-banner` — pastilla mínima de desconexión (solo en modo espectáculo si pasan >10 s sin conexión, o si es un error fatal).

Más: `html.remote-on` oculta la interfaz de la app original (modo micrófono, sin tocarla), bloquea scroll/rebote y el zoom por pellizco (`gesturestart` en iOS); `color-scheme: dark` evita la oscurización forzada de algunos navegadores; `cursor:none` en modo espectáculo.

## 4. Modo espectáculo

* **Pre-espectáculo (`preshow`)**: pantalla negra + interfaz: sesión, estado de conexión, consejo de pantalla completa para ESTE dispositivo y botón **«Entrar al espectáculo»** (también «Pantalla completa», «Efectos», «Salir»). Sin código de sesión (aplicación instalada) se muestra el formulario para escribirlo.
* **Entrada**: al tocar «Entrar al espectáculo» (gesto válido → se solicita pantalla completa) **o automáticamente al aplicarse la primera orden distinta de «apagado»** (`?show=0` lo desactiva para diagnóstico).
* **Durante el espectáculo**: nada por encima del color. **El primer toque en la superficie solicita pantalla completa** (requiere gesto en Android); **5 toques seguidos (≤ 2,5 s) o la tecla Esc** abren el panel de diagnóstico (sesión, versión, resolución CSS, DPR, modo de visualización, estado de pantalla completa, desfase de reloj y RTT) con **«Volver al espectáculo»** y **«Salir»** (con confirmación). El panel se cierra solo a los 10 s.
* **Parada y recuperación**: la orden `stop` del Master pone la superficie en negro (sigue en modo espectáculo, sin texto); las órdenes siguen funcionando con el panel abierto o cerrado.
* **Reconexión**: el modo **se conserva**; se muestra el último estado congelado (y los efectos animados pasan a color fijo tras 10 s sin conexión). Si el corte dura más de 10 s aparece la pastilla compacta; al reconectar se aplica el estado vigente y no reaparece un color obsoleto.
* **Salida**: «Salir» cierra la conexión, libera el bloqueo de pantalla y restaura la interfaz original (pantalla de despedida).
* **Diagnóstico controlado**: `?debug=1` muestra los datos solo en la pantalla de incorporación; en modo espectáculo únicamente con el panel abierto.

## 5. Android frente a iOS

| Aspecto | Android (Chrome) | iPhone (Safari) | iPhone (instalada en pantalla de inicio) |
|---|---|---|---|
| Fullscreen API (`requestFullscreen`) | **Sí**, requiere gesto; el código pasa `{navigationUI:'hide'}` y gestiona promesa resuelta/rechazada. Oculta barra de estado y de navegación del navegador. | **No existe** para elementos de página (solo vídeo). El código detecta la ausencia y **no la presenta como solución**. | No aplica (ya sin barra de Safari). |
| Barra del navegador | Se oculta en pantalla completa. | **Se puede ocultar** con «aA → Ocultar barra de herramientas» o instalando la página. La web no puede hacerlo sola. | **No hay** barra de Safari. |
| Barra de estado del sistema (hora, batería) | Oculta en pantalla completa inmersiva (a validar en dispositivo). | **Siempre visible** (controla iOS). | `black-translucent`: el contenido llega **bajo** la barra de estado (con `viewport-fit=cover`), pero iOS sigue dibujando hora/batería encima. |
| Indicador de inicio / gestos | Barra de gestos del sistema: puede ocultarse en inmersivo. | **Siempre visible** (controla iOS). | Siempre visible. |
| Notch / Dynamic Island / esquinas redondeadas | La superficie cubre el viewport; el panel físico no tiene píxeles en el recorte. | Ídem; en vertical el área de la página empieza bajo la barra de estado salvo instalada. | Ídem; con `black-translucent` el color llega al borde superior. |
| `theme-color` | Tiñe la barra de direcciones/estado (se actualiza con cada color). | Safari 15+ tiñe la barra compacta (comportamiento parcial; a validar). | No aplica. |
| Instalación | Manifiesto con `display: fullscreen` (+ `display_override`). **Sin service worker a propósito** (evita cachear código viejo durante un evento): el aviso de instalación de Chrome puede no aparecer; «Agregar a pantalla de inicio» desde el menú sí. | — | «Compartir → Agregar a pantalla de inicio»; `apple-mobile-web-app-capable`. |
| Abrir desde el QR | La cámara/Lens puede abrirlo en Chrome o en un **navegador interno** (sin pantalla completa). | La cámara abre **Safari**; otras apps pueden abrir un visor interno. | Hay que abrir el ícono e **ingresar el código** (la sesión no viaja en el ícono). |

Qué controla y qué NO una página web: **sí** el color de todo el viewport, el fondo bajo barras translúcidas, `theme-color`, la solicitud de pantalla completa donde existe y el bloqueo de suspensión de pantalla (Wake Lock, si el navegador lo permite). **No**: la barra de estado y el indicador de inicio de iOS, el brillo del sistema, True Tone/Night Shift/modo oscuro del sistema/ahorro de batería, ni los recortes físicos del panel.

## 6. Pruebas realizadas y resultados (reales)

| Conjunto | Qué comprueba | Resultado |
|---|---|---|
| `test/plataforma.test.js` (8, 8 pasan) | Detección iPhone/Safari, iPhone/Chrome, Android, iPad, modo instalado; `requestFullscreen` con promesa/rechazo/excepción/WebKit síncrono/ausencia (entornos **simulados**); consejos por plataforma; `normalizeCode`; metadatos del `<head>`; CSS de la capa (sin padding, sin `env()` en el fondo, `100lvh`, sangrado); manifiesto, iconos PNG válidos (dimensiones leídas del IHDR) y tipo MIME; CSP con `manifest-src`; el enlace del QR conserva su formato. | **pasan** |
| `e2e/cobertura.test.js` (9, Chrome real, **emulación**) | **Cobertura** en 6 perfiles (iPhone vertical/horizontal, Pixel vertical/horizontal con DPR 2,625, 360×640, tableta): capa = viewport; 81 puntos de la malla con la capa como elemento superior; ninguna interfaz visible; fondos de capa/`<html>`/`<body>` y `theme-color` = color; sin scroll; **captura PNG: 0 píxeles distintos en bordes y malla y 0 % de discrepancia en toda la captura** para 4 colores, intensidad 0,5 y «apagado». **Giro/redimensionado** (5 tamaños): cubre y **no reinicia el efecto** (mismo `executeAt`, misma versión, color = motor evaluado en el tiempo común). **Modo espectáculo**: entrada manual y automática, primer toque pide pantalla completa (1 llamada), 5 toques abren el panel, toque residual ignorado, Esc, autocierre a 10 s, «Salir» con confirmación y limpieza. **Pantalla completa**: aceptada, rechazada (`NotAllowedError`), ausente (iPhone simulado → instrucción honesta) e instalada simulada. **Incorporación**: enlace sin código → formulario, validación, URL actualizada, QR directo, app original oculta. **Reconexión**: modo conservado, aviso solo tras 10 s y compacto (<5 % de pantalla), sin color obsoleto. **Efectos**: transición termina exacta, strobe ≤ 3 Hz medido sobre lo pintado, movimiento reducido = color fijo. **Sincronización**: 4 teléfonos 2–4 ms. **CPU**. | **9 de 9 pasan** |
| Existentes | ACK/idempotencia, red móvil, servidor, E2E previos | **sin regresiones**: `npm test` 102/102 y `npm run test:browser` 23/23 |

Medición de CPU del hilo principal (Chrome de escritorio headless; **no** es un teléfono de gama baja), versión anterior → nueva: color fijo 0,13 → 0,04 %; pulso 2,23 → 1,47 %; strobe 2,85 → 1,50 %; `requestAnimationFrame`/s: 0 / 27–29 / 60 en ambas (no hay regresión). La batería real **no** se midió.

**Lo que estas pruebas NO demuestran**: nada del comportamiento real de Safari en iPhone ni de Chrome en un Android físico (barras del sistema, notch real, `lvh` real con la barra retraída, Wake Lock, gestos, fullscreen real).

## 7. Color solicitado, color renderizado y luz emitida

1. **RGB solicitado** (`#FF3B30`): lo que ordena el Master; se valida como sRGB de 8 bits.
2. **Color renderizado por el navegador**: lo que Chrome/Safari pintan; hay conversión de espacio de color (los paneles anchos tipo Display-P3 interpretan sRGB), perfil del dispositivo y posible dithering. Las pruebas de este repositorio verifican el **valor renderizado en una captura** (idéntico al pedido en Chrome de escritorio), no lo que sale del panel.
3. **Luz que emite el panel**: depende de la tecnología (OLED/LCD), el brillo del usuario, brillo automático, True Tone/Night Shift, ahorro de batería, modo oscuro, tolerancias de fabricación y envejecimiento. **Dos teléfonos distintos producirán brillo y matiz fotométricos distintos para el mismo RGB; no se puede garantizar uniformidad** (y un OLED no ilumina como un LCD en negro/blanco, ni a igual PWM). Recomendación: subir el brillo al máximo, desactivar brillo automático y Night Shift/True Tone, y escoger colores saturados y blancos en lugar de matices muy cercanos.
4. `intensity` atenúa el RGB (lo mezcla con negro): no sustituye al brillo del dispositivo.

## 8. Instrucciones para los participantes (texto para mostrar junto al QR)

**Todos**: 1) escaneá el QR · 2) tocá **«Entrar al espectáculo»** · 3) subí el **brillo al máximo** y mantené la pantalla encendida · 4) no cambies de aplicación.
**Android (Chrome)**: tocá la pantalla una vez para activar la pantalla completa. Si abrió en otra app (Instagram, WhatsApp…), elegí **«Abrir en Chrome»**.
**iPhone**: tocá **«aA» → «Ocultar barra de herramientas»** (o **Compartir → Agregar a pantalla de inicio** y abrí «Destello» desde el ícono; allí ingresá el código de la sesión). La hora y la batería las controla iOS: no se pueden ocultar.
**Salir o ver datos**: tocá **5 veces seguidas** la pantalla (o pulsá Esc en un ordenador).

## 9. Protocolo de ensayo físico (antes de usarlo en un evento)

**Materiales**: 1 Android con Chrome, 1 iPhone con Safari (y el mismo iPhone con la app instalada), un segundo teléfono con cámara lenta (≥ 240 fps) para medir sincronía, el panel Master en otro dispositivo, cinta/regla de papel opcional.
**Preparación**: servidor en el entorno real o staging; sesión nueva; anotá la versión (etiqueta `v3.1.2-cobertura`). Brillo al máximo, brillo automático y Night Shift/True Tone apagados.

| Paso | Acción | Criterio de aprobado |
|---|---|---|
| A | Abrir el QR con la cámara del teléfono | Abre la URL `/?s=CODIGO&mode=remote`; no se ve la app original; aparece la pantalla de incorporación negra con «Entrar al espectáculo». |
| B | Tocar «Entrar al espectáculo» (Android) | Se acepta o rechaza la pantalla completa: **registrar** (diagnóstico: 5 toques). Si es aceptada, no quedan barras del navegador. |
| C | Master: `#FF0000`, `#00FF00`, `#0000FF`, `#FFFFFF`, `#000000` | Cada color llega a **los cuatro bordes del área visible**; sin texto ni botones; fotografiar cada borde y esquina de frente. |
| D | iPhone/Safari: sin ocultar nada; luego con «Ocultar barra de herramientas»; luego app instalada | Registrar qué barras quedan (estado, herramientas, indicador de inicio). El color debe llenar todo el viewport visible de cada modo. |
| E | Girar a horizontal y volver (y bloqueo de orientación apagado) | Sin franjas; el efecto en curso sigue en fase (no se reinicia). |
| F | Master: `fade`, `pulse`, `strobe` (previo aviso, ≤3 Hz) | Efectos cubren todo el área; el strobe se detiene solo a la duración indicada; **DETENER TODO** apaga todas las pantallas. |
| G | Modo avión 15 s con el Master cambiando de color; luego salir | Durante el corte no aparece aviso <10 s (después, pastilla mínima); al volver, muestra el color vigente sin parpadeos del anterior. |
| H | Bloquear y desbloquear la pantalla / cambiar de app y volver | Reconecta y aplica el estado vigente (documentar si iOS suspende el WebSocket). |
| I | Sincronía: poner 3–6 teléfonos juntos y filmar en cámara lenta mientras el Master cambia de color | Contar fotogramas entre el primer y el último cambio (a 240 fps, 1 fotograma ≈ 4 ms). Registrar la dispersión. |
| J | Salida | 5 toques → «Salir» (2 toques) → pantalla de despedida; la hora/batería de iOS sigue visible (esperado). |

**Planilla** (una fila por dispositivo y modo):

| Campo | Valor |
|---|---|
| Modelo / versión del sistema operativo | |
| Navegador y versión | |
| Modo de apertura (Safari, Chrome, cámara→navegador interno, ícono instalado) | |
| Resolución CSS y viewport (panel de diagnóstico) / DPR | |
| ¿Pantalla completa solicitada? aceptada / rechazada (motivo) / sin API | |
| ¿El color alcanza los 4 bordes del área visible? (arriba/abajo/izq./der.) | |
| ¿Queda alguna barra, margen, texto o interfaz visible? ¿cuál? | |
| ¿El color cambia correctamente tras un comando? | |
| Dispersión de sincronía medida (ms) | |
| Resultado: **aprobado / rechazado / pendiente** · fecha · responsable | |

**Resultado actual del ensayo físico**: **PENDIENTE** (no se dispuso de dispositivos físicos). No se declara compatibilidad real con iOS ni con Android hasta completarlo.

## 10. Riesgos pendientes

* iPhone en Safari **no** puede ocultar su barra ni la barra de estado desde la web: la cobertura del panel completo en Safari sin instalar **no es posible**; la instalada llega más cerca (barra de estado translúcida con hora/batería).
* Navegadores internos de apps (Instagram, WhatsApp, etc.) y Samsung Internet: comportamiento de fullscreen/`theme-color`/`lvh` **no verificado**.
* `display: fullscreen` del manifiesto en Android (barra de estado/gestos) y la instalación sin service worker: **a validar** en dispositivo.
* iOS suspende WebSockets y animaciones con la pantalla bloqueada o la pestaña en segundo plano; Wake Lock no está garantizado.
* Uniformidad fotométrica entre teléfonos: **no garantizable** (§7).
* El panel de diagnóstico se abre con 5 toques: un asistente puede abrirlo sin querer (se cierra a los 10 s; no afecta a la superficie salvo mientras está abierto).


## Colores atenuados en Samsung: blanco → gris, amarillo → marrón (V3.2.2)

**Qué se sabe (verificado):** la página pide y pinta el color exacto (`intensity` = 1; las pruebas con Chrome miden el 100 % de los píxeles con el color pedido). «Blanco que se ve gris» y «amarillo que se ve marrón» son el **mismo tono con menos luminancia**: no es un cambio de color sino una pantalla más oscura. Sobre un Samsung S24 Ultra / S26 reales **no se pudo reproducir ni medir desde aquí**: lo que sigue son causas probables que el diagnóstico permite distinguir.

| # | Causa probable | Cómo se reconoce en el diagnóstico (5 toques en la pantalla) | Qué hacer |
|---|---|---|---|
| 1 | **Android atenúa la pantalla por inactividad** (antes de apagarla) porque la web no logró mantenerla encendida (Wake Lock rechazado o liberado) | `Pantalla encendida (Wake Lock): DENEGADA (…)`, `NO disponible…` o `liberada…` | 3.2.2 reintenta el Wake Lock (1 s, 2 s, 4 s… hasta 30 s), lo vuelve a pedir si el sistema lo libera y lo reintenta con cada toque. En el teléfono: desactivar el ahorro de energía y abrir en Chrome. |
| 2 | **Brillo bajo o «Brillo adaptable»** (la web no puede subir el brillo del sistema) | `Wake Lock: activa` y `calculado = pintado = el color pedido`, pero la pantalla se ve oscura | Brillo al máximo y desactivar «Brillo adaptable» antes del espectáculo. |
| 3 | **Protección ocular / filtro de luz azul** («Eye comfort shield») | Igual que 2 (el filtro es del sistema); suele teñir cálido (blanco amarillento) | Desactivarlo. |
| 4 | **Modo oscuro de sitios web** del navegador (Samsung Internet / Chrome «Auto Dark Mode») | `COLORES FORZADOS` o `tema oscuro`, o `calculado` distinto de `pintado` | Desactivar el modo oscuro para webs en el navegador. |
| 5 | **Ahorro de energía** (limita brillo y puede negar el Wake Lock) | Wake Lock `DENEGADA` | Desactivarlo durante el evento. |
| 6 | **Transición en curso** (Fijo con `fadeMs` 500 parte del color anterior; desde negro, el blanco pasa por gris) | Se resuelve sola en 0,5 s; si persiste, no es esta causa | — |

**Cómo leer la línea de color:** `Color: calculado rgb(255, 255, 255) · pintado rgb(255, 255, 255)`. Si ambos son el color pedido y aun así se ve gris, la causa está fuera de la página (teléfono/navegador). Si `calculado` o `pintado` no coinciden con lo pedido, es un defecto de la app: enviar una captura del diagnóstico. Para verlo sin esperar una orden, abrir el enlace con `&debug=1` (aparece en la pantalla de incorporación).

**Texto para el público (junto al QR):** «Subí el brillo al máximo, desactivá el ahorro de energía y la protección ocular, y abrí el enlace en Chrome. Dejá la pantalla encendida y la pestaña en primer plano.»

**Límite que una web no puede resolver:** una página no puede forzar el brillo máximo del sistema ni impedir toda atenuación; una aplicación nativa sí. Si el ensayo físico confirma que es la causa dominante, la alternativa es una app instalable (hoy no existe y la instalación sería un paso extra para 20 000 personas).
