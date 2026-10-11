# Pruebas de carga — metodología y criterios de aceptación

> Los criterios de esta sección se definieron **antes** de ejecutar las pruebas (commit anterior a los resultados).
> Los resultados están al final, etapa por etapa, con la fecha y el hardware reales.

## Herramienta

`tools/loadtest.js` — independiente de la aplicación: solo usa la librería `ws`. Simula N teléfonos (hello, recepción de
`state`, aplicación simulada en `executeAt`, `applied` muestreado), un Master que emite órdenes y, opcionalmente, una
reconexión masiva. Consulta `/api/admin/status` del servidor para CPU, RAM, lag del event loop y contadores.

```
node tools/loadtest.js --spawn --clients 1000 --commands 5 --storm 1 --out loadtest-results/1000.json
node tools/loadtest.js --spawn --instances 2 --redis redis://127.0.0.1:6379 --clients 2000 --commands 5 --storm 0.5
node tools/loadtest.js --base https://mi-servicio.onrender.com --password ... --clients 500   # SOLO con autorización del dueño del servicio
```

Parámetros: `--clients`, `--rate` (conexiones/s de la rampa), `--commands`, `--interval`, `--lead`, `--storm` (fracción que se corta y
reconecta a la vez), `--instances` + `--redis` (varias instancias reales compartiendo Redis), `--env K=V,K=V` (variables del servidor).

**No se ejecutan pruebas masivas contra producción ni contra servicios de terceros.** `--spawn` levanta el servidor localmente.

## Qué se mide y cómo

| Métrica | Cómo se obtiene |
|---|---|
| Conexiones establecidas | clientes que reciben `welcome` / solicitados |
| Tiempo de conexión | desde crear el WebSocket hasta recibir `welcome` (p50/p95/p99) |
| Latencia de distribución | `Date.now()` al recibir `state` − `serverTimestamp` de la orden (mismo equipo → mismo reloj) |
| Desviación de aplicación simulada | retraso del temporizador que dispara en `executeAt` (mide el jitter del generador, **no** el de un teléfono) |
| Pérdida | órdenes recibidas / (clientes conectados × órdenes) |
| Mensajes por segundo | contador `messages_out` del servidor en la ventana de órdenes |
| CPU / RAM / lag | gauges del servidor (`cpu_percent`, `memory_rss_bytes`, `event_loop_lag_p99_ms`) muestreados cada 2 s (se reporta el pico) |
| Recuperación | tiempo hasta que todos los clientes cortados reciben de nuevo `welcome` + una orden posterior llega a todos |

Percentiles p50/p95/p99 sobre todas las muestras de todas las órdenes.

## Criterios de aceptación (por etapa)

Una etapa se considera **APROBADA** solo si cumple *todos*:

1. Conexiones establecidas ≥ 99,5 % de las solicitadas, sin `HTTP_5xx`.
2. Tiempo de conexión (rampa de 400/s): p95 ≤ 1 500 ms y p99 ≤ 3 000 ms.
3. Pérdida de órdenes ≤ 0,1 %.
4. Latencia de distribución: p95 ≤ 250 ms y p99 ≤ 500 ms (con margen `leadMs` de 1 500 ms, esto deja ≥ 1 s de holgura).
5. Desviación de aplicación simulada: p99 ≤ 150 ms.
6. Servidor: lag del event loop p99 ≤ 100 ms (pico), `heartbeat_timeouts = 0`, `ws_slow_closed = 0`, `store_errors = 0`, estado `ok`.
7. Reconexión masiva (si se pide): ≥ 99,5 % de los clientes cortados vuelven en ≤ 30 s y reciben la orden posterior.

Si un criterio falla, se informa el cuello de botella; **no se extrapola** de una etapa a otra: que 1 000 conexiones pasen no
demuestra que 60 000 pasen.

## Limitaciones del entorno de prueba (declaradas de antemano)

