# Versionado de cambios

**Regla**: toda modificación de la app genera una versión nueva. Queda en tres lugares: `package.json` (y `package-lock.json`, que `GET /api/admin/status` publica como `version`), `CHANGELOG.md` y un paquete `DestelloSync-V<versión>-Render.zip`.

## Qué número corresponde

| Tipo | Cuándo | Ejemplo |
|---|---|---|
| `major` | Rompe el protocolo WebSocket v1 o el formato del QR `/?s=CODIGO&mode=remote` | 3.4.1 → 4.0.0 |
| `minor` | Función, efecto o página nueva | 3.4.1 → 3.5.0 |
| `patch` | Corrección, diagnóstico, documentación, pruebas o herramientas sin cambio de comportamiento | 3.4.1 → 3.4.2 |

Un cambio solo de documentación o de herramientas también lleva `patch`: así cada ZIP corresponde a un estado exacto.

## Flujo de cada modificación

1. Hacer el cambio (con su prueba, si es código).
2. Ejecutar las pruebas que correspondan (`npm run check`, `npm test`, y `npm run test:browser` si toca el cliente). Con `REDIS_SERVER` apuntando a un `redis-server` se ejecutan también las pruebas de Redis; sin él quedan **omitidas** y debe decirse.
3. Generar la versión:

   ```bash
   npm run release -- patch --nota "Qué cambió y por qué" --nota "Otra nota si hace falta"
   ```

   Opciones: `--out DIR` (por defecto, dos niveles por encima de la app, junto a los ZIP anteriores), `--dry-run` (calcula y no escribe nada), `--force` (reemplaza un ZIP existente).
4. Si el cambio es sustancial, escribir `docs/INFORME_V<versión>.md` (qué se cambió, mediciones, pruebas ejecutadas y **lo no demostrado**) **antes** del paso 3, para que quede dentro del ZIP.
5. Publicar (Render/GitHub) **solo con autorización expresa**; la herramienta nunca hace commit, push ni despliegue.

## Qué hace `tools/release.js`

* Exige al menos una `--nota`: no hay versión sin documentar.
* Ejecuta la verificación de sintaxis y se detiene si falla.
* Sube la versión en `package.json`, `package-lock.json` y el título del README, e inserta la entrada arriba en `CHANGELOG.md` (tras la marca `<!-- release:next -->`).
* Escribe un ZIP real (firma `PK`, no un tar) con `zlib`, sin dependencias, sin `node_modules`, `.git`, `*.artifact.json` ni salidas de pruebas (`v<n>*.txt`), y lo **vuelve a leer verificando el CRC** de cada archivo.
* Probado en `test/release.test.js` (cálculo de versiones, ida y vuelta del ZIP, detección de datos alterados, exclusiones y marca del CHANGELOG).

## Volver a una versión anterior

Los ZIP anteriores se conservan: para volver atrás se despliega el ZIP de la versión deseada. El protocolo v1 se mantiene compatible entre versiones 3.x.
