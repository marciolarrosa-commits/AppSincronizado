# Observabilidad

## Logs

Una línea JSON por evento en stdout: `{ts, level, msg, instance, ...campos}`. Eventos principales: `listening`, `login_ok/login_failed`, `session_created`,
`command_accepted` (con `sessionId`, `commandId`, `stateVersion`), `strobe_config`, `master_tokens_revoked`, `ws_origin_rejected`, `draining`, `shutdown_*`, `redis_error`.
Correlación: HTTP usa `x-request-id` (se acepta el entrante o se genera, y se devuelve); WebSocket usa `connId` por conexión; las órdenes se siguen por `commandId`.
Los campos con nombre `token/password/secret/authorization/cookie/key` se redactan siempre. Nivel con `LOG_LEVEL`.

## Salud

| Endpoint | Auth | Significado |
|---|---|---|
| `GET /healthz` | no | **Vivo**: el proceso responde. Es el `healthCheckPath` de Render (no debe depender de Redis). |
| `GET /readyz` | no | **Listo**: `{ready:true}` solo si no está drenando, el almacenamiento responde y no está al máximo de conexiones; si no, 503. No expone detalles. |
| `GET /api/admin/status` | operador | Salud detallada, hub (conexiones por sesión), métricas, almacenamiento. |
| `GET /metrics` | `METRICS_TOKEN` u operador | Formato Prometheus. |

Estados (`health.status`): `ok` · `degraded` (lag del event loop > 100 ms, almacenamiento > 250 ms o caído, clientes lentos que pierden órdenes, > 90 % de capacidad) ·
`overloaded` (≥ `MAX_CONNECTIONS`) · `draining` (reiniciando). El panel Master muestra el estado y las razones, y avisa cuando las órdenes pueden llegar tarde
(< 90 % a tiempo o > 5 % llegadas tardías con ≥ 20 confirmaciones).

## Métricas

Contadores: `ws_connections_total`, `ws_disconnections_total`, `ws_rejected_*` (origin, capacidad, tasa, badjoin, draining), `reconnects`, `device_replaced`,
`messages_in/out`, `bytes_out`, `state_broadcasts`, `commands_accepted/duplicate/rejected/failed`, `stop_commands`, `protocol_errors`, `forbidden_commands`,
`rate_limited(_commands)`, `ws_backpressure_skips`, `ws_slow_closed`, `resyncs`, `heartbeat_timeouts`, `store_errors`, `applied_reports`, `login_ok/failed`, `http_requests`.
Gauges: `connections_total/public/master`, `rooms`, `ws_buffered_bytes`, `resync_pending`, `memory_rss_bytes`, `memory_heap_used_bytes`, `cpu_percent`,
`event_loop_lag_p99_ms`, `store_up`, `last_broadcast_targets`.
Histogramas (ms): `httpMs`, `broadcastMs` (duración del bucle de difusión), `publishMs` (aceptación → inicio de difusión), `storeMs`.
Aplicación real en dispositivos: mensajes `stats` al Master (`onTimePct`, `deviationP50/P95/P99Ms`, llegadas tardías).

## Alertas sugeridas (para Prometheus/Grafana o el panel de Render)

| Condición | Acción |
|---|---|
| `destello_store_up == 0` durante > 10 s | Redis caído: las órdenes fallan; los teléfonos conservan el último estado. |
| `destello_event_loop_lag_p99_ms > 100` sostenido | Instancia saturada: agregar instancias/CPU o subir el margen (`leadMs`). |
| `increase(destello_ws_slow_closed_total[1m]) > 0` | Clientes lentos o red congestionada. |
| `increase(destello_heartbeat_timeouts_total[1m])` alto | Cortes masivos de red de los teléfonos. |
| `destello_connections_total / MAX_CONNECTIONS > 0.9` | Acercándose al tope por proceso. |
| `rate(destello_login_failed_total[5m]) > 0` inesperado | Intento de adivinar la contraseña del operador. |

---

## Añadidos de la auditoría V3.1

* **Configuración efectiva del almacenamiento, verificable sin secretos**: `GET /api/admin/status` (operador) devuelve `store.config = {kind:'redis'|'memory', url:'redis://***@host:puerto', prefix, commandHistory}`; la contraseña de `REDIS_URL` se enmascara siempre (también en el log de arranque `listening.storeConfig`).
* **Buckets de histogramas** en `metrics.latency.<nombre>.buckets` (`edges`, `counts`): permiten **agregar** varias instancias sumando buckets (los percentiles no se promedian). `tools/loadtest.js` lo usa.
* **Internos del hub** (`hub.internals`): salas, conexiones, entradas de heartbeat, reenvíos pendientes, buffers de acks, IP rastreadas y temporizadores de estadísticas. Deben volver a **0** cuando no hay conexiones (verificado con 1 500 ciclos): un valor que no baja indica una fuga.
* **Métricas nuevas**: `reconciled_states` (estados reenviados por la reconciliación: distinto de 0 = se perdió una publicación o cayó el suscriptor), `session_incarnation_changes` (sesiones re-creadas con el hub vivo), `ws_rejected_prehello`, `ws_rejected_ipcap`, `login_rate_limited`.
* Alertas adicionales: `increase(destello_reconciled_states_total[5m]) > 0` → revisar Redis/red entre instancias; `destello_ws_rejected_badjoin_total` o `destello_http_rate_limited_total` > 0 durante la audiencia → posible falso positivo de NAT (ver SEGURIDAD.md).