* Un solo equipo Windows (12 hilos lógicos, ~16 GB) ejecuta servidor, Redis y generador a la vez: se competen CPU y ancho de banda de loopback.
* Windows rechaza ráfagas de más de ~230 conexiones TCP simultáneas contra loopback (verificado con un servidor `net` vacío), por eso la rampa va en lotes.
* Las latencias son de loopback: no incluyen la red móvil, el Wi-Fi del estadio ni la CPU de teléfonos reales.
* Render/Linux tiene otro comportamiento de red y de límites de archivos abiertos: estas cifras **no** son una promesa para Render.

---

# Resultados (ejecutados el 2026-10-09)

**Entorno**: Windows 11 Pro, 12 hilos lógicos, ~16 GB RAM, Node v24.18.0, Redis 5.0.14 (port de Windows, solo para pruebas), todo en el mismo equipo
(servidor/es + Redis + generador). Margen `leadMs` = 1 500 ms, 5 órdenes (intervalo 1 500 ms), corte masivo de **todos** los clientes con reconexión jitter de 8 s.
Datos crudos en `loadtest-results/*.json`. Cada fila es **una** ejecución (sin repeticiones): hay variación entre corridas.

| Etapa | Config | Conectadas | Conexión p50/p95/p99 (ms) | Pérdida | Latencia distribución p50/p95/p99 (ms) | Desv. aplicación simulada p99 (ms) | Servidor: RSS pico / CPU pico / lag p99 pico | Corte masivo | Veredicto |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 1 proceso | 100/100 | 55 / 74 / 75 | 0 % | 5 / 10 / 11 | 22 | 54 MB / 2,2 % / 20 ms | 100/100 en 8,0 s; orden posterior 100/100 | **APROBADA** |
| 500 | 1 proceso | 500/500 | 51 / 61 / 64 | 0 % | 20 / 48 / 61 | 75 | 64 MB / 8,1 % / 25 ms | 500/500 en 8,1 s; 500/500 | **APROBADA** |
| 1 000 | 1 proceso | 1000/1000 | 49 / 62 / 72 | 0 % | 48 / 94 / 105 | 73 | 74 MB / 14 % / 26 ms | 1000/1000 en 8,1 s; 1000/1000 | **APROBADA** |
| 5 000 | 1 proceso (`BROADCAST_CHUNK=2000`, primera corrida) | 5000/5000 | 52 / 87 / 559 | 0 % | 161 / 356 / 433 | 164 | 147 MB / 31 % / **228 ms** | 5000/5000 en 9,3 s | **NO APROBADA** (criterios 4, 5 y 6) |
| 5 000 | 1 proceso (`BROADCAST_CHUNK=500`, valor actual) | 5000/5000 | 52 / 73 / 80 | 0 % | 186 / **391** / 491 | 86 | 141 MB / 17 % / 99 ms | 5000/5000 en 11,8 s; 5000/5000 | **NO APROBADA** (criterio 4: p95 391 > 250) |
| 5 000 | 4 procesos (`CLUSTER_WORKERS=4`) + Redis | 5000/5000 | 84 / 438 / 1 509 (máx 5 121) | 0 % | 91 / 224 / 261 | **907** | 84 MB / 8 % / **575 ms** | 5000/5000 en 9,0 s; 5000/5000 | **NO APROBADA** (criterios 5 y 6; el generador de un solo proceso compartiendo CPU con 4 procesos + Redis distorsiona la medición; no se pudo separar el efecto del servidor del del generador) |
| 5 000 | **2 instancias** + Redis | 5000/5000 | 54 / 102 / 157 | 0 % | 89 / 182 / 197 | 100 | 110 MB / 11 % / 45 ms | 5000/5000 en 8,6 s; 5000/5000 | **APROBADA** |
| 10 000 | 4 instancias + Redis, sin corte masivo | 10000/10000 | 57 / 79 / 150 | 0 % | 184 / **427** / 524 | **184** | 104 MB / 12,5 % / 85 ms | no ejecutado | **NO APROBADA** (criterios 4 y 5) |
| 10 000 | 4 instancias + Redis, con corte masivo | 10000/10000 | 69 / 340 / 3 727 | 0 % | 174 / 312 / 331 | 238 | 123 MB / 21 % / 214 ms | **INCOMPLETA**: 128/10 000 recuperados en 79 s, 59 cierres inesperados | **NO CONCLUYENTE** |

