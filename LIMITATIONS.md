# Límites

Fuente única de lo que paridad no demuestra. Ningún otro archivo repite estos límites.

## Sin el servidor real de Resend

- Las pruebas nunca tocan la API real. No se prueba la deduplicación real con claves de idempotencia, los límites de tasa reales por equipo, los permisos reales de una clave restringida, la entrega de emails ni la latencia real. En local solo se prueba que el cliente emite lo correcto según el contrato y que reacciona igual ante las respuestas que el contrato y la documentación describen.
- La especificación fijada no define respuestas de error. El catálogo de errores sale de la página oficial de errores de Resend y el proxy de fallos los reproduce; si el servidor real responde distinto de lo documentado, paridad no lo detecta.
- `/emails/batch` se trata como todo o nada porque ni la especificación ni la referencia de la API documentan aceptación parcial; el modo `permissive` del CLI oficial no se modela.

## Especificación fijada

- `emails/update` (`PATCH /emails/{email_id}`) no declara cuerpo de petición en la especificación fijada: `UpdateEmailOptions` aparece como esquema de su respuesta. La IR sigue a la especificación, así que las superficies propias no envían cuerpo en esa operación.
- `webhooks/list-events` y `webhooks/list-event-attempts` aceptan `limit` y `after` pero no `before`. La regla de paginación exige los tres parámetros, así que esas dos operaciones no tienen `pagination` en la IR ni iterador en las superficies; se paginan pasando `after` a mano.
- Los valores que la síntesis no puede sacar del esquema (`example`, `default`, `enum`, `format`) son genéricos: la cadena `example` y, en parámetros de ruta, un UUID fijo. Solo las operaciones con ejemplo en `ir/overlay.yaml` llevan valores elegidos a mano.

## SDK TypeScript

- Los archivos de `multipart/form-data` (`contacts/create-import`) se envían con el nombre del campo como nombre de archivo y con `Content-Type: application/octet-stream`: el `name` de un `File` y el `type` de un `Blob` no se usan.

## SDK Python

- Los `TypedDict` no expresan `additionalProperties` junto a `properties`, ni restricciones como `minLength`, `maxItems` o un `anyOf` que solo exige `required`: esas claves y reglas no se comprueban en el tipo. Un `allOf` sin miembros de objeto toma el primer miembro con tipo, o `Any` si no hay ninguno.
- Los archivos de `multipart/form-data` (`contacts/create-import`) se pasan como `bytes`, y su nombre de archivo es el nombre del campo.
- El tiempo máximo por intento se aplica como plazo del socket, recalculado antes de la conexión, del envío y de cada bloque leído; dentro de un mismo bloque el socket puede recibir varias veces, así que una respuesta que llega a pedazos muy lentos puede pasarse del plazo. No se midió cuánto.

## SDK Go

- Los campos opcionales son punteros (o slices, mapas e `any` en `nil`) con `omitempty`: un opcional no puede enviarse como `null` explícito, y un slice o mapa opcional vacío no se envía. Un `PATCH` que necesite poner un campo opcional en `null` no se puede expresar con los tipos generados.
- `oneOf`, `anyOf` sin propiedades propias y los `enum` de tipos mezclados se tipan como `any`; las ramas de `oneOf`/`anyOf` con propiedades se unen como campos opcionales del mismo struct, y las restricciones (`required` de una rama, `minLength`, `maxItems`) no se comprueban en el tipo. Las claves extra que admite `additionalProperties` junto a `properties` no tienen campo y se pierden al decodificar.
- Los campos `format: binary` son `[]byte`: en un cuerpo JSON `encoding/json` los envía en base64 (como `resend-go`), mientras que el SDK TS y el Python envían la cadena tal como se les da. En `multipart/form-data` (`contacts/create-import`) se envían como archivo con el nombre del campo como nombre de archivo.
- Las respuestas no se validan contra su tipo: un valor cuyo tipo JSON no coincide con el del campo Go queda en su valor cero, sin error.
- `StatusCode` vale 0 cuando no hubo respuesta (`invalid_idempotency_key`, `timeout`, `connection_error`), en lugar del nulo de las otras superficies. Si el `context.Context` del llamador termina antes, la llamada devuelve `ctx.Err()` y no un `*resend.Error`.
- Cada intento abre una conexión nueva (sin keep-alive), para que `net/http` no repita por su cuenta peticiones fallidas sobre una conexión reutilizada. No se midió el costo en latencia.

