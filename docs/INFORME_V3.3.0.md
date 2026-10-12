# Informe V3.3.0: efecto «Secuencia de colores»

Versión 3.2.3 → **3.3.0** (función nueva). Protocolo: `PROTOCOLO.md` («Efecto `sequence`»). Entorno de las pruebas: Windows 11, Node 24, Chrome 154, Redis 5.0.14. **Nada se probó en teléfonos físicos ni en un estadio.**

## 1. Lo pedido → lo implementado

| Pedido | Implementación |
|---|---|
| Un color inicial y luego un segundo color «o más»; un **signo ＋** para agregar colores | Efecto **Secuencia** en `/master`: lista editable, «Color inicial» + botón **＋ Agregar color** (hasta 12; mínimo 2); cada fila se puede quitar (✕). |
| «Espera los segundos que definimos para cambiar de color» | **Segundos por color** (0,5–600 s), distintos para cada uno. |
| «Muestra el otro color» (por ejemplo una bandera de 2 colores) | Corte seco entre colores por defecto; opcional **transición entre colores** (ms). |
| «De forma ininterrumpida hasta que la app master indique que se detenga» | Al terminar el último color **vuelve al primero y repite sin fin**; solo se detiene con **DETENER TODO** (Esc) u otra orden. Opcional: duración total. |
| «Enciende la pantalla de los celulares que escanearon el código» | Misma vía que Fijo: todos los teléfonos conectados a la sesión, **sincronizados** (mismo tiempo de servidor). |

### Cómo usarlo
1. `/master` → crear/retomar sesión → efecto **Secuencia**.
2. Elegí el **Color inicial** (selector de la fila o paleta: tocá la fila y luego un color de la paleta) y los **segundos**.
3. **＋ Agregar color** para cada color adicional, con sus segundos.
4. (Opcional) **Transición entre colores (ms)** y **Duración total (s; 0 = hasta DETENER TODO)**.
5. **Margen de sincronización** (en estadio: «Seguro», 3 s) y **Aplicar a todos**. El indicador muestra `ACEPTADA…` y luego `APLICADA: n dispositivos confirmaron`.
6. **DETENER TODO** apaga todas las pantallas.

Ejemplo bandera de 2 colores: *Color inicial* `#75AADB` 3 s + *Color 2* `#FFFFFF` 3 s → alterna celeste/blanco cada 3 s, sin parar.

## 2. Criterios de ingeniería lumínica para un estadio a oscuras

* **Tiempos.** Con pasos **≥ 1 s** no se requiere strobe; lo recomendable para que el público «lea» la bandera es **2–4 s por color**. Un paso **< 1 s** se considera intermitente: el servidor exige habilitar el strobe (advertencia de fotosensibilidad) y limita la frecuencia de cambio a `MAX_STROBE_HZ` (3 Hz). Evitar rojo parpadeante rápido.
* **Deslumbramiento.** En oscuridad, un blanco al 100 % de brillo ocupa mucho campo visual; alternarlo con un color suave reduce el deslumbramiento. Usar colores **saturados** (primarios/secundarios); los tonos intermedios (amarillo, naranja) pierden saturación cuando el brillo baja: **medido en tu S24: el amarillo se veía marrón y el blanco gris** (ver `COBERTURA_PANTALLA.md`).
* **Brillo del teléfono.** Una web no puede subirlo: instruir al público (brillo al máximo, sin ahorro de energía ni «protección ocular»). Con el Wake Lock activo el teléfono no atenúa por inactividad.
* **Sincronía.** Todos cambian al mismo `executeAt`; en laboratorio (Chrome, mismo reloj) las diferencias fueron < 60 ms. En un estadio real dependen de la red: un teléfono cuya orden llega después del instante programado la aplica **de inmediato** (desfasado) y se cuenta como «llegada tardía». Usar margen **Seguro (3 s)** y ensayar.
* **Negro como color.** Un paso negro no emite luz (la pantalla «se apaga» visualmente): válido para efectos, pero en una secuencia con tiempos cortos parece un parpadeo.
* **Consumo.** Mientras dura la secuencia el teléfono dibuja ~30 cuadros/s (60 si hay pasos < 1 s). **No se midió el consumo de batería en un evento**; ensayar la duración real.

## 3. Reglas de seguridad y compatibilidad

* Solo el **Master autenticado** envía secuencias (un participante recibe `FORBIDDEN`).
* Validación del servidor: 2–12 pasos, colores `#RRGGBB`, cada paso 0,5 s–10 min, transición ≤ el paso más corto, duración ≤ `MAX_PULSE_DURATION_MS`; mensaje ≤ 2 KB (12 pasos caben).
* «Efectos: desactivados» o >10 s sin conexión: el teléfono queda **fijo en el primer color**. «Reducir movimiento» solo la afecta si hay pasos < 1 s.
* **Páginas ya abiertas con JavaScript anterior a 3.3.0 no conocen la secuencia** (la ignoran): hay que recargarlas. Antes de un evento, desplegar con antelación y pedir recargar o volver a escanear el QR.
* Las páginas V3.0 (sin `hello`) reciben un color sólido (el primero).
* Protocolo v1 sin cambios incompatibles: nuevo valor de `effect` y campo opcional `steps`.

## 4. Pruebas (ejecutadas)

| Comando | Resultado |
|---|---|
| `npm ci` | 0 vulnerabilidades |
| `npm run check` | sintaxis OK (50 archivos) |
| `npm test` **con** Redis 5.0.14 real | **151 / 151 pasan** |
| `npm test` **sin** Redis | 151 pruebas: **132 pasan, 0 fallan, 19 omitidas** (necesitan `redis-server`; no verificadas en esa corrida) |
| `npm run test:browser` (Chrome 154 de escritorio) | **36 / 36 pasan** |

Cobertura de la función: **unidad** (`test/secuencia.test.js`: motor del teléfono —orden, bucle sin deriva tras 100 000 ciclos, transición, duración finita, efectos desactivados/sin conexión/reducir movimiento, validación de lo recibido— y validación del protocolo con todos los rechazos), **integración** (servidor + WebSocket reales: aceptación, publicación íntegra, regla de strobe, errores con `commandId`, solo Master, 12 pasos, página V3.0, DETENER TODO), **Redis real** (publicación entre dos instancias, duplicado, recuperación al unirse tarde) y **E2E en Chrome** (`e2e/secuencia.test.js`: el editor con ＋/✕/paleta/12 máx., 3 teléfonos —normal, «reducir movimiento», «Efectos desactivados»—: ciclo R→G→B→R ininterrumpido, ≥ 90 % de muestras idénticas entre teléfonos, rechazo de paso de 0,5 s sin strobe, DETENER TODO).

## 5. Limitaciones

* Sin ensayo en **dispositivos físicos** (iPhone/Samsung) ni en estadio; **60 000 dispositivos no demostrado** (ver `CARGA.md`).
* El panel no tiene **vista previa** de la secuencia ni **plantillas** (banderas/colores de clubes): propuestos como siguiente paso.
* No hay «mosaico»: todos los teléfonos muestran el mismo color a la vez (no un color distinto por sector de la tribuna).
* Persisten las limitaciones de brillo/atenuación de la sección 2 y las de `COBERTURA_PANTALLA.md`.

## 6. Despliegue

Sin variables nuevas. Ensayo en un servicio aparte (como en `INFORME_V3.2.1.md` §8); verificar `GET /api/admin/status` → `version: "3.3.0"` y `GET /js/orders.js` → 200. Rollback: *Deploys → Rollback* en Render (protocolo compatible; las secuencias ya enviadas simplemente dejan de mostrarse en clientes antiguos).