### Cuellos de botella identificados

1. **Difusión por conexión (CPU del proceso)**: ≈ 80–100 µs por envío en Windows (microbenchmark: `ws.send` 80–100 µs; escribir directamente la trama ya armada en el socket, 48–68 µs → ≤ 35 % de ganancia usando una API privada, descartado). En 5 000 sockets la difusión tarda ≈ 0,5 s en un proceso; con 2 instancias ≈ 0,2–0,3 s.
   Mitigación implementada: lotes de 500 envíos por turno del event loop (baja el lag de 228 a 99 ms) y margen de ejecución adaptativo (≥ 2 × p95 de difusión + 250 ms).
2. **El generador de carga** (un solo proceso Node) es el límite en 5 000+ conexiones: su desviación p50 de 90 ms a 10 000 clientes es jitter propio de temporizadores, no del servidor. Para ≥ 10 000 hay que repartir el generador en varias máquinas.
3. **Límites del SO Windows** (no de la app): ráfagas > ~230 conexiones TCP simultáneas hacia loopback son rechazadas (verificado con un servidor `net` vacío; las pruebas conectan por lotes), y la fila "10 000 con corte masivo" no se completó: la causa **probable, no verificada**, es el agotamiento de puertos efímeros por TIME_WAIT (10 000 sockets cortados + 10 000 nuevos) y/o la saturación del generador → no es concluyente.
4. `cpu_percent`/`lag` por proceso se consultan en la instancia que responde `/api/admin/status`; en `CLUSTER_WORKERS` ve un solo proceso por consulta.

### Qué se puede y qué NO se puede afirmar

* **Afirmable**: en este equipo, 1 000 conexiones en un proceso y 5 000 en dos instancias con Redis cumplen los criterios; se verificó entrega sin pérdida hasta 10 000 conexiones; la reconexión masiva de 5 000 clientes se recupera en ≈ 9–12 s sin duplicados.
* **No afirmable**: soporte de 60 000 (ni de 10 000 dentro de criterios), comportamiento en Linux/Render, en redes móviles, ni con dispositivos reales. 1 000 o 5 000 **no** se extrapolan a 60 000.


---

# Ronda de la auditoría V3.1 (2026-10-09) — con el generador CORREGIDO

> **Corrección importante**: en la ronda anterior `tools/loadtest.js` sobrescribía el estado del servidor por instancia, así que en las corridas de **varias instancias o workers**
> los contadores, bytes e histogramas del servidor reflejaban **solo la última instancia** (p. ej. `5000-i2.json` informó `ws_connections_total: 5000` cuando eran 10 000, y
> `serverReportedPublic: 2500` de 5 000; `10000-i4`: 2 500 de 10 000). Esas columnas del servidor de la tabla anterior **no son válidas** para las filas multi-instancia.
> Las métricas **del lado cliente** (conexiones, pérdida, latencia de distribución, recuperación) y los picos de RSS/CPU/lag (máximo entre sondeos) no estaban afectados.
> Ahora el generador consulta **todas** las instancias/procesos, suma los contadores acumulados una vez por proceso, suma buckets de histogramas, informa el detalle por instancia, lee el
> almacenamiento **efectivo** desde cada servidor y mide su propia salud. Verificado en `test/loadtest.test.js`.

**Entorno**: el mismo equipo Windows 11 (12 hilos lógicos, ~16 GB), Node v24.18.0, Redis 5.0.14 (port de Windows), servidor/es + Redis + generador juntos.
Margen `leadMs` 1 500, 5 órdenes, corte masivo de todos los clientes con reconexión en ventana de 8 s (donde se indica). Una sola ejecución por fila. Datos: `loadtest-results/v2/*.json`.
Cambios de código respecto de la ronda anterior que pueden influir: ping de reloj 1 cada ~30 s (antes 3 cada 15 s), reconciliación periódica (1 lectura/sala/15 s), contadores por IP.

