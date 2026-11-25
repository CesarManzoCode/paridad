# Changelog

Formato basado en Keep a Changelog. Las versiones siguen semver una vez que exista el primer release.

## [Sin publicar]

### K3 — Compatibilidad, releases y operación

#### Agregado
- Herramienta de compatibilidad de contrato `compat/` (`node compat/src/main.ts <base.yaml> <revision.yaml> [--json]`, también `paridad contract-check`). Es una implementación propia, no envuelve `oasdiff`, y reutiliza el cargador del generador para las dos versiones. Empareja operaciones por método y ruta, con los nombres de los parámetros de ruta incluidos (como `oasdiff --include-path-params`) y clasifica cada cambio con el nivel ERR, WARN o INFO de la verificación de `oasdiff` v1.39.0 que reproduce; cada regla propia nombra esas verificaciones. Imprime las operaciones afectadas (`MÉTODO /ruta` con su `operationId`), sus superficies (`ts`, `python`, `go`, `cli`, `mcp`, `docs`, `skill`) y el salto semver del contrato. Sale con 0 si la revisión es compatible, con 1 si rompe y con 2 ante un error de uso o de carga.
- El cargador de la spec expone `endpoints()`, que admite operaciones sin `operationId` (versiones viejas del corpus) y conserva el objeto crudo de cada operación.
- La skill enseña `paridad contract-check`.
- Corpus de compatibilidad en `verify/corpus/`: `resend-openapi.bundle` (historial de `resend/resend-openapi` hasta el commit fijado, rama `pinned`), `history.json` (95 pares consecutivos de commits que tocan `resend.yaml`: 91 incluidos, 4 excluidos porque un lado no parsea con `yaml@2.9.1`; 37 con `operationId` completo en ambos lados), `synthetic.json` y `synthetic/<id>.json` (26 parches RFC 6902 sobre la spec fijada con las mutaciones de la sección 10 del contrato) y `materialize.ts`, que escribe `.paridad/corpus/<par>/base.yaml` y `revision.yaml` sin red.
- Corredores `make verify C=c18` (clasificación de `paridad contract-check` contra `oasdiff breaking --fail-on ERR`) y `make verify C=c25` (código de salida y operaciones afectadas contra las entradas de nivel 3 de `oasdiff breaking -f json`).

#### Cambiado
- `compat/` empareja operaciones con los nombres de los parámetros de ruta incluidos: renombrar un parámetro de ruta ahora rompe (operación quitada y agregada). Con la configuración por defecto, `oasdiff` rechaza 19 pares del historial por "duplicate endpoint" (dos `DELETE /audiences/{audience_id}/contacts/{…}` que solo difieren en el nombre del parámetro); con `--include-path-params` acepta los 91 pares parseables y la clasificación ERR de los otros 72 no cambia. En los SDKs generados el nombre del parámetro de ruta es parte de la API pública.
- `paridad contract-check` lee la salida de `compat/` con un búfer de 256 MiB en vez del 1 MiB por defecto de `spawnSync`.

### K2 — Comportamiento común, CLI, MCP, skill y documentación

#### Agregado
- CLI `paridad` (`cli/`, `node cli/src/main.ts`), generado desde la IR sobre el SDK TS: un comando `paridad <resource> <action>` por operación (144), con banderas para los parámetros de ruta y query y para las propiedades de primer nivel del cuerpo, más `--body <json>`, `--idempotency-key`, `--timeout-ms`, `--json`, `--all` en las 30 operaciones paginadas, y `--react <archivo.tsx>` con `--react-props <json>` en `emails send`. Escribe JSON en stdout fuera de TTY, con `CI` o con `--json`. Sale 0 con el cuerpo de la respuesta y 1 con `{"error":{"message","code","statusCode"}}`. `paridad config show` muestra la configuración efectiva con la clave enmascarada. `paridad contract-check` responde `not_implemented` hasta K3.
- Servidor MCP `paridad-mcp` (`mcp/`, `node mcp/src/main.ts --transport stdio|http [--port N]`), generado desde la IR con `@modelcontextprotocol/sdk` 1.32.2, protocolo `2025-11-25`:
  - Una herramienta `<resource>_<action>` por operación (144).
  - `inputSchema` JSON Schema 2020-12 con parámetros, `idempotency_key` y `body`.
  - Anotaciones `readOnlyHint`, `destructiveHint` e `idempotentHint`.
  - Los errores llegan como resultados con `isError: true` y el mismo objeto de error que el CLI.
  - La clave sale solo de `RESEND_API_KEY`.
  - Streamable HTTP en `127.0.0.1/mcp`, con protección contra DNS rebinding.
