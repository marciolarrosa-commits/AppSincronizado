# Requisitos para operar un evento de gran escala

> **La aplicación NO está validada para 60 000 dispositivos.** Lo que sigue separa lo **medido** de lo **estimado** y lista lo que falta.

## Lo medido (un solo equipo Windows, ver `CARGA.md`)

* Hasta **5 000 conexiones** en un proceso: 0 % de pérdida de órdenes, pero la difusión tarda ≈ 0,5 s y **no cumple el criterio de latencia p95 ≤ 250 ms** (391 ms).
* **5 000 en 2 instancias + Redis real**: cumple todos los criterios definidos (p95 182 ms, p99 197 ms, recuperación tras corte masivo 5 000/5 000 en 8,6 s).
* **10 000 en 4 instancias**: 0 % de pérdida y conexión correcta, pero **no cumple** latencia (p95 427 ms) ni desviación simulada; el generador de carga (un proceso) y la CPU compartida del mismo equipo son el límite.
* Costo de difusión medido: **≈ 80–100 µs por envío** (Windows, un núcleo) → una orden a 60 000 sockets son ≈ 5–6 s de CPU de un núcleo **en este hardware**.

## Estimación (NO medida) para 60 000

Si el costo por envío en Linux fuera la mitad (no medido), 60 000 envíos serían ≈ 2,5–3 s de CPU por orden; para repartirlo en ≤ 0,5 s harían falta ≈ 6–8 núcleos de proceso de la app
(p. ej. 8–12 instancias/procesos de 1 CPU, o 2–3 instancias `4c-8g` con `CLUSTER_WORKERS=4`) **más** Redis dimensionado por conexiones (2 por proceso) y por pub/sub.
Con el costo medido en Windows, el doble. Estas cifras son un punto de partida para dimensionar una **prueba**, no una promesa.

Otros cuellos de botella a validar en una prueba real:

* **Ancho de banda saliente**: cada orden pesa ≈ 280 B (medido: 274 B de JSON + 2–4 B de trama) × 60 000 ≈ 17 MB por orden (sin contar TLS/TCP/IP, que suman ~10–15 %); a 1 orden/s sostenida ≈ 135 Mbit/s hacia Internet, que Render factura como saliente.
* **Capa de red del lugar**: Wi-Fi/4G/5G saturados por 60 000 teléfonos; el WebSocket compite con todo lo demás. No es controlable por la app.
* **NAT**: miles de teléfonos detrás de pocas IPs — ajustar `WS_CONNECT_PER_MIN_PER_IP`.
* **Conexiones simultáneas de reconexión** tras un corte: el cliente usa backoff exponencial con jitter completo y `LISTEN_BACKLOG=4096`; el servidor cierra escalonado en los despliegues. Falta probarlo a escala en Linux.
* **Límite de archivos abiertos** (`ulimit -n`) del contenedor: verificar ≥ 2 × conexiones por proceso.
* **Redis**: 2 conexiones por proceso; el plan debe cubrirlas (el gratuito admite 50). Un Redis sin persistencia pierde sesiones al reiniciar.

## Checklist para un evento real

1. Plan **pago siempre activo** (no Free), ≥ 2 instancias con Redis/Key Value de plan pago (persistencia), `NODE_ENV=production`, `MASTER_PASSWORD` fuerte.
2. **Prueba de carga previa en la infraestructura real** (Linux, mismo plan, generador distribuido en varias máquinas) hasta ≥ 1,2 × la audiencia esperada, con la misma metodología de `CARGA.md`. Registrar resultados.
3. Subir `WS_CONNECT_PER_MIN_PER_IP`; elegir `COMMAND_LEAD_MS` ≥ 2 × la duración de difusión medida (empezar en 3 s para audiencias grandes).
4. Ensayo general en el lugar con ~20 teléfonos reales (iPhone/Android, Wi-Fi y datos): medir desviación visual (OLED/LCD difieren; no se garantiza sincronía perfecta entre paneles).
5. Aviso de fotosensibilidad al público si se usa strobe; dejarlo **deshabilitado** salvo necesidad.
6. Un operador con el panel abierto y **otro** con `/master` listo (hasta 3 paneles por sesión); ambos conocen la tecla **Esc** (DETENER TODO).
7. Congelar despliegues desde 24 h antes. Tener el procedimiento de rollback (`DESPLIEGUE_RENDER.md`) y el plan B (pantalla gigante con música/luces propias) a mano.
8. Instrucciones a los asistentes: mantener la pantalla encendida y la pestaña en primer plano; iOS/Android **suspenden WebSocket y animaciones** con la pantalla bloqueada o en segundo plano (se usa Wake Lock cuando el navegador lo permite, sin garantía).

## Limitaciones conocidas de navegadores móviles

* Segundo plano / pantalla bloqueada: el navegador puede pausar timers y cerrar el WebSocket. Al volver, el cliente reconecta y aplica el estado vigente; no recupera lo ocurrido en el intervalo.
* iPhone no ofrece pantalla completa para páginas web (el botón se ignora); el color igualmente ocupa toda la página.
* Brillo y consumo de batería: pantallas completas blancas a máximo brillo drenan batería; el cliente no cambia el brillo del sistema.
* Precisión: `requestAnimationFrame` ≈ 16 ms; las pantallas añaden su propia latencia de salida (no medible desde la página).


## Cobertura de pantalla del público

Instrucciones para los participantes, diferencias Android/iOS y el protocolo de ensayo físico (**pendiente de ejecutar antes del evento**): `COBERTURA_PANTALLA.md`.