| Etapa | Almacenamiento efectivo / procesos | Conexiones | Conexión p50/p95/p99 ms | Pérdida | Distribución p50/p95/p99 ms | Desv. simulada p99 | Servidor (pico): RSS (Σ procesos) / CPU / lag p99 | Corte masivo | Generador | Veredicto automático |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | memoria / 1 | 100/100 | 58 / 76 / 76 | 0 | 6 / 11 / 12 | 24 | 54 MB / 2,5 % / 20 ms | 100/100 en 11,9 s | lag 19 ms (ok) | **APROBADA** |
| 1 000 | memoria / 1 | 1000/1000 | 46 / 61 / 68 | 0 | 30 / 57 / 65 | 54 | 72 MB / 11,8 % / 22 ms | 1000/1000 en 12,1 s | lag 32 ms (ok) | **APROBADA** |
| 5 000 | memoria / 1 | 5000/5000 | 51 / 91 / 186 | 0 | 138 / **359** / 432 | 59 | 146 MB / 21 % / 80 ms | 5000/5000 en 13,6 s | lag 87 ms (**saturado**) | **NO APROBADA** (criterio 4) |
| 5 000 | redis / 2 instancias | 5000/5000 | 77 / 318 / **3 243** | 0 | 81 / **254** / **726** | 333 | 113 MB (222) / 11,9 % / 84 ms | 5000/5000 en 13,5 s | lag 146 ms (**saturado**) | **NO APROBADA** (criterios 2, 4, 5) |
| 5 000 | redis / 4 procesos (cluster) | 5000/5000 | 77 / 906 / **7 224** | 0 | 99 / 235 / 296 | 1 373 | 80 MB (292) / 5,9 % / **214 ms** | no ejecutado | lag 99 ms (**saturado**) | **NO APROBADA** (criterios 2, 5, 6) |
| 10 000 | redis / 4 instancias | **9995/10000** | 70 / 715 / **6 082** | 0 | 167 / **311** / 409 | 72 | 98 MB (391) / 10,6 % / 77 ms | no ejecutado | lag 70 ms (**saturado**), CPU 72 % | **NO APROBADA** (criterios 2 y 4) |

Lectura honesta de los resultados:

* **Se mantiene**: pérdida de órdenes **0** en todas las etapas (hasta 10 000 conexiones), 0 duplicados reenviados a clientes, 100 % de recuperación tras el corte masivo en 100/1 000/5 000 y estado de salud `ok` en todos los procesos; contadores agregados coherentes (p. ej. 5 000 conexiones + 5 000 reconexiones = `ws_connections_total` 10 001).
* **No se reproduce la aprobación anterior de 5 000 en 2 instancias** (antes: p95 182 ms, p99 197 ms; ahora p95 254 ms, p99 726 ms y conexión p99 3,2 s). En todas las filas desde 5 000 el **generador está saturado** (lag p99 70–146 ms, CPU hasta 72 % de un núcleo) y comparte CPU con el servidor y Redis: las latencias de estas filas **no son concluyentes**.
  La variación entre corridas con el mismo diseño (p99 197 → 726 ms) es un dato en sí: con un solo equipo y una sola ejecución por fila **no puede afirmarse** que 5 000 en 2 instancias cumple los criterios.
* **Tiempo de conexión p99 de varios segundos** en las filas multi-proceso: coincide con el reparto de conexiones de Node `cluster`/Windows y con la ráfaga de la rampa; no se pudo separar del efecto del generador. **Pendiente** medir en Linux con generador distribuido.
* **Memoria**: ≈ 18–22 KB por conexión en el servidor (RSS 54 MB → 146 MB de 100 a 5 000 conexiones, un proceso).
* **Qué NO mide esta herramienta** (y no debe confundirse): la "aplicación simulada" es el retraso de un temporizador del generador, no una pantalla; los ACK del servidor al Master significan "aceptada y publicada".
  Las confirmaciones agregadas (`stats`) son enviadas por los clientes simulados.

**Capacidad demostrada**: 0 % de pérdida y estado correcto con 10 000 conexiones simultáneas (4 instancias + Redis) en un equipo; cumplimiento de **todos** los criterios solo hasta 1 000 conexiones (un proceso).
**No demostrada**: 5 000 o más dentro de los criterios de latencia, 60 000, Linux/Render, dispositivos reales.