- Skill `skill/paridad-resend/SKILL.md` (Agent Skills), que enseña el CLI con cada uno de los 144 comandos en un bloque `bash` ejecutable.
- Sitio de documentación `docs/`: HTML estático en español, una página por recurso (18) más índice. Cada operación tiene su `data-operation-id` y cuatro ejemplos completos (TypeScript, Python, Go y bash) que leen `RESEND_API_KEY` y `RESEND_BASE_URL` del entorno.
- El SDK TS acepta `userAgentSuffix`: el CLI se identifica como `paridad-ts/<versión> cli` y el MCP como `paridad-ts/<versión> mcp`.
- Mismo comportamiento en las cinco superficies (SDK TS, SDK Python, SDK Go, CLI y MCP):
  - Las 144 operaciones emiten la misma petición (C5).
  - Las 720 peticiones de la batería pasan por `prism proxy --errors` sin violaciones (C8).
  - Los 13 errores de la tabla 9.1 dan el mismo `code` y `message` (C6).
  - La clave de prueba no aparece en ninguna salida (C7).
  - Las esperas ante 429 siguen `retry-after` (C9).
  - Los reintentos conservan la `Idempotency-Key` y el cuerpo (C10).
  - Los 10 casos de fallos parciales dan el resultado esperado (C11).
- El servidor MCP pasa el marco oficial de conformidad `@modelcontextprotocol/conformance` 0.1.16 en Streamable HTTP y en stdio (C13). Sus 144 herramientas aceptan y rechazan lo mismo que la spec en un corpus de 742 ejemplos (C14).
- Los 576 ejemplos de la documentación producen la petición de su operación, `vnu` no da errores y no hay enlaces internos rotos (C17). Los comandos de la skill salen 0 y la skill pasa `agentskills validate` (C15).
- Contrato del CLI comparado con `resend-cli` 2.29.0: mismo código de salida y mismas claves de primer nivel en 27 pares (19 de éxito y 8 de error) (C16).
- El `html` que envían el SDK TS (`react`) y el CLI (`--react`) es igual byte a byte al de `render` de `@react-email/render` 2.3.1 en tres plantillas (C24).
- Arnés de verificación:
  - Proxy de fallos (`harness/faults/`) con escenarios por intento (`pass`, `respond`, `delay` y `cut`) y trazas `traces.jsonl`.
  - Puente stdio de MCP (`harness/mcp-bridge/`).
  - Drivers del CLI y del MCP.
  - Corredores `make verify C=c2|c6|c7|c8|c9|c10|c11|c12|c13|c14|c15|c16|c17|c24`.
  - Dependencias de desarrollo fijadas: `@stoplight/prism-cli` 5.16.0, `resend-cli` 2.29.0, `vnu-jar` 26.11.20, `@modelcontextprotocol/conformance` 0.1.16, `skills-ref` 0.1.1, y React Email y `esbuild` en `verify/`.

#### Corregido
- Los ejemplos de `contacts/create-import` en `docs/` pasan `file` como archivo (`Blob` en TypeScript, `bytes` en Python y `--file` en bash) y emiten la misma petición que el resto de las superficies.
- El servidor de captura responde con todas las propiedades de primer nivel que documenta la respuesta. Antes, `domains remove` del CLI propio y del oficial imprimían claves distintas.
- `traces.jsonl` escribe `t_recv_ns` y `t_resp_end_ns` como enteros JSON, no como texto (sección 8 del contrato), para que un lector externo pueda restarlos.
- El corredor de C9 contaba como escritura repetida el reintento de una escritura sin clave tras un 429. Ahora solo cuenta un intento repetido después de una respuesta distinta de 429 (sección 5.3).
- `make verify` sale con el código del corredor, incluido el 77 de un criterio omitido. Antes, make lo convertía en 2.
- `c16/results.jsonl` da `stdout_file` desde la raíz del repositorio, y escribe en `argv` los argumentos sin el nombre del programa.
- La prueba del CLI pasa `tsc --strict` (`child.stderr` puede ser `null`).

#### Decisiones
- `paridad contract-check` queda fuera de la skill y de C15 hasta que exista `compat/` (K3).
- En el CLI oficial, C16 lee los errores de stderr cuando su stdout está vacío, porque así los escribe `resend-cli` 2.29.0. La sección 8 del contrato solo nombra el campo `stdout_file`.
- El servidor MCP declara las capacidades `prompts` y `resources` y responde con listas vacías. No agrega las herramientas, prompts ni recursos `test_*` del marco de conformidad, para no romper la biyección de C14. Los escenarios del marco que los necesitan se listan, cada uno con su razón, en `verify/mcp-conformance-baseline.yml`.
- `idempotency_key` no lleva `maxLength` en el `inputSchema` del MCP, para que una clave inválida dé el mismo `invalid_idempotency_key` que en las demás superficies.

### K1 — Spec fijada, representación intermedia y SDKs TS, Python y Go

