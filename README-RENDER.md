# Deploy en Render — Destello·Sync V2

## Opción recomendada: GitHub + Render

1. Subí esta carpeta a un repositorio de GitHub.
2. En Render: **New → Web Service**.
3. Conectá el repositorio.
4. Usá:
   - **Runtime:** Node
   - **Build Command:** `npm install --omit=dev`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/healthz`
   - Para una prueba: **Free**.
5. Deploy.

El servidor usa `process.env.PORT` y escucha en `0.0.0.0`, que es lo que Render requiere para un Web Service público.

## URL

Cuando Render termine, tendrás algo parecido a:

`https://destello-sync-v2.onrender.com`

Master:

`https://destello-sync-v2.onrender.com/master`

Público:

`https://destello-sync-v2.onrender.com/?s=CODIGO&mode=remote`

No hace falta configurar `PUBLIC_BASE_URL`: el servidor puede construir la URL pública a partir de los headers de Render. Si querés fijarla manualmente, agregá en Render:

`PUBLIC_BASE_URL=https://tu-dominio.com`

## Importante para una prueba

El MVP guarda las sesiones **en memoria**. Si Render reinicia el servicio, las sesiones y sus códigos se pierden. Para una prueba con algunos celulares está bien; para un evento real hay que agregar persistencia y una arquitectura preparada para escalar.

El plan Free tampoco es adecuado para un show real: Render puede ponerlo en reposo tras 15 minutos sin tráfico y tiene otras limitaciones. Para un evento en vivo conviene un servicio pago siempre activo.
