# Sincronización de miles de teléfonos que escanean el QR en momentos distintos

Análisis de ingeniería de sistemas (V3.4.0). Lo **medido** en Chrome real y lo **simulado** está separado de lo **no demostrado** (estadio real, teléfonos físicos).

## 1. Respuesta corta

**Ningún teléfono arranca «su» secuencia cuando escanea.** El servidor fija un instante absoluto `executeAt` y cada teléfono calcula el color como una **función del tiempo de servidor**:

```
color(t) = paso activo de la secuencia en  (horaServidor(t) − executeAt) mod duraciónDelCiclo
```

Quien escanea 5 ms o 5 minutos después cae en la **misma fase** que los demás: no hay un contador que arranque con el escaneo. Lo único que cada teléfono necesita es saber **qué hora es en el servidor**, con la mayor exactitud posible. Todo el trabajo de sincronía consiste en estimar esa hora (y en dibujar el cambio justo en el instante).

```
 orden ──► executeAt = T0 (hora de servidor)                     fronteras: T0, T0+3 s, T0+6 s …
 teléfono A (escanea antes)  ········ rojo ─────────┐ verde ─────────┐ rojo …
 teléfono B (escanea +120 ms) ·········· rojo ──────┤ verde ─────────┤ rojo …      ← cambian en la MISMA hora de servidor
 teléfono N (escanea +7 s)         se une aquí → ve VERDE de inmediato (no empieza desde rojo)
```

Esto se verifica en `e2e/sincronia.test.js` («escanea a mitad de la secuencia»): el teléfono que se une en el segundo tramo muestra el color correcto desde el primer cuadro y nunca pasa por el primero.

## 2. Qué puede desfasar a dos teléfonos (y cuánto)

| Fuente de error | ¿Afecta? | Magnitud | Tratamiento |
|---|---|---|---|
| **Hora de pared del teléfono mal puesta** | **No** | — | El reloj usa `performance.now()` (monotónico, propio de la página), no la hora del teléfono. Probado con relojes desfasados ±20 s. |
| **Instante en que se escanea / carga la página / conecta** | **No** | — | La fase depende solo de la hora de servidor (ver §1). |
| **Error del reloj estimado al ingresar** | Sí | antes ≈ la demora de bajada (**media 62–126 ms**, hasta 176) durante 0,1–0,35 s; ahora ≈ (subida − bajada)/2 (**2–10 ms**) | V3.4.0: se compensa con el viaje `hello→welcome` (RTT/2); al reconectar se conserva la estimación previa. |
| **Asimetría de la red** (subida ≠ bajada) | Sí — **límite físico** | error = (subida − bajada)/2, siempre ≤ RTT/2 | No se puede medir desde el teléfono. Se **acota** con el RTT que cada teléfono informa (panel: «Reloj de los teléfonos»). |
| **Jitter** | Poco | se atenúa quedándose con la muestra de menor RTT de 6–12 pings | Ráfaga de 6 pings al unirse + 1 cada ~30 s. |
| **Dibujo (planificación del cuadro)** | Sí | antes hasta **35 ms** (p95; sondeo a ~30 fps); ahora **≤ 1 cuadro (12–15 ms p95)** | V3.4.0: la secuencia solo dibuja cerca de cada frontera (despierta 40 ms antes y evalúa a 60 fps). |
| **Relojes de varias instancias del servidor** | Sí si no se corrige | la diferencia entre relojes (decenas–cientos de ms) se sumaba a los teléfonos de esa instancia | V3.4.0: todas las marcas de tiempo salen de la hora del almacenamiento compartido (`Redis TIME`). Probado con +900 / −700 ms. |
| **Latencia de la pantalla/SO** (8–50 ms según modelo) | Sí | no medible desde la web | Solo con ensayo físico (cámara). |
| **Teléfono suspendido / pestaña oculta / sin datos** | Sí | hasta reconectar | Al volver reconecta y toma el estado vigente; pasado 10 s sin conexión queda fijo en el primer color. |

## 3. Medición (banco `tools/sincronia.js`, Chrome real)

10 teléfonos con **ingresos escalonados** (un tercio antes de la orden, el resto hasta 7 s después), relojes locales desfasados, latencia de bajada y subida **distintas** y jitter por mensaje. Secuencia R→G→B de 1 s. «Reloj» = error de `serverNow()` frente a la hora real; «dibujo» = retraso del pintado respecto de su reloj estimado. Misma máquina para servidor y teléfonos (no incluye pantallas distintas).