#### Agregado
- Especificación de Resend fijada: `spec/resend.yaml` es copia byte a byte de `resend.yaml` en `resend/resend-openapi@8c6f120b3b8a72b749d68c0153a69cf0ca9f5cce`, con `spec/PIN` (repositorio, commit, ruta y sha256).
- Generador `generator/` (spec → IR): carga OpenAPI 3.0.x y 3.1.x, resuelve `$ref` internos y convierte los esquemas a JSON Schema 2020-12; construye `ir/ir.json` (`paridad-ir/1`) con las 144 operaciones de la spec fijada (6 idempotentes, 30 con paginación por cursor, 26 destructivas, 62 de solo lectura), aplica `ir/overlay.yaml` y valida cada ejemplo con `ajv` 2020-12. `make generate` lo ejecuta y da la misma salida en dos corridas seguidas.
- `ir/overlay.yaml` con proyecto (`project.repository`, `project.go_module`), política de reintentos, catálogo de errores y excepciones por operación (nombres Go con siglas, 6 operaciones destructivas que no son DELETE y ejemplos realistas).
- SDK TypeScript `paridad-resend` (npm, `sdks/typescript`): sin dependencias de ejecución, un método por operación (144) y 30 iteradores `for await`, errores como unión `{data, error}`, reintentos de la política común, validación de `Idempotency-Key`, tiempo máximo por intento, `PARIDAD_DEBUG=1` con la clave enmascarada y `react` en `emails/send` renderizado con `@react-email/render` (dependencia opcional).
- SDK Python `paridad-resend` (PyPI, módulo `paridad_resend`, `sdks/python`): solo biblioteca estándar, tipado (`py.typed`, `TypedDict`), Python >=3.10, un método por operación más 30 iteradores, errores como `ParidadError` y el mismo comportamiento de reintentos, idempotencia, tiempo máximo y depuración.
- SDK Go (módulo `github.com/CesarManzoCode/paridad/sdks/go`, paquete `resend`): solo biblioteca estándar, `context.Context` en cada llamada, iteradores `iter.Seq2`, errores `*resend.Error` y el mismo comportamiento de reintentos, idempotencia, tiempo máximo y depuración.
- Los tres SDKs emiten peticiones idénticas entre sí en los 144 casos de ejemplo (C5 entre SDKs) y cada operación aparece en las capturas de los tres (C2 en SDKs).
- Comparación en el cable contra los SDKs oficiales fijados `resend@6.39.0`, `resend==2.55.0` y `resend-go/v3 v3.17.0` (C3): 139, 138 y 100 operaciones comparadas, 0 diferencias sin justificar y 204 diferencias justificadas en `verify/divergences.json`, cada una con un puntero a la spec que muestra que la petición propia la sigue. `verify/oracle-coverage.json` lista cada método público de los tres SDKs oficiales con su operación o el motivo por el que no tiene caso.
- Arnés de verificación: servidor de captura local, normalización de peticiones de la sección 7.1, drivers de los SDKs propios y oficiales, y los corredores `make verify C=c1|c3|c4|c5` y `make battery`.
- Workspace pnpm con toolchain fijado y los comandos `make bootstrap`, `make generate`, `make check`, `make verify` y `make battery`.

#### Corregido
- Los tres SDKs envían el cuerpo `multipart/form-data` de `contacts/create-import` igual byte a byte: antes el SDK Go enviaba el archivo como archivo y con una frontera aleatoria, y TS y Python lo enviaban como texto.
- `verify/oracle-coverage.json` admite que un método oficial atienda varias operaciones (`contacts.list` sirve `contacts/list` y `segments/list-contacts`).
- Errores de tipos en el generador y tres pruebas que fallaban por errores propios (alineación de gofmt, cabecera `Host` que Node 26 exige, la fila de cobertura de `contacts.list`).

#### Decisiones
- La paginación por cursor sigue la regla de la sección 4 del contrato, que en la spec fijada da 30 operaciones y no las 28 que usan los parámetros compartidos.
- Donde un SDK oficial se aparta de la spec fijada, los SDKs propios siguen la spec y la diferencia se justifica en `verify/divergences.json` por operación, lenguaje y campo.

### K0 — Fundación

#### Agregado
- Fundación del proyecto: contrato con las decisiones cerradas, investigación con fuentes y versiones verificadas, interfaz de verificación (`make check`, y desde K1 `make bootstrap`, `make generate`, `make verify`, `make battery`), CI que corre `make check` y licencia MIT.

#### Decisiones
- Especificación fijada en `resend/resend-openapi@8c6f120b3b8a72b749d68c0153a69cf0ca9f5cce` (`resend.yaml`, OpenAPI 3.1.2).
- Generador, servicio de releases, proxy de fallos y servidor de captura en TypeScript sobre Node 26.
- Política común de reintentos: 3 intentos; una escritura sin clave de idempotencia nunca se reintenta tras un fallo ambiguo; el cliente no genera claves solo.
- Errores forzados con un proxy de fallos propio, porque la especificación no define respuestas de error.
