# Informe V3.4.0: sincronía de teléfonos que escanean en momentos distintos

Versión 3.3.0 → **3.4.0**. Análisis completo, tablas y recomendaciones de operación: `SINCRONIZACION.md`. Entorno de las pruebas: Windows 11, Node 24, Chrome 154, Redis 5.0.14. **Nada se probó en teléfonos físicos ni en un estadio.**

## 1. Diagnóstico

**El escaneo en momentos distintos no desfasa la secuencia**, porque ningún teléfono arranca su propio contador: el servidor fija `executeAt` y cada teléfono calcula el color como función de `(horaServidor − executeAt) mod ciclo`. Un teléfono que se une a mitad de la secuencia muestra desde el primer cuadro el color que corresponde (probado en Chrome). La hora de pared del teléfono tampoco influye (el reloj usa `performance.now()`).

Lo que sí desfasaba, medido con un banco de teléfonos reales (relojes locales desfasados, latencias asimétricas, ingresos escalonados), y se corrigió:

| # | Defecto / riesgo | Efecto medido | Corrección |
|---|---|---|---|
| 1 | Al unirse, el reloj se fijaba con `serverTimestamp − ahora` e **ignoraba la demora de bajada**; se mostraba esa fase hasta el primer pong | error inicial 62 ms (ideal) / 126 ms (máx. 176) durante 0,1–0,35 s y salto de corrección | Estimación con el viaje `hello→welcome` (RTT/2): **2 ms / 10 ms (máx. 56)** |
| 2 | Al **reconectar** se descartaba la buena estimación previa | repetía el error del punto 1 | Se conserva si es coherente (< 1 s) |
| 3 | Dibujo a ~30 fps: el cambio de color se pintaba hasta ~35 ms tarde | p95 35–39 ms | Duerme entre cambios y evalúa a 60 fps cerca de cada frontera: **p95 12–15 ms** (y menos CPU/batería) |
| 4 | Con **varias instancias**, cada una usaba su reloj de sistema | los teléfonos de una instancia se desfasaban lo que difieran los relojes (probado +900/−700 ms ⇒ 1 600 ms entre instancias) | Todas las marcas salen de la hora del almacenamiento (`Redis TIME`): error < 40 ms |
| 5 | Sin visibilidad de la calidad de reloj del público | — | `ping.rtt` → histograma, `/api/admin/status` y fila «Reloj de los teléfonos» en el panel |

**Límite físico** (no corregible desde el teléfono): la asimetría subida/bajada de cada red; el error es (subida − bajada)/2 ≤ RTT/2.

## 2. Archivos modificados

| Archivo | Cambio |
|---|---|
| `public/js/clock.js` (nuevo) | Estimación del reloj (puro, probado en Node): `fromWelcome`, `addPong`. |
| `public/js/remote.js`, `public/flash.html` | Usa `clock.js`; instante de `hello`; conserva el reloj al reconectar; `rtt` en el ping; planificación por frontera; diagnóstico con fuente y cota de error. |
| `public/js/effects.js` | La secuencia informa `next` (ms hasta el próximo cambio). |
| `src/app.js`, `src/store/redis.js`, `src/store/memory.js`, `src/config.js` | Reloj único del servidor (`CLOCK_SOURCE`, `store.time()`), `clock` en `/api/admin/status`, salud con `clockRtt`. |
| `src/hub.js`, `src/protocol.js`, `src/metrics.js` | Marcas de tiempo desde el reloj único; `ping.rtt` opcional; histograma `clockRttMs`; `pong(t0, ts)`. |
| `public/master.html`, `public/js/master.js` | Fila «Reloj de los teléfonos» (RTT p50/p95 → error de sincronía). |
| `tools/sincronia.js` (nuevo), `package.json` | Banco de medición (`npm run sync:bench`); versión 3.4.0. |
| `test/reloj.test.js`, `e2e/sincronia.test.js`, `test/distribucion.test.js` | Pruebas nuevas. |
| `docs/SINCRONIZACION.md` (nuevo), `PROTOCOLO.md`, `CONFIGURACION.md`, `OBSERVABILIDAD.md`, README | Documentación. |

