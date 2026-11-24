# Changelog

Formato basado en Keep a Changelog. Las versiones siguen semver una vez que exista el primer release.

## [Sin publicar]

### K2 — Comportamiento común, CLI, MCP, skill y documentación

#### Agregado
- Proxy de fallos `harness/faults/proxy.ts`: se encadena entre una superficie y el servidor de captura, cuenta intentos por (caso, superficie) desde la última sesión y aplica por intento `pass`, `respond`, `delay` o `cut` según un archivo de escenarios (`verify/scenarios/README.md`); escribe `traces.jsonl` con tiempos de `process.hrtime.bigint()`, `sha256` del cuerpo recibido, acción, estado y cabeceras de respuesta. `rateLimitResponse` construye el 429 de tasa con las cuatro cabeceras de límite. Su prueba `harness/faults/proxy.test.ts` se escribió sin ejecutarla.
- CLI `paridad` generado en `cli/` (`node cli/src/main.ts`) por `generator/src/emit/cli.ts` y las plantillas de `generator/templates/cli/`: un comando `paridad <resource> <action>` por operación (144) sobre el SDK TS, con su `operationId` en `cli/src/commands.ts` y en la ayuda; banderas de parámetros de ruta y query y de las propiedades de primer nivel del cuerpo, `--body <json>`, `--idempotency-key`, `--timeout-ms`, `--json`, `--all` en las 30 paginadas, y `--react <archivo.tsx>` con `--react-props <json>` en `emails send` (esbuild 0.28.2 y `render` de `@react-email/render` 2.3.1). JSON en stdout fuera de TTY, con `CI` o con `--json`; salida 0 con el cuerpo de la respuesta y 1 con `{"error":{"message","code","statusCode"}}`. `paridad config show` muestra la configuración efectiva con la clave enmascarada; `paridad contract-check` delega en `compat/` y, mientras no exista, responde `not_implemented`. Sus pruebas (`cli/test/*.test.ts`, `generator/src/emit/cli.test.ts`) se escribieron sin ejecutarlas.
- Opción `userAgentSuffix` del SDK TS: el CLI envía `User-Agent: paridad-ts/<versión> cli` (sección 5.1).
- Servidor MCP `paridad-mcp` generado en `mcp/` (`node mcp/src/main.ts --transport stdio|http [--port N]`) por `generator/src/emit/mcp.ts` y las plantillas de `generator/templates/mcp/`, con el `Server` de bajo nivel de `@modelcontextprotocol/sdk` 1.32.2 (protocolo `2025-11-25`): una herramienta `<resource>_<action>` por operación (144) con su `operationId` en `mcp/src/tools.ts`, descripción desde la IR, `inputSchema` JSON Schema 2020-12 que une parámetros de ruta, query, `idempotency_key` (en las 6 idempotentes) y `body`, con los esquemas de componentes en `$defs`, y anotaciones `readOnlyHint` (GET), `destructiveHint` (DELETE y las del overlay) e `idempotentHint` (métodos seguros de la política). `tools/call` valida los argumentos con `ajv` 2020-12, llama al SDK TS (`User-Agent: paridad-ts/<versión> mcp`) y devuelve el JSON de la respuesta; los errores son resultados con `isError: true`, `structuredContent` `{"error":{"message","code","statusCode"}}` y su texto JSON; argumentos inválidos dan `invalid_arguments` sin petición. Clave solo de `RESEND_API_KEY`; capacidad `logging` para `logging/setLevel`; `PARIDAD_DEBUG=1` escribe en stderr. Streamable HTTP en `127.0.0.1`, ruta `/mcp`, una sesión por `initialize` y rechazo 403 de `Host` u `Origin` que no sean `localhost`, `127.0.0.1` o `[::1]`. Sus pruebas (`mcp/test/*.test.ts`, `generator/src/emit/mcp.test.ts`) se escribieron sin ejecutarlas.
- Puente stdio de MCP `harness/mcp-bridge/bridge.ts --port <p> --command <cmd…>`: expone por Streamable HTTP un servidor stdio, con un proceso por sesión y los mensajes JSON-RPC reenviados en ambos sentidos sin cambiarlos, y la misma comprobación de `Host`/`Origin`. Su prueba `harness/mcp-bridge/bridge.test.ts` se escribió sin ejecutarla.

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