| Métrica | Red ideal (50 ms/sentido) antes → ahora | Red hostil (20–150 ms asimétrica, jitter 40) antes → ahora |
|---|---|---|
| Error **inicial** del reloj (mediana / máx.) | 62 / 63 → **2 / 6 ms** | 126 / 176 → **10 / 56 ms** |
| Tiempo hasta converger | 97 → **0 ms** | 307 → **0 ms** |
| Sesgo del reloj en régimen (mediana / p95) | 2 / 6 → 1 / 3 ms | 16 / 46 → 23 / 56 ms (**asimetría: límite físico**) |
| Retraso de **dibujo** (mediana / p95) | 18,4 / 34,6 → **9,5 / 11,9 ms** | 18,9 / 39,2 → **8,7 / 15,2 ms** |
| Error **total** (mediana / p95) | 19 / 29 → **10 / 12 ms** | 20 / 53 → **13 / 55 ms** |
| Dispersión entre teléfonos (p5–p95) | 28 → **6 ms** | 83 → 99 ms (dominada por la asimetría aleatoria de cada red) |
| Cambios fuera de lugar (saltos de corrección) | 4 → 2 | 4 → 2 |

Notas: los máximos ocasionales (100–300 ms) en ambas versiones son detenciones de la **propia máquina de prueba** (10 páginas de Chrome compitiendo por CPU), no del algoritmo. En red hostil el error total p95 no baja porque lo domina la asimetría de red, que ningún cálculo desde el teléfono puede eliminar. Reproducir: `npm run sync:bench -- --phones 10 --seed 7 --skew 20000 --down 20-150 --up 20-150 --jitter 40 --detalle`.

## 4. Simulación a escala (modelo explícito, 60 000 teléfonos)

`test/reloj.test.js`: cada teléfono virtual tiene una red móvil propia (bajada lognormal de mediana 70 ms, subida ≈ 1,2 × la bajada, jitter exponencial de 15 ms por mensaje) y se une a una hora distinta; se usan las **mismas funciones** (`public/js/clock.js`) que el navegador.

| Error del reloj (ms) | p50 | p95 | p99 |
|---|---|---|---|
| Al ingresar, **cálculo anterior** | 86 | 193 | 271 |
| Al ingresar, **compensado (3.4.0)** | 14 | 64 | 114 |
| **En régimen** (tras la ráfaga de pings) | 11 | 61 | 110 |

Es un **modelo**, no una medición de un estadio: los valores reales dependerán de la congestión de la red del recinto y de la operadora.

## 5. Qué se puede prometer

* **Todos los teléfonos conectados cambian de color en la misma hora de servidor**, sin importar cuándo escaneó cada uno.
* **Dispersión esperable** entre dos teléfonos con buena red: **≈ 10–30 ms** (algoritmo + dibujo); con redes móviles asimétricas, **≈ 60 ms al p95** y colas de **≈ 110 ms al p99** (simulación). A simple vista, un cambio de color en una tribuna se percibe simultáneo hasta decenas de ms; **«perfecto» (0 ms) no existe**: pantallas, sistemas operativos y asimetría de red lo impiden.
* **No se puede prometer** la sincronía de un teléfono con RTT muy alto (> 1 s): su error puede superar 0,5 s. El panel muestra la distribución de RTT para saberlo.

## 6. Operación recomendada en el estadio

1. **Escaneo previo**: que el público entre antes del show (pantalla negra «esperando»); el pico de conexiones no coincide con la primera orden.
2. **Margen «Seguro» (3 s) o más** para la primera orden; teléfonos con la orden tardía la aplican de inmediato en la fase correcta (la secuencia no se desfasa).
3. Mirar **«Reloj de los teléfonos»** en el panel: `RTT p50/p95` ⇒ error de sincronía ≤ RTT/2. Si el p95 supera ≈ 300 ms, la red está congestionada: conviene más margen y avisar al público.
4. **Varias instancias ⇒ Redis obligatorio** y `CLOCK_SOURCE=store` (predeterminado). Sin él, cada instancia usa su reloj de sistema (puede diferir).
5. **Ensayo físico con cámara**: filmar la tribuna (240 fps) en un cambio de color y medir la dispersión visible; registrar modelos de teléfono.
6. Brillo máximo, sin ahorro de energía (ver `COBERTURA_PANTALLA.md`): el brillo distinto entre teléfonos se percibe más que 30 ms.

## 7. Limitaciones y trabajo futuro

* **Sin ensayo en teléfonos físicos ni estadio**; 60 000 conexiones simultáneas **no demostradas** (ver `CARGA.md`). La ráfaga inicial de 6 pings por teléfono con ingresos masivos (60 000 en pocos minutos ≈ 2 000 ping/s) no se midió a esa escala.
* La asimetría de red es irreducible desde el cliente; una calibración promedio por tipo de red necesitaría **datos de campo con referencia externa**.
* Los temporizadores del navegador pueden agruparse en modos de ahorro agresivos; la secuencia duerme entre cambios y confía en un temporizador por frontera (a verificar en teléfonos físicos).
* Mejoras posibles: re-sincronización adicional pocos segundos antes de un cambio importante; pre-carga de la secuencia («cuenta atrás compartida»); sincronía por sector (mosaico).
