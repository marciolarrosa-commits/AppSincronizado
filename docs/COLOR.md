# Color: por qué el blanco y el amarillo no se ven igual en todos los teléfonos

Análisis de ingeniería de color (V3.4.1). Lo **calculado con un modelo** está separado de lo **no medido** (no hubo teléfonos físicos ni colorímetro). Síntoma de partida: en iPhone el amarillo y el blanco «parecen iguales»; en un Samsung S24 Ultra el blanco se ve gris y el amarillo marrón.

## 1. Lo que la aplicación envía

El cliente pinta **exactamente** el valor recibido en sRGB (`#FFFFFF` → `rgb(255,255,255)`, `#FFD400` → `rgb(255,212,0)`), sin filtros, opacidades ni superposiciones, con `color-scheme: dark` y la capa lumínica a pantalla completa. Está comprobado en Chrome real (`e2e/pantalla.test.js`). **El software no es la causa de la diferencia entre modelos**: lo que cambia es lo que cada teléfono hace con ese color antes de que la luz llegue al ojo.

## 2. Diagnóstico

### 2.1 Samsung: «blanco → gris» y «amarillo → marrón» son el mismo fenómeno

Gris no es un tono: es *blanco con poca luz*. Marrón tampoco: es *amarillo/ámbar con poca luz* visto en un entorno oscuro. Que los dos síntomas aparezcan juntos es la firma de una **pérdida de luminosidad**, no de un error de matiz. Un error de matiz (p. ej. un filtro cálido) volvería el blanco *amarillento* y el amarillo *anaranjado*, no gris/marrón.

Modelo (luz lineal reducida; L* = luminosidad percibida, 100 = blanco pleno):

| Color | Luminancia relativa | L* al 100 % | L* al 60 % de luz | L* al 35 % de luz |
|---|---|---|---|---|
| Blanco `#FFFFFF` | 1,00 | 100 | **82** (gris claro) | **66** (gris medio) |
| Amarillo actual `#FFD400` | 0,68 | 86 | **70** (mostaza) | **56** (marrón/ocre) |
| Amarillo `#FFF000` | 0,84 | 93 | 76 | 61 |
| Amarillo puro `#FFFF00` | 0,93 | 97 | **79** | **64** |

Causas probables en un Samsung (**hipótesis, no verificadas en el equipo**), de más a menos probable:

1. **Brillo reducido**: brillo adaptable / automático, ahorro de energía (limita el brillo máximo), «Atenuación extra», o el límite automático de brillo de los OLED con **campo completo** (un 100 % de pantalla blanca tiene menos brillo sostenido que un 10 %). El brillo máximo manual es menor que el pico solar de las fichas técnicas.
2. **Pantalla apagándose**: Android atenúa antes de apagar. Corregido en V3.2.3 (Wake Lock con reintentos y diagnóstico); si el navegador lo deniega aparece en el panel de diagnóstico del teléfono.
3. **Modo oscuro forzado del navegador** (p. ej. «Modo noche» de Samsung Internet): puede oscurecer los fondos claros. Chrome no lo aplica a páginas con `color-scheme: dark`, como esta.
4. **Filtro de luz azul / «Protección ocular»**: tiñe de cálido (ver 2.2) y, combinado con 1, explica el marrón.

### 2.2 iPhone: «blanco ≈ amarillo»

El amarillo se diferencia del blanco **solo por el canal azul** (0 frente a 255), que aporta apenas el 7 % de la luminancia. Todo lo que *quita azul al blanco* acerca el blanco al amarillo: True Tone, Night Shift y «Protección ocular» en Android.

Modelo (ΔE2000 entre blanco y amarillo; ≥ 10 claramente distintos, < 5 casi iguales):

| Escenario de pantalla | `#FFD400` | `#FFF000` | `#FFFF00` |
|---|---|---|---|
| Nominal | 30,6 | 30,3 | 30,5 |
| Atenuado al 35 % | 27,1 | 26,8 | 27,0 |
| Filtro cálido medio (≈ 4 500 K) | 23,4 | 22,8 | 23,2 |
| Filtro cálido fuerte (≈ 3 400 K) | 17,6 | 16,8 | 17,4 |
| Filtro cálido fuerte + atenuado 60 % | 16,8 | 16,0 | 16,5 |

