# Destello·Sync V2 — control remoto del público

Esta V2 agrega un canal de control central para que un teléfono/PC Master pueda controlar en tiempo real el color y efectos de todos los celulares que escanearon el QR.

## Qué agrega

- `/master`: panel de operador.
- Creación de sesiones con código de 6 caracteres.
- QR público por sesión.
- Conteo de celulares conectados en tiempo real.
- Broadcast de estado mediante Server-Sent Events (SSE).
- Colores fijos.
- Efecto pulso.
- Efecto strobe.
- Programación con `executeAt` para que el cambio ocurra sincronizado.
- Token privado por sesión para autorizar comandos del Master.
- El cliente público no necesita cámara ni micrófono para el nuevo modo remoto.
- Se conserva la aplicación original y su modo de música/flash local.

## Requisitos

- Node.js 20 o superior.

## Ejecutar

```powershell
node server.js
```

Abrir:

```text
http://localhost:3000/master
```

Crear sesión → mostrar el QR → escanear desde celulares.

## Prueba local

Para probar varios teléfonos en la misma red LAN, el servidor debe escuchar en una interfaz accesible y los teléfonos deben abrir la IP del PC, por ejemplo:

```text
http://192.168.1.50:3000/master
```

El QR se genera con la URL pública que recibe el servidor. Para producción se recomienda usar HTTPS y configurar:

```text
PUBLIC_BASE_URL=https://tu-dominio.example
PORT=3000
```

## Arquitectura del MVP

```text
Master
  |
  | POST command + master token
  v
Node.js
  |
  | SSE
  +---- celular 1
  +---- celular 2
  +---- celular N
```

Los comandos son pequeños y se emiten como estado de sesión; el teléfono calcula localmente el efecto visual. Esto evita enviar una orden individual por dispositivo.

## Próxima etapa de producción

Para eventos grandes conviene agregar:

1. autenticación real del operador;
2. persistencia de sesiones;
3. Redis/pub-sub si se horizontaliza el backend;
4. métricas y heartbeat por dispositivo;
5. grupos/tribunas/sectores;
6. timeline de shows;
7. sincronización de reloj más precisa;
8. rate limiting y protección del endpoint Master;
9. HTTPS/WSS;
10. Firebase/App Check o un backend de identidad equivalente si se decide usar Firebase.