## Servidor MCP

- Los campos de archivo de un cuerpo `multipart/form-data` (`file` de `contacts/create-import`) se dan como texto en los argumentos y se envían como archivo con ese texto como contenido: un archivo binario que no sea texto UTF-8 no se puede pasar.
- El argumento `idempotency_key` no lleva `maxLength` en su `inputSchema`, para que una clave fuera de 1 a 256 caracteres llegue al SDK y dé `invalid_idempotency_key` como en las demás superficies; así ese esquema no rechaza la clave de 257 caracteres que el esquema de la cabecera en la spec sí rechaza.
- `format` se trata como anotación al validar los argumentos (vocabulario por defecto de 2020-12): un `uuid` o `email` mal formado pasa la validación del servidor y lo rechaza la API.
- Por el puente stdio, las notificaciones que el servidor escribe mientras atiende una petición llegan al cliente HTTP solo por el flujo SSE independiente (`GET /mcp`), porque en stdio no hay forma de saber a qué petición pertenecen.
- C13 pasa con 22 escenarios del marco de conformidad listados en `verify/mcp-conformance-baseline.yml` (contenido de texto, imagen, audio y recursos embebidos en resultados de herramientas, logging y progreso durante una herramienta, sampling, elicitation, lectura y suscripción de recursos, y `prompts/get`). El marco los prueba con sus propias herramientas, prompts y recursos `test_*`, que el servidor no tiene, así que esos comportamientos del protocolo no se comprueban en paridad-mcp.

## Oráculo

- La equivalencia con los SDKs oficiales solo cubre las operaciones que cada SDK oficial expone en su versión fijada. Las demás solo se comparan entre superficies propias y contra la especificación con Prism.
- Con las versiones fijadas, C3 compara 139 de las 144 operaciones con `resend-node`, 138 con `resend-python` y 100 con `resend-go`.
- La igualdad con los SDKs oficiales se cumple salvo en las 204 diferencias justificadas de `verify/divergences.json`, que afectan a 102 operaciones (188 contra `resend-python`, 11 contra `resend-go` y 5 contra `resend-node`; 110 en el cuerpo y 94 en `content-type`). En ellas el SDK oficial no sigue la especificación fijada y el propio sí (por ejemplo, `resend-python` envía un cuerpo JSON en operaciones sin `requestBody`), así que quien cambie de un SDK oficial a paridad recibe peticiones distintas en esas operaciones. No se sabe cuál de las dos formas acepta el servidor real.
- `contacts/create-import` no se compara con ningún SDK oficial: los oficiales arman el cuerpo `multipart/form-data` con una frontera aleatoria por petición, así que su forma normalizada (un sha256 de los bytes) no coincide con la de otro cliente. Solo la cubren C5 y C8.
- Los drivers oficiales solo ejecutan los casos `<operationId>#example`; la paginación con iterador no tiene equivalente en los SDKs oficiales y no se compara contra ellos.
- `resend-go` devuelve errores con solo un mensaje (salvo el de 429), así que en `results.jsonl` el driver oficial de Go no reporta `code` ni `statusCode` de otros errores.
- Los SDKs oficiales no reintentan solos, así que el comportamiento ante fallos se compara entre las superficies propias y contra la política declarada, no contra los oficiales.
- Para el CLI oficial se usa una variable de entorno de URL base presente en su código pero no documentada. Si una versión futura la quita, la comparación con el CLI oficial deja de ser posible.
- C16 compara con `resend-cli` 2.29.0 solo los 27 pares de `verify/official-cli-map.json` (19 éxitos y 8 errores), y en ellos solo el código de salida y las claves de primer nivel, no los valores. Los demás comandos del CLI propio solo se comprueban contra el contrato documentado (JSON válido o `error.message`, salida 0 o 1).
- `resend-cli` 2.29.0 escribe sus errores JSON en stderr, como dice su ayuda, y deja stdout vacío. `paridad` los escribe en stdout (sección 5.2 del contrato). C16 compara el stderr oficial con el stdout propio, así que un script que lea los errores de un flujo concreto no funciona igual con los dos CLIs.