**Lectura honesta**: lado a lado, el modelo dice que **siguen siendo claramente distintos** (ΔE ≥ 16). El «igual» que se percibe ocurre al verlos **uno después del otro y a pantalla completa**: el ojo se adapta al color del campo entero y pierde la referencia (adaptación cromática), y con un blanco cálido el contraste con un amarillo pálido se reduce. Eso es un efecto perceptivo que este modelo no calcula; **no está medido**.

### 2.3 Los dos síntomas piden cosas contrarias

* iPhone: *más separación de color* entre blanco y amarillo.
* Android: *más luminosidad* del amarillo.

Cambiar la paleta no resuelve ambos. Lo que sí es común: **controlar el brillo y los filtros del teléfono**, y **no depender de que blanco y amarillo se distingan**.

## 3. Lo que la web no puede hacer

* Fijar el brillo (no existe API en navegadores).
* Desactivar True Tone, Night Shift, filtros de luz azul o ahorro de energía.
* Conocer la luminancia real de la pantalla.

Sí puede (y hace) mantener la pantalla encendida (Wake Lock). Una **app nativa** podría fijar el brillo al máximo mientras dura el espectáculo (`WindowManager.screenBrightness` en Android, `UIScreen.brightness` en iOS); es la única vía técnica para eso y no está implementada.

## 4. Herramienta de diagnóstico: `/colores`

Página nueva y autónoma (`https://<tu-dominio>/colores`), sin sesión ni conexión al servidor de sincronía. Muestra: escala de blanco atenuado (100 → 35 %), cinco amarillos/naranja, pares blanco | amarillo, campo completo con cronómetro y el entorno del teléfono (gama, HDR, modo oscuro, colores forzados, Wake Lock).

**Ensayo recomendado** (15 min con 2 teléfonos):
1. Brillo al máximo y sin filtros; abrir `/colores` en ambos.
2. Foto de los dos teléfonos juntos (exposición bloqueada) con la escala y los pares.
3. Anotar en cuál parche de la escala el blanco del Samsung se parece al blanco del iPhone: es la **atenuación real**.
4. Repetir con los ajustes de §5 activados uno por uno para ver cuál recupera el color.
5. Campo completo blanco durante 60 s: ¿se oscurece solo?
6. Enviar la captura del bloque «Entorno» de cada teléfono.

## 5. Ajustes para el público (aviso previo al evento)

* **Samsung**: brillo al máximo, desactivar *Brillo adaptable*, *Ahorro de energía*, *Protección ocular* y *Atenuación extra*; *Modo de pantalla → Vívida*; usar Chrome (no el modo noche de Samsung Internet).
* **iPhone**: desactivar *True Tone*, *Night Shift*, *Brillo automático* y *Modo de bajo consumo*; brillo al máximo.

Los nombres exactos varían según versión del sistema.

## 6. Diseño del espectáculo

* **No poner blanco y amarillo contiguos** sin otro color o un negro corto entre medio. Si el contraste temporal falta, en un iPhone cálido se confunden.
* Preferir **amarillos claros** (`#FFF000` o `#FFFF00`: luminancia 0,84–0,93 frente a 0,68 de `#FFD400`): separan del blanco igual que el actual (ΔE ≈ 30) y resisten mejor la atenuación (no «se vuelven marrón»). **No se cambió la paleta del panel**: es una decisión del operador; se puede comparar en `/colores`.
* Los **naranjas y ámbares** (`#FF9F1C`, luminancia 0,46) son los que antes se vuelven marrón: usarlos solo con brillo controlado.
* Colores que sobreviven bien a la atenuación y a los filtros cálidos: rojo, verde, cian, magenta y azul **claro** (`#0A84FF`); el azul puro `#0000FF` aporta 7 % de luminancia y casi desaparece al atenuar.

## 7. No demostrado

* Que la causa en el S24 Ultra sea el brillo (hipótesis; falta el ensayo de §4 y el ajuste real del teléfono).
* Los números de §2.2 son un **modelo** (filtros aproximados como multiplicadores en luz lineal; ΔE2000 entre parches simultáneos); no se midió con colorímetro ni espectrofotómetro.
* El efecto perceptivo de adaptación cromática a campo completo no está calculado.
* Qué «aplicación» descargó el S26 (pendiente del usuario): puede ser un lanzador/ahorro que altere brillo o color.
