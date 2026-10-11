# Informe V3.2.2: colores atenuados en Samsung (diagnóstico y Wake Lock)

Versión 3.2.1 → **3.2.2**. Detalle de causas y guía para participantes: `COBERTURA_PANTALLA.md` («Colores atenuados en Samsung»).

## Síntoma reportado

En un Samsung S24 Ultra el blanco se ve gris y el amarillo marrón; también se probó en un S26. **No se pudo reproducir ni medir en esos teléfonos desde aquí.**

## Qué se verificó

* El código **no atenúa**: `intensity` vale 1 en servidor y panel; `evaluate()` devuelve el color exacto; las pruebas con Chrome miden el color pedido en el 100 % de los píxeles.
* Gris y marrón son el mismo tono con menos luminancia → una pantalla atenuada o un modo del navegador, no un matiz distinto.

## Defecto real encontrado (y corregido)

El **Wake Lock** (mantener la pantalla encendida) se pedía **una sola vez** y cualquier rechazo se ignoraba en silencio; si el sistema lo liberaba, no se pedía de nuevo hasta que cambiara la visibilidad. Un teléfono quieto en un evento puede así **atenuarse** antes de apagarse (blanco→gris, amarillo→marrón). Cambios en `public/js/remote.js`:

* reintento con espera creciente (1, 2, 4 … máx. 30 s) si el navegador lo rechaza;
* se vuelve a pedir si el sistema lo libera estando visible, y con cada toque en la pantalla;
* el estado y el error se muestran en el panel de diagnóstico (`Wake Lock: activa / DENEGADA (NotAllowedError) / NO disponible / liberada`);
* nueva línea `Color: calculado … · pintado … · tema … · gama … · bits` para distinguir «la página pinta mal» de «el teléfono atenúa»; el panel se refresca cada segundo mientras está abierto.

## Pruebas

* `e2e/pantalla.test.js` (3, Chrome real con un Wake Lock **simulado**): rechazo→reintento→concedido→liberado→re-solicitado; rechazo permanente y navegador sin soporte se informan; el diagnóstico muestra el color calculado y el pintado para blanco y amarillo exactos.
* No prueban un Samsung real: demuestran la lógica de reintento y que el diagnóstico informa lo que el navegador reporta.

## Qué falta (necesito datos del teléfono)

1. Abrir el enlace en el S24 con `&debug=1` (o dar 5 toques en la pantalla en modo espectáculo) y enviar una **captura del diagnóstico** con el blanco en pantalla: dirá si el Wake Lock está activo y si `calculado`/`pintado` son blancos.
2. Navegador usado (Chrome o Samsung Internet) y si están activos: brillo adaptable, protección ocular, ahorro de energía, modo oscuro para webs.
3. Qué «app» pidió descargar en el S26: si fue Chrome/Samsung Internet para abrir el enlace, o si apareció la oferta de instalar la pantalla como aplicación; la web no requiere ninguna app.

## Limitaciones

* Una web no puede forzar el brillo del sistema; si la causa es brillo/ahorro/filtro del teléfono, la mitigación es la instrucción al público o una app nativa (no existe hoy).
* Sin ensayo físico no se puede afirmar que esto resuelva el caso del S24.