## Arnés

- Los mensajes de error que fuerza C6 los escribe el propio arnés (`Forced by the paridad fault proxy: <estado> <name>.`), no son los textos de la página oficial de errores: C6 comprueba que cada superficie los muestra sin cambios, no que coincidan con los del servidor real.
- El driver del MCP pagina él mismo cuando un caso itera (llama otra vez a la herramienta con `after` igual al id del último elemento), porque el servidor MCP devuelve una sola página; esa iteración es del cliente de prueba, no del producto.
- C2 toma las capturas de `.paridad/runs/c5/` tal como estén; si C5 se corrió con un subconjunto de `SURFACES`, C2 cuenta como faltantes las superficies que no corrieron. Solo corre C5 por su cuenta cuando ese archivo no existe.
- El servidor de captura responde con todas las propiedades de primer nivel que documenta el esquema de la respuesta, así que C16 compara claves de primer nivel con respuestas completas. Con una respuesta que solo traía `deleted`, `domains remove` del CLI oficial imprimió `deleted`, `id` y `object` y el propio solo `deleted`: si el servidor real omite propiedades documentadas, las claves de los dos CLIs pueden diferir.
- `traces.jsonl` escribe los tiempos de `process.hrtime.bigint()` como números JSON: son exactos al nanosegundo hasta 2^53 ns (unos 104 días de reloj monotónico, que en Linux cuenta desde el arranque); pasado eso se redondean a unos pocos nanosegundos.
- Mientras `compat/` no exista (K3), `paridad contract-check` responde `not_implemented`: la skill no lo enseña y C15 no lo cuenta entre los comandos del CLI que deben aparecer en ella.

## Medición

- La conformidad MCP sobre stdio pasa por un puente que reenvía los mensajes a Streamable HTTP, porque el marco oficial solo prueba servidores por URL.
- Los fallos de red a nivel de kernel (`tc netem`) necesitan sudo; sin él, ese criterio se omite (código 77) y solo quedan los fallos en espacio de usuario.
- En el cierre de K2, C12 salió omitido (77) porque `sudo -n true` falla en la máquina de desarrollo: el comportamiento bajo pérdida, latencia y reordenamiento de `tc netem` no se midió.
- `make verify` devuelve el código del corredor (77 en un criterio omitido) solo si GNU Make tiene Guile. Sin Guile, make convierte el 77 en 2 y el criterio cuenta como fallo. Solo se comprobó en la máquina de desarrollo (GNU Make 4.4.1 con Guile), no en la CI.
- La memoria pico se mide con `memory.peak` del cgroup, que incluye caché de páginas: es una cota superior de la memoria residente, no la memoria residente exacta.
- La tolerancia temporal de los reintentos ante 429 es de −25 ms a +1000 ms sobre `retry-after`, medida en el proxy de fallos.
- Para TypeScript no existe un clasificador estándar de cambios de API; el salto semver se contrasta con la diferencia entre reportes de api-extractor, que es una aproximación.
- Solo se verifica en x86-64 con Arch Linux.

## Lo que no es mecánico

- La atención real de issues y pull requests de contribuidores externos.
- La calidad del registro de decisiones (problema ambiguo, alternativas, solución acotada y seguimiento después del primer release): solo se comprueba que existe con sus secciones.
