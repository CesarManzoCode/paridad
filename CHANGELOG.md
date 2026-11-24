# Changelog

Formato basado en Keep a Changelog. Las versiones siguen semver una vez que exista el primer release.

## [Sin publicar]

### Agregado
- Fundación del proyecto: contrato con las decisiones cerradas, investigación con fuentes y versiones verificadas, interfaz de verificación (`make check`, y desde K1 `make bootstrap`, `make generate`, `make verify`, `make battery`), CI que corre `make check` y licencia MIT.
- Generador `generator/` (spec → IR): carga OpenAPI 3.0.x y 3.1.x con `yaml`, resuelve `$ref` internos y convierte los esquemas a JSON Schema 2020-12; construye `ir/ir.json` (`paridad-ir/1`) con las 144 operaciones de la spec fijada, deriva idempotencia, paginación, solo lectura, destructivas y nombres por superficie, aplica `ir/overlay.yaml` y valida cada ejemplo con `ajv` 2020-12. `make generate` lo ejecuta.
- `ir/overlay.yaml` con proyecto, política de reintentos, catálogo de errores y las excepciones por operación (nombres Go con siglas, operaciones destructivas no DELETE y ejemplos realistas).
- Servidor de captura `harness/capture/server.ts`: escucha solo en `127.0.0.1`, registra cada petición en `captures.jsonl` (cabeceras crudas en orden, cuerpo en base64, `seq` creciente), atribuye las peticiones a la sesión fijada en el puerto de control (`POST /__paridad/session`, `GET /__paridad/health`) y responde con el estado de éxito de la operación y una instancia del esquema de respuesta sintetizada por el generador; con `list_items` pagina un conjunto determinista por `limit` y `after`.
- Normalización de peticiones y campos de diferencia de la sección 7.1 en `harness/normalize.ts`.
- Drivers de los tres SDKs propios (`harness/oracle/ts.ts`, `harness/oracle/python_driver.py`, `harness/oracle/go/`): ejecutan un caso neutral `{case, operation, path, query, headers, body, idempotency_key, iterate}` con el método que dan los nombres de la IR (en Go, por `reflect`), contra `RESEND_BASE_URL`, e imprimen una línea de `results.jsonl`.
- Corredores de criterios en `verify/`: `run.ts` (`make verify C=cN`, borra y recrea `.paridad/runs/cN/`, propaga 0, 1 o 77 y aplica el límite anti-cuelgue de 30 minutos), `battery.ts` (`make battery`, escribe `.paridad/runs/battery.json`), `c1.ts`, `c4.ts` y `c5.ts` (casos `<operationId>#example` desde `examples[0]`, `captures.jsonl`, `results.jsonl`, `differences.jsonl`, `out/` y la línea `distintas=<n>`).
- Comparación contra los SDKs oficiales (C3): dependencias fijadas `resend@6.39.0` (npm, paquete `harness`), `resend==2.55.0` (`requirements-dev.txt`) y `github.com/resend/resend-go/v3 v3.17.0` (`harness/oracle/official-go/`); drivers oficiales `harness/oracle/official_node.ts`, `harness/oracle/official_python.py` y `harness/oracle/official-go/` que traducen el caso neutral con `harness/oracle/official-map.json` (`operationId` → método oficial y forma de sus argumentos, por lenguaje) y tienen modo `--plan`; `verify/oracle-coverage.json` con cada método público de los tres SDKs oficiales y su `operationId` o motivo; `verify/divergences.json` vacío; corredor `verify/c3.ts` (`make verify C=c3`).
- Workspace pnpm con toolchain fijado (`package.json`, `pnpm-lock.yaml`, `tsconfig.base.json`, `requirements-dev.txt`, `tools/go.mod`), especificación copiada en `spec/resend.yaml` con `spec/PIN`, y los comandos `make bootstrap`, `make generate`, `make check`, `make verify` y `make battery`.

### Decisiones
- Especificación fijada en `resend/resend-openapi@8c6f120b3b8a72b749d68c0153a69cf0ca9f5cce` (`resend.yaml`, OpenAPI 3.1.2).
- Generador, servicio de releases, proxy de fallos y servidor de captura en TypeScript sobre Node 26.
- Política común de reintentos: 3 intentos; una escritura sin clave de idempotencia nunca se reintenta tras un fallo ambiguo; el cliente no genera claves solo.
- Errores forzados con un proxy de fallos propio, porque la especificación no define respuestas de error.