## 3. Resultados medidos (antes → ahora, mismas semillas)

10 teléfonos, ingresos escalonados (un tercio antes de la orden, el resto hasta 7 s después), secuencia R→G→B de 1 s.

| Métrica | Red ideal | Red hostil (20–150 ms asimétrica, jitter 40, relojes desfasados) |
|---|---|---|
| Error inicial del reloj (mediana / máx.) | 62 / 63 → **2 / 6 ms** | 126 / 176 → **10 / 56 ms** |
| Retraso de dibujo (mediana / p95) | 18,4 / 34,6 → **9,5 / 11,9 ms** | 18,9 / 39,2 → **8,7 / 15,2 ms** |
| Error total (mediana / p95) | 19 / 29 → **10 / 12 ms** | 20 / 53 → 13 / 55 ms (dominado por la asimetría) |
| Dispersión entre teléfonos | 28 → **6 ms** | 83 → 99 ms (asimetría aleatoria de cada red) |

Simulación (modelo explícito) de **60 000 teléfonos** con red móvil asimétrica: error al ingresar p50/p95/p99 = **86/193/271 → 14/64/114 ms**; en régimen 11/61/110 ms. Los máximos aislados de 100–300 ms en el banco son detenciones de la máquina de prueba (varias páginas de Chrome), no del algoritmo.

## 4. Pruebas ejecutadas

| Comando | Resultado |
|---|---|
| `npm ci` | 0 vulnerabilidades |
| `npm run check` | sintaxis OK (54 archivos) |
| `npm test` **con** Redis 5.0.14 real | **159 / 159 pasan** |
| `npm test` **sin** Redis | 159 pruebas: **139 pasan, 0 fallan, 20 omitidas** (necesitan `redis-server`; no verificadas en esa corrida) |
| `npm run test:browser` (Chrome 154 de escritorio) | **39 / 39 pasan** |

Cobertura nueva: **unidad** (estimación de reloj con todos sus casos; simulación de 60 000 teléfonos; pista `next` de planificación; validación de `rtt`), **integración** (histograma y salud con servidor y WebSocket reales), **Redis real** (instancias con relojes de +900 / −700 ms ⇒ todas las marcas concuerdan; control sin corrección ⇒ el desfase de 900 ms se ve completo), **E2E en Chrome** (6 teléfonos escalonados con red hostil: error inicial ≤ 90 ms, dibujo p95 ≤ 30 ms, sin saltos espurios; cambios a ≤ 40 ms de su frontera con ≤ 60 cuadros en 9 s; ingreso a mitad de la secuencia con el color correcto).

## 5. Qué se puede prometer y qué no

* **Sí**: todos los teléfonos conectados cambian de color en la **misma hora de servidor**, sin importar cuándo escaneó cada uno; dispersión esperable ≈ 10–30 ms con buena red y ≈ 60 ms al p95 con redes móviles asimétricas (simulación).
* **No**: sincronía «perfecta» (0 ms). Pantallas y sistemas operativos añaden 8–50 ms no medibles desde la web, la asimetría de red es irreducible, y un teléfono con RTT > 1 s puede errar más de 0,5 s.
* **No demostrado**: 60 000 conexiones simultáneas, el pico de 6 pings por teléfono con ingresos masivos, el comportamiento de los temporizadores en modos de ahorro de energía y la sincronía entre **teléfonos físicos** (requiere ensayo con cámara).

## 6. Despliegue

Variable nueva opcional: `CLOCK_SOURCE` (`store` por defecto; solo cambia el comportamiento con Redis/Valkey y varias instancias). **Con más de una instancia, Redis es obligatorio.** Los teléfonos con la página abierta desde antes deben **recargar** (el cliente cambia). Ensayo y rollback como en `INFORME_V3.2.1.md` §8; verificar `GET /api/admin/status` → `version: "3.4.0"` y `clock`. Protocolo v1 compatible: `ping.rtt` es opcional y las marcas de tiempo mantienen su formato.
