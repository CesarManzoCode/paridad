# Contrato de paridad

Fuente única de lo que el sistema debe hacer y de las decisiones cerradas. Los límites viven solo en `LIMITATIONS.md`; las fuentes, en `vault/RESEARCH.md`. Cada versión de herramienta externa citada aquí se verificó en esta máquina el 23 nov 2026 (ver RESEARCH).

Convención: **[hecho]** observado en K0 con comando o fuente; **[diseño]** decisión aceptada; **[hipótesis]** pendiente de medir.

## 1. Qué es

paridad es una cadena open source que toma la especificación OpenAPI pública de Resend, fijada a un commit, la convierte en una representación intermedia (IR) única y de ella genera, sin edición manual: SDKs en TypeScript, Python y Go, un CLI, un servidor MCP, una skill para agentes y la documentación. Incluye una herramienta de compatibilidad de contrato y un servicio local de releases con cola persistente, métricas y recuperación ante caídas que publica a registros locales de npm, PyPI y Go. Todo corre en Arch Linux con 16 GB, sin servicios de pago, sin cuenta de Resend y sin enviar nunca una petición a la API real.

Debe demostrar, con comparaciones externas y nunca con opiniones, que las cinco superficies ejecutables (SDK TS, SDK Python, SDK Go, CLI, MCP) emiten las mismas peticiones entre sí y las mismas que los SDKs oficiales de Resend, y que autenticación, errores, reintentos, idempotencia, límites de tasa, paginación y fallos parciales se comportan igual en todas. Los criterios C1 a C30 de la idea son los criterios de aceptación del producto; la sección 9 dice cómo se mide cada uno.

## 2. Hechos de partida observados en K0

- [hecho] Especificación fijada: `resend/resend-openapi` commit `8c6f120b3b8a72b749d68c0153a69cf0ca9f5cce` (23 nov 2026), archivo `resend.yaml`, 377 658 bytes, sha256 `084209d12f51f42f1fe71946fee4bce08c0eaf0b07a214c5e87560495d58ef7b`. El readme del repo dice que `resend.yaml` es la fuente de verdad y que `resend.json` se genera; en este commit `resend.json` va un commit atrás (aún declara `Idempotency-Key` en `domains/enable-forge`).
- [hecho] En ese commit: OpenAPI `3.1.2`, `info.version` `1.5.1`, 144 operaciones (62 GET, 43 POST, 20 DELETE, 18 PATCH, 1 PUT), 19 tags, todas con `operationId` único de forma `recurso/accion` (`^[a-z0-9-]+/[a-z0-9-]+$`). `yaml@2.9.1` lo parsea con 0 errores y 0 avisos.
- [hecho] La especificación no define ninguna respuesta de error: solo `200`, `201` y `202`. Los errores salen de la página oficial de errores de Resend (RESEARCH, F-ERR).
- [hecho] En `resend.yaml` seis operaciones declaran la cabecera `Idempotency-Key` (`maxLength: 256`): `emails/send`, `emails/send-batch`, `inboxes/reply-thread-email`, `inboxes/forward-thread-email`, `inboxes/create-draft` e `inboxes/send-draft`. La IR deriva la lista de la especificación, no de este contrato.
- [hecho] Paginación por cursor: 28 GET usan los parámetros compartidos `PaginationLimit`, `PaginationAfter` y `PaginationBefore`.
- [hecho] Historial del archivo: 96 commits tocan `resend.yaml` (95 pares consecutivos); dos versiones tienen defectos de YAML (`5131397` claves duplicadas, `7983096` mapeo compacto anidado), así que hay 91 pares parseables; 37 pares tienen `operationId` en todas las operaciones de ambos lados. El historial completo cabe en un `git bundle` de 238 KB.
- [hecho] Los SDKs oficiales aceptan una URL base local sin tocar su lógica: `resend` (npm) 6.39.0 lee `RESEND_BASE_URL` u opción `baseUrl`; `resend` (PyPI) 2.55.0 lee `RESEND_API_URL`; `github.com/resend/resend-go/v3` v3.17.0 lee `RESEND_BASE_URL` (valor por defecto con `/` final) o el campo `Client.BaseURL`. Ninguno reintenta solo ante 429 o 5xx (el de Go solo expone `RetryAfter` en el error).
- [hecho] El CLI oficial `resend-cli` 2.29.0 (npm, binario `resend`) usa `RESEND_BASE_URL` en su código empaquetado, aunque su documentación no lo menciona. Documenta JSON en stdout fuera de TTY o con `--json`, salida 0/1 y errores `{"error":{"message":…,"code":…}}`.
- [hecho] Error de la API: JSON `{"statusCode","name","message"}` (así lo leen `resend-node` y `resend-python`).
- [hecho] `@modelcontextprotocol/conformance` 0.1.16 en modo `server` solo acepta `--url` (Streamable HTTP); no prueba servidores stdio directamente. Estados de chequeo: `SUCCESS`, `FAILURE`, `WARNING`, `INFO`.
- [hecho] `prism proxy --errors` (Prism 5.16.0) responde 422 `application/problem+json` sin reenviar cuando la petición viola el contrato, y lo registra como `✖  error     Request terminated with error: …UNPROCESSABLE_ENTITY`; las válidas se registran como `> Forwarding`.

## 3. Arquitectura y estructura del repositorio

Una sola tubería: `spec/resend.yaml` + `ir/overlay.yaml` → `ir/ir.json` → emisores por superficie. Todo código no generado de producto e infraestructura está en TypeScript ejecutado por Node 26 con eliminación de tipos nativa (sin paso de build para ejecutar; `tsc` solo para chequear y para empaquetar).

| Ruta | Qué es | Clase (C30) |
| --- | --- | --- |
| `spec/resend.yaml`, `spec/PIN` | Especificación copiada byte a byte del commit fijado; `PIN` lleva URL, commit y sha256 | dato |
| `ir/overlay.yaml` | Anotaciones que el OpenAPI no trae (sección 4) | dato |
| `ir/ir.json` | IR generada, versionada | generado |
| `generator/` | Cargador de spec, constructor de IR, emisores y plantillas (`generator/templates/`) | producto |
| `sdks/typescript/`, `sdks/python/`, `sdks/go/` | SDKs generados, con sus suites de pruebas generadas desde plantillas | generado |
| `cli/`, `mcp/` | CLI y servidor MCP generados (TS) | producto |
| `skill/paridad-resend/` | Skill generada (Agent Skills) | generado |
| `docs/` | Sitio estático HTML generado | generado |
| `compat/` | Herramienta compartida de compatibilidad de contrato y cálculo de semver | producto |
| `release/` | Servicio local de releases | producto |
| `harness/` | Servidor de captura, proxy de fallos, drivers de los SDKs oficiales y puente stdio de MCP | apoyo |
| `verify/` | Corredores de criterios, casos, corpus, divergencias, proyectos de ejemplo, plantillas de React Email | apoyo |
| `tools/go.mod` | Herramientas Go fijadas con directivas `tool` (`oasdiff`, `apidiff`, `scc`) | infraestructura |
| `requirements-dev.txt` | Dependencias Python fijadas para `.venv` | infraestructura |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | Workspace pnpm con versiones exactas | infraestructura |

Reglas:
- El código generado no se edita a mano. Todo cambio pasa por `ir/overlay.yaml`, `generator/` o sus plantillas. `make generate` reescribe por completo `ir/ir.json`, `sdks/`, `cli/`, `mcp/`, `skill/` y `docs/`.
- Cada superficie generada contiene el `operationId` literal de cada operación (en un comentario de documentación, una tabla o un atributo), para que la cobertura sea comprobable en el texto.
- Las pruebas viven junto al código: `generator/**/*.test.ts`, `compat/**/*.test.ts`, `release/**/*.test.ts`, `harness/**/*.test.ts`, y las suites generadas de cada SDK. Las de TS corren con `node --test` (sin framework de pruebas), las de Python con `pytest` y las de Go con `go test`.
- Los paquetes y su versión exacta están en la sección 11 (D37).

## 4. Representación intermedia

`ir/ir.json`, JSON con claves ordenadas, sangría de 2 espacios y salto de línea final:

```json
{
  "format": "paridad-ir/1",
  "spec": {"repository": "https://github.com/resend/resend-openapi", "commit": "8c6f…", "sha256": "0842…", "openapi": "3.1.2", "version": "1.5.1"},
  "project": {"repository": "…", "go_module": "…"},
  "policy": {…},
  "errors": [{"status": 400, "name": "validation_error", "retryable": false}, …],
  "operations": [ … ordenadas por id … ],
  "schemas": { … componentes, como JSON Schema 2020-12 … }
}
```

Cada operación: `id` (el `operationId`), `resource` y `action` (las dos mitades del id), `method`, `path`, `tag`, `summary`, `pathParams`, `queryParams`, `headerParams`, `requestBody` (esquema o `null`), `response` (estado y esquema de éxito), `pagination` (`null` o `{"style":"cursor","limit":"limit","after":"after","before":"before","items":"data","hasMore":"has_more"}`), `idempotency` (booleano), `readOnly` (booleano), `destructive` (booleano), `names` (`{"ts","python","go","cli","mcp"}`), `examples` (entradas de ejemplo válidas para la batería y la documentación).

Qué se deriva y qué se anota:
- Se deriva de la especificación: todo lo estructural; `idempotency` = la operación declara la cabecera `Idempotency-Key`; `pagination` = la operación es GET y usa los parámetros `limit`/`after`/`before` y su respuesta tiene `data` y `has_more`; `readOnly` = método GET; `destructive` = método DELETE; los nombres idiomáticos por regla (TS y Go en camelCase/PascalCase, Python en snake_case, CLI `paridad <resource> <action>`, MCP `<resource>_<action>`).
- `ir/overlay.yaml` solo guarda lo que la especificación no dice: `project` (repositorio y módulo Go, campos obligatorios), `policy` (sección 5.3), `errors` (catálogo de la sección 5.2 con la URL de su fuente), y por `operationId` las excepciones: nombres idiomáticos que la regla haría feos o ambiguos, `destructive: true` en operaciones no DELETE que destruyen o cancelan (por ejemplo `emails/cancel`), y `examples`.
- El generador falla si el overlay nombra un `operationId` que no existe en la especificación fijada, y si una operación queda sin ejemplo. Con `--spec <archivo>` (corpus de compatibilidad) ignora las entradas de operaciones ausentes y usa ejemplos sintetizados del esquema.
- La IR se regenera siempre desde cero; las anotaciones no se pierden porque viven en el overlay, nunca en la salida.

## 5. Comportamiento común de las superficies

### 5.1 Configuración y autenticación

- Clave: opción explícita o variable `RESEND_API_KEY`. URL base: opción o `RESEND_BASE_URL` (por defecto `https://api.resend.com`). Tiempo máximo por intento: opción o `RESEND_TIMEOUT_MS` (por defecto 30000). Son los mismos nombres de variable que usan los SDKs oficiales de Node y Go, para que cambiar de SDK no cambie la configuración.
- Cabecera `Authorization: Bearer <clave>` en cada petición; `Content-Type: application/json` solo si hay cuerpo.
- `User-Agent: paridad-<lenguaje>/<versión>` (`paridad-ts`, `paridad-python`, `paridad-go`; CLI y MCP usan el del SDK TS con sufijo ` cli` o ` mcp`).
- La clave nunca aparece en stdout, stderr, logs, mensajes de error ni trazas. Donde se muestre, va enmascarada como `re_...` seguido de sus 4 últimos caracteres. `paridad config show` imprime la configuración efectiva con la clave enmascarada.

### 5.2 Errores

- Toda respuesta no 2xx se convierte en un error tipado con `code` (el `name` del cuerpo; si falta, `http_<estado>`), `message` (el `message` del cuerpo, sin cambios) y `statusCode`.
- Errores del cliente, sin petición enviada: `invalid_idempotency_key` (clave fuera de 1 a 256 caracteres, mensaje fijo `Idempotency key must be between 1 and 256 characters.`). Errores de transporte: `timeout` y `connection_error`, con `statusCode` nulo.
- Representación idiomática: TS devuelve la unión discriminada `{data: T, error: null} | {data: null, error: ParidadError}` (mismo estilo que `resend-node`); Python lanza `paridad_resend.ParidadError` con `code`, `message`, `status_code`; Go devuelve `(*T, error)` donde el error es `*resend.Error` con `Code`, `Message`, `StatusCode`. El CLI imprime `{"error":{"message","code","statusCode"}}` en stdout y sale con 1. El MCP devuelve un resultado de herramienta con `isError: true`, `structuredContent` igual a ese mismo objeto y su serialización JSON como contenido de texto.
- Catálogo (de la página oficial de errores, F-ERR), que vive en `ir/overlay.yaml`: 400 `validation_error`, `invalid_idempotency_key`; 401 `missing_api_key`, `restricted_api_key`; 403 `invalid_permission`, `restricted_api_key`, `suspended_api_key`, `email_above_quota`; 404 `not_found`; 405 `method_not_allowed`; 409 `concurrent_idempotent_requests`, `invalid_idempotent_request`, `resource_locked`, `forge_not_enabled`; 422 `invalid_parameter`, `invalid_attachment`, `missing_required_field`, `missing_required_parameter`, `forge_unavailable`, `return_path_unavailable`; 429 `rate_limit_exceeded`, `daily_quota_exceeded`, `monthly_quota_exceeded`; 500 `application_error`; 503 `service_unavailable`, `dns_lookup_failed`.

### 5.3 Política de reintentos e idempotencia

La misma en las cinco superficies; vive en `ir/overlay.yaml` (`policy`) y los emisores la copian como constantes.

- `max_attempts`: 3 en total (1 intento y hasta 2 reintentos).
- Operación **segura para reintentar**: método GET, PUT o DELETE, o petición que lleva `Idempotency-Key`.
- Se reintenta siempre (cualquier operación): 429 cuyo `name` es `rate_limit_exceeded` o falta; fallo de conexión antes de enviar la petición (conexión rechazada, DNS).
- Se reintenta solo si la operación es segura: 500, 502, 503, 504; `timeout`; conexión cortada después de enviar, incluida la respuesta cortada a la mitad; 409 `concurrent_idempotent_requests`.
- No se reintenta nunca: 400, 401, 403, 404, 405, 409 (otros), 422, 429 `daily_quota_exceeded` y `monthly_quota_exceeded`, y cualquier fallo ambiguo en una escritura sin clave. Una escritura POST o PATCH sin clave que falla de forma ambigua devuelve el error tipado (`timeout`, `connection_error` o el del servidor) sin reintentar.
- Espera antes del reintento n (n = 1, 2): si la respuesta trae `retry-after` entero en segundos, espera `retry-after × 1000 ms + U[0, 250) ms`; si `retry-after` > 60, no reintenta y devuelve el error. Si no lo trae: `min(8000, 500 × 2^(n−1)) × (0.5 + 0.5·U[0,1)) ms`.
- Un reintento conserva exactamente la misma `Idempotency-Key` y el mismo cuerpo en bytes.
- La clave de idempotencia es opcional y la da el usuario; el cliente no la genera solo (D06). Se valida en el cliente: 1 a 256 caracteres.

### 5.4 Paginación

Las operaciones con `pagination` aceptan `limit`, `after` y `before` como cualquier parámetro, y además ofrecen un iterador idiomático (TS `for await`, Python iterador, Go iterador `iter.Seq2`) que pide la página siguiente con `after = id del último elemento` mientras `has_more` sea verdadero. Cada página sigue la política de 5.3 (GET es seguro). El CLI expone `--all` en esas operaciones y el MCP no pagina solo (devuelve una página y el cursor).

### 5.5 Envío por lotes

`emails/send-batch` se trata como todo o nada: la especificación fijada y la página oficial de la API no documentan aceptación parcial ni la cabecera de modo de validación (solo existe como bandera `--batch-validation` del CLI oficial). Las superficies devuelven la respuesta completa o el error completo; no hay manejo por elemento (D15).

### 5.6 React Email

El SDK TS acepta `react` (un elemento React) en `emails/send` y lo renderiza con `render` de `@react-email/render` antes de enviar, como `resend-node`; `@react-email/render` es dependencia opcional (peer). El CLI acepta `--react <archivo.tsx>` y `--react-props <json>` y usa la misma función. El HTML enviado debe ser byte a byte el que produce `render` para la misma plantilla y props.

## 6. Superficies

- **SDK TS** (`sdks/typescript`, npm `paridad-resend`): sin dependencias de ejecución (usa `fetch` global); `new Resend(key?, options?)`, recursos como propiedades (`resend.emails.send(...)`).
- **SDK Python** (`sdks/python`, PyPI `paridad-resend`, módulo `paridad_resend`): solo biblioteca estándar; tipado completo (`py.typed`); construido con hatchling; `requires-python >=3.10`.
- **SDK Go** (`sdks/go`, módulo `<project.go_module>`, paquete `resend`): solo biblioteca estándar; `context.Context` en cada llamada; `go 1.23` en `go.mod`.
- **CLI** (`cli/`, binario `paridad`, se ejecuta como `node cli/src/main.ts`): un comando por operación, `paridad <resource> <action>`, con banderas derivadas de parámetros y cuerpo (`--body <json>` acepta el cuerpo completo). JSON en stdout cuando stdout no es TTY, hay `CI` en el entorno o se pasa `--json`; salida 0 en éxito y 1 en error; `--idempotency-key`, `--timeout-ms`, `--all`, `--react`, `paridad config show`.
- **MCP** (`mcp/`, `node mcp/src/main.ts --transport stdio|http [--port N]`): construido con `@modelcontextprotocol/sdk`, protocolo `2025-11-25`, transportes stdio y Streamable HTTP (ruta `/mcp`, con validación de `Host`/`Origin` contra DNS rebinding). Una herramienta por operación, nombre `<resource>_<action>` con caracteres `[a-z0-9_-]`; `inputSchema` JSON Schema 2020-12 que une parámetros de ruta, query, cabeceras admitidas y cuerpo; anotaciones `readOnlyHint: true` en GET, `destructiveHint: true` en DELETE y en las marcadas en el overlay, `idempotentHint` según 5.3. La clave sale de `RESEND_API_KEY` del proceso, nunca de los argumentos de la herramienta.
- **Skill** (`skill/paridad-resend/SKILL.md`): formato Agent Skills (frontmatter `name: paridad-resend` igual al directorio, `description` de 1 a 1024 caracteres); enseña el CLI; cada comando del CLI aparece al menos una vez en un bloque de código `bash` con valores concretos ejecutables.
- **Documentación** (`docs/`): HTML estático generado por el propio generador, una página por recurso más índice; cada operación en un elemento con `data-operation-id="<operationId>"` y ejemplos en `<pre><code class="language-typescript|language-python|language-go|language-bash" data-operation-id="…">` ejecutables sin edición contra el servidor de captura.

## 7. Arnés de verificación (apoyo)

- **Servidor de captura** (`harness/capture`): HTTP en `127.0.0.1`. Puerto de control aparte con `POST /__paridad/session {"run","case","surface"}` que fija a quién se atribuyen las peticiones siguientes (los drivers corren uno a la vez). Registra cada petición recibida y responde con el ejemplo de éxito de la operación (o una instancia mínima válida del esquema), de modo que Prism no vea violaciones de respuesta.
- **Proxy de fallos** (`harness/faults`): entre la superficie y el servidor de captura. Un archivo de escenarios por corrida indica, por caso y número de intento, una acción: `pass`, `respond` (estado, cabeceras y cuerpo de error de Resend), `delay` (recibe, reenvía y retrasa la respuesta más allá del timeout del cliente), `cut` (envía cabeceras y parte del cuerpo y corta la conexión). Registra trazas.
- **Drivers** (`harness/oracle`): ejecutan un caso neutral (operación, parámetros, cuerpo, clave de idempotencia) con un SDK oficial o propio, el CLI o el MCP, e imprimen el resultado. Los oficiales se instalan fijados y sin modificar: `resend@6.39.0`, `resend==2.55.0`, `github.com/resend/resend-go/v3 v3.17.0`, `resend-cli@2.29.0`, apuntados con sus variables de URL base (`RESEND_BASE_URL`; en Python `RESEND_API_URL`; en Go con `/` final). El CLI oficial corre con `HOME` temporal, `RESEND_TELEMETRY_DISABLED=1` y `RESEND_NO_UPDATE_NOTIFIER=1`.
- **Puente stdio de MCP** (`harness/mcp-bridge`): expone por Streamable HTTP un servidor MCP stdio reenviando los mensajes JSON-RPC sin cambiarlos, para correr el marco de conformidad sobre stdio (D22).
- Clave de prueba fija para toda la batería: `re_paridad_test_9f8e7d6c5b4a39281706`.

### 7.1 Normalización de peticiones (C3, C5, C8, C17)

Una petición normalizada es el objeto `{method, path, query, headers, body}`:
- `method` en mayúsculas.
- `path`: la parte del request-target antes de `?`, decodificada de porcentajes.
- `query`: lista de pares `[clave, valor]` decodificados (`application/x-www-form-urlencoded`), ordenada por clave y luego valor.
- `headers`: solo `authorization`, `content-type` (solo el tipo de medio, en minúsculas, sin parámetros) e `idempotency-key`; nombres en minúsculas, valores sin espacios en los extremos. No cuentan `user-agent`, `accept`, `accept-encoding`, `content-length`, `host`, `connection` ni ninguna otra.
- `body`: vacío → `null`; si `content-type` es JSON, el JSON parseado y reserializado con claves ordenadas, sin espacios, y los números con parte fraccionaria cero escritos como enteros; si no, `sha256:` más el hash hex de los bytes.

Campos de diferencia: `method`, `path`, `query`, `header:<nombre>`, `body`.

### 7.2 Divergencias justificadas (C3)

`verify/divergences.json`: lista de objetos `{"operation","language","field","spec_ref","reason"}` donde `language` es `ts`, `python` o `go`, `field` es un campo de diferencia de 7.1 y `spec_ref` es un puntero JSON (`#/paths/~1emails/post/...`) que resuelve en `spec/resend.yaml` y muestra que la petición propia sigue la especificación. Una diferencia cuenta como justificada solo si coincide en operación, lenguaje y campo con una entrada. Sin entradas genéricas ni comodines.

## 8. Interfaz de verificación

Todo se corre desde la raíz del repositorio:

| Comando | Qué hace |
| --- | --- |
| `make bootstrap` | `pnpm install --frozen-lockfile`, crea `.venv` con `requirements-dev.txt`, descarga las herramientas de `tools/go.mod` |
| `make generate` | Regenera la IR y todas las superficies |
| `make check` | Comando único de chequeo: formato, tipos y pruebas de todo lo que exista (incluye `bootstrap`); es el que corre la CI |
| `make verify C=cN [SURFACES=ts,python,go]` | Corre la batería del criterio N; borra y reescribe `.paridad/runs/cN/`; sale 0 si pasa, 1 si falla, 77 si se omite |
| `make battery` | Corre `verify` de C1 a C26 en orden, sigue aunque uno falle, escribe `.paridad/runs/battery.json` (`{"c1": código, …}`) y sale 0 solo si todos salen 0 o 77 |

Formatos de artefacto (JSON Lines, un objeto por línea):
- `captures.jsonl` (servidor de captura): `{"case","surface","seq","method","target","headers":[[nombre, valor]…],"body_b64"}`; `headers` en el orden y con los nombres tal como llegaron.
- `traces.jsonl` (proxy de fallos): `{"case","surface","attempt","t_recv_ns","t_resp_end_ns","method","target","headers","body_sha256","action","status","response_headers"}`, tiempos de reloj monotónico del proxy.
- `results.jsonl` (drivers): `{"case","surface","outcome":"ok"|"error","error":{"code","message","statusCode"}|null,"items":[…]|null,"exit_code":int|null}`.
- `out/`: stdout y stderr crudos de cada proceso de superficie (`out/<caso>.<superficie>.stdout|stderr`) y la respuesta JSON-RPC cruda del MCP (`out/<caso>.mcp.json`). `#` y `/` del id de caso se escriben como `_`.

Identificadores de superficie: `ts`, `python`, `go`, `cli`, `mcp`, `official-node`, `official-python`, `official-go`, `official-cli`. Identificador de caso: `<operationId>#<etiqueta>`, salvo los casos con nombre de C9 a C11.

## 9. Criterios y cómo se miden

| Criterio | Corrida y artefactos | Pasa si |
| --- | --- | --- |
| C1 | `make generate` dos veces | los árboles generados son idénticos byte a byte y `git diff --exit-code` y `git status --porcelain` sobre lo generado quedan vacíos |
| C2 | `c2` usa las capturas de `c5` y `docs/` | cada `operationId` de la spec aparece en las capturas de `ts`, `python`, `go`, `cli`, `mcp` (por coincidencia de método y plantilla de ruta) y como `data-operation-id` en `docs/`; imprime `faltantes=0` |
| C3 | `c3/captures.jsonl` con oficial y propio por caso | diferencias normalizadas no listadas en `verify/divergences.json` = 0, con al menos 60 operaciones comparadas por lenguaje; `verify/oracle-coverage.json` lista cada método público de cada SDK oficial con su `operationId` o el motivo por el que no tiene caso |
| C4 | comandos directos | `tsc --strict --noEmit -p sdks/typescript`, `.venv/bin/mypy --strict sdks/python/src/paridad_resend`, `go vet ./...` en `sdks/go` y las tres suites de pruebas salen 0 |
| C5 | `c5/captures.jsonl` | por caso, las peticiones normalizadas de las superficies pedidas son idénticas, y hay al menos un caso por operación; imprime `distintas=0` |
| C6 | `c6/results.jsonl`, `c6/out/` | para cada error de la tabla de 9.1, las cinco superficies exponen el mismo `code` y `message` (los forzados); el CLI sale 1 con `error.message` en stdout; el MCP devuelve `isError: true` con el mismo `code` |
| C7 | `c7/out/` con la batería de errores y paridad en modo depuración | la clave de prueba aparece 0 veces en todo `out/`; `paridad config show` muestra `re_...` y los 4 últimos caracteres |
| C8 | `c8/prism.log`, `c8/captures.jsonl` | la batería de C5 de las cinco superficies pasa por `prism proxy --errors spec/resend.yaml <captura>`; 0 líneas de violación (`✖`, `UNPROCESSABLE_ENTITY`, `Violation: request`) y todas las peticiones reenviadas |
| C9 | `c9/traces.jsonl` | el proxy responde 429 con `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset` y `retry-after: 1`; entre el fin de esa respuesta y el siguiente intento pasan al menos `retry-after × 1000 − 25 ms` y como mucho `retry-after × 1000 + 1000 ms`; nunca más de 3 intentos; las secuencias de estados son iguales en las cinco superficies |
| C10 | `c10/traces.jsonl`, `c10/results.jsonl` | todo reintento de una escritura con clave lleva la misma `Idempotency-Key` y el mismo `body_sha256`; claves de 0 y 257 caracteres no generan ninguna petición y dan `invalid_idempotency_key` con el mismo mensaje en las cinco superficies |
| C11 | `c11/results.jsonl`, `c11/traces.jsonl` | cada caso de 9.2 da el resultado esperado en las cinco superficies, sin escrituras repetidas sin clave ni elementos duplicados |
| C12 | `c12/` | si `sudo -n true` falla, sale 77 (omitido); si no, los casos de 9.2 con pérdida, latencia y reordenamiento de `tc netem` en un network namespace dan los mismos resultados que C11 |
| C13 | `c13/http/`, `c13/stdio/`, `c13/exit.json` | el marco oficial sale 0 en ambos transportes con `verify/mcp-conformance-baseline.yml`; ese archivo solo lista escenarios que dependen de herramientas, prompts o recursos de prueba del propio marco (`test_*`), cada uno con su razón en un comentario, y nunca `server-initialize`, `ping` ni `dns-rebinding-protection` |
| C14 | `tools/list` por stdio, `c14/corpus.jsonl` | biyección herramientas ↔ operaciones; cada `inputSchema` es JSON Schema 2020-12 válido y acepta y rechaza el mismo corpus que el esquema de petición de la spec; DELETE con `destructiveHint: true`, GET con `readOnlyHint: true` |
| C15 | `c15/results.jsonl`, `c15/validate.json` | cada invocación `paridad …` de los bloques de código de la skill sale 0 contra el servidor de captura, cada comando del CLI aparece en la skill, y `agentskills validate skill/paridad-resend` sale 0 |
| C16 | `c16/results.jsonl`, `c16/out/` | con stdout a archivo, cada comando escribe JSON válido (éxito) o JSON con `error.message` (error) y sale 0 o 1; para los comandos de `verify/official-cli-map.json` (al menos 20), coinciden con el CLI oficial el código de salida y las claves de primer nivel |
| C17 | `docs/`, `c17/results.jsonl` | cada ejemplo de la documentación se ejecuta y produce la petición normalizada de su operación; `vnu --errors-only` sobre `docs/` sale 0; 0 enlaces internos rotos |
| C18 | `verify/corpus/`, `c18/matrix.jsonl` | la clasificación propia (rompe o no) coincide con la salida de `oasdiff breaking --fail-on ERR` en todos los pares incluidos (al menos 85 históricos y 24 sintéticos) |
| C19 | `c19/matrix.jsonl`, `c19/raw/` | el salto propuesto nunca es menor que el que exigen `oasdiff`, `api-extractor` (TS), `griffe check` (Python) y `apidiff` (Go), en al menos 30 pares históricos y los 24 sintéticos |
| C20 | `c20/results.jsonl` | los proyectos de `verify/examples/{typescript,python,go}` compilados contra N pasan sus pruebas sin cambios contra N+1 en cada par cuyo salto no es mayor |
| C21 | `.paridad/registries/`, `c21/smoke.jsonl` | la misma versión está en Verdaccio, pypiserver y el GOPROXY por archivos, y la prueba de humo de instalación limpia sale 0 en los tres |
| C22 | `c22/reference/`, `c22/<punto>/` | tras SIGKILL en cada punto de 9.3 y reinicio, el estado de los registros (paquete, versión, sha256 de cada artefacto) es igual al de la corrida de referencia, sin duplicados ni archivos a medias |
| C23 | `c23/metrics.txt`, `c23/queue.sqlite` | `promtool check metrics` sale 0 y `paridad_release_jobs_enqueued_total`, `_completed_total` y `_failed_total` cuadran con la tabla `jobs` |
| C24 | `c24/reference/`, `c24/captures.jsonl` | el campo `html` que envían el CLI y el SDK TS es byte a byte igual al de `render` para cada plantilla de `verify/react-email/` |
| C25 | `c25/matrix.jsonl` | `paridad contract-check <base> <revisión>` sale 0 en pares compatibles y 1 en incompatibles, y en estos las operaciones afectadas coinciden con las de `oasdiff`; además lista las superficies afectadas |
| C26 | clon local nuevo | desde un clon, `make bootstrap && make check` sale 0; tras `git apply verify/c26/add-operation.patch`, `make generate && make check` sale 0 y el nuevo `operationId` aparece en las cinco superficies y la documentación |
| C27 | archivos | existen `LICENSE`, `CONTRIBUTING.md`, plantillas en `.github/ISSUE_TEMPLATE/` y `.github/pull_request_template.md`, y la CI corre `make check` |
| C28 | `vault/DECISION-LOG.md` | tiene las secciones Problema ambiguo, Alternativas descartadas, Solución acotada y Seguimiento después del primer release; su calidad requiere juicio humano |
| C29 | `make battery` dentro de un scope de systemd | `memory.peak` del cgroup del scope queda bajo 8 GiB (8 589 934 592 bytes) |
| C30 | `scc` sobre las rutas de la sección 3 | las líneas de código de producto (sin pruebas) superan las de apoyo (sin pruebas) |

### 9.1 Tabla de errores de C6

Por cada fila, el proxy de fallos responde en todos los intentos con ese estado y el cuerpo `{"statusCode","name","message"}` (en 429, además las cuatro cabeceras de límite con `retry-after: 1`): 400 `validation_error`; 400 `invalid_idempotency_key`; 401 `missing_api_key`; 403 `restricted_api_key`; 404 `not_found`; 405 `method_not_allowed`; 409 `invalid_idempotent_request`; 409 `concurrent_idempotent_requests`; 422 `missing_required_field`; 429 `rate_limit_exceeded`; 429 `daily_quota_exceeded`; 500 `application_error`; 503 `service_unavailable`. Los casos con nombre `error-<estado>-<name>` usan `domains/list` (GET), salvo los de idempotencia, que usan `emails/send` con clave.

### 9.2 Casos de fallos parciales (C11 y C12)

Timeout del cliente en la batería: `RESEND_TIMEOUT_MS=1000`; `delay` retrasa 2000 ms.

| Caso | Operación | Escenario | Resultado esperado |
| --- | --- | --- | --- |
| `timeout-get` | `domains/list` | intento 1 `delay`, intento 2 `pass` | éxito, 2 intentos |
| `timeout-post-key` | `emails/send` con clave | intento 1 `delay`, intento 2 `pass` | éxito, 2 intentos, misma clave y cuerpo |
| `timeout-post-nokey` | `emails/send` sin clave | intento 1 `delay` | error `timeout`, 1 intento |
| `cut-get` | `domains/list` | intento 1 `cut`, intento 2 `pass` | éxito, 2 intentos |
| `cut-post-key` | `emails/send` con clave | intento 1 `cut`, intento 2 `pass` | éxito, 2 intentos, misma clave y cuerpo |
| `cut-post-nokey` | `emails/send` sin clave | intento 1 `cut` | error `connection_error`, 1 intento |
| `5xx-intermittent-get` | `domains/list` | 503, luego `pass` | éxito, 2 intentos |
| `5xx-persistent-get` | `domains/list` | 500 en los 3 intentos | error `application_error`, 3 intentos |
| `5xx-post-nokey` | `emails/send` sin clave | 503 | error `service_unavailable`, 1 intento |
| `paginate-cut` | `contacts/list` con iteración completa, 5 elementos en páginas de 2 | la primera petición de la página 2 `cut` | éxito, 5 elementos únicos, 4 peticiones |

### 9.3 Puntos de corte de C22

El servicio acepta `PARIDAD_RELEASE_PAUSE_AT=<punto>`: al llegar al punto confirma su estado en disco, escribe `paused <punto>` en stderr y se bloquea; el arnés lo mata con SIGKILL y lo reinicia sin la variable. Puntos, en orden: `enqueued`, `claimed`, `versioned`, `built`, `npm_published`, `pypi_published`, `go_published`, `before_complete`.

## 10. Compatibilidad y releases

- **Herramienta compartida** (`compat/`, comando `paridad contract-check <base.yaml> <revision.yaml> [--json]`): clasifica cada cambio como `breaking` o `compatible`, lista las operaciones afectadas (por método y ruta, y por `operationId` si existe) y las superficies afectadas (las cinco más la documentación), propone el salto semver del contrato y sale 0 si es compatible o 1 si rompe. No envuelve `oasdiff`: es una implementación propia que se compara contra él.
- **Corpus** (`verify/corpus/`): `resend-openapi.bundle` (historial completo hasta el commit fijado, licencia MIT de Resend), `history.json` (cada par consecutivo de commits que tocan `resend.yaml`, con `included` o `excluded` y la razón; se excluye un par si un lado no parsea), `synthetic.json` y `synthetic/<id>.json` (parches RFC 6902 sobre la spec fijada). Mutaciones sintéticas, 24 como mínimo: agregar y quitar operación; agregar propiedad de petición opcional y requerida; quitar propiedad de petición; volver requerida u opcional una propiedad; cambiar el tipo de una propiedad de petición y de respuesta; agregar y quitar propiedad de respuesta; agregar y quitar valor de enum en petición; agregar valor de enum en respuesta; agregar parámetro de query opcional y requerido; quitar parámetro de query; cambiar una ruta; quitar la respuesta de éxito; agregar cabecera opcional; quitar la cabecera `Idempotency-Key`; reducir y ampliar `maxLength`.
- **Semver del release**: el salto es el máximo entre el del contrato (herramienta propia) y el de la API pública de cada SDK generado (comparada por la propia herramienta y validada contra `api-extractor`, `griffe` y `apidiff`). Mayor si algo rompe; menor si algo se agrega; parche si no cambia la superficie.
- **Servicio de releases** (`release/`): proceso Node con cola persistente en SQLite (`node:sqlite`, archivo `.paridad/release/queue.sqlite`, tabla `jobs(id, state, version, created_at, updated_at, step, error)` con `state` en `queued|running|done|failed`). Cada trabajo avanza por los pasos de 9.3; cada paso es idempotente: antes de publicar consulta el registro y, si la versión ya existe con el mismo sha256, sigue; si existe con otro, falla el trabajo. Publica con el protocolo de cada registro: `npm publish --registry` a Verdaccio, `twine upload` a pypiserver, y escritura atómica (archivo temporal y `rename`) de `list`, `.info`, `.mod` y `.zip` en el GOPROXY por archivos. Expone `/metrics` en formato de texto de Prometheus, con contadores derivados de la tabla `jobs` al arrancar.
- **Registros locales**: Verdaccio 7.1.2 (almacenamiento en `.paridad/registries/verdaccio/storage`), pypiserver 2.4.3 (`.paridad/registries/pypi/packages`, subida anónima permitida solo en `127.0.0.1`), GOPROXY por archivos en `.paridad/registries/goproxy`.

## 11. Decisiones cerradas

Las 21 primeras son las delegadas por la idea, en su orden. Las siguientes las abrió el diseño.

**D01. Lenguajes del generador, del servicio de releases, del proxy de fallos y del servidor de captura.**
Decisión: TypeScript sobre Node 26 para los cuatro, en un workspace pnpm, ejecutado con eliminación de tipos nativa de Node (sin paso de build) y chequeado con `tsc --strict`.
Razón: un solo toolchain para todo lo no generado reduce dependencias y memoria; TS y Node son el requisito R2 de la vacante y el lenguaje del CLI y del MCP oficiales de Resend.

**D02. Arquitectura y formato de la IR y dónde viven las anotaciones.**
Decisión: `ir/ir.json` (`paridad-ir/1`, sección 4) generado desde la spec y `ir/overlay.yaml`; lo derivable se deriva, y el overlay guarda solo proyecto, política, catálogo de errores y excepciones por `operationId` (nombres, destructivos no DELETE, ejemplos).
Razón: la IR se puede regenerar desde cero sin perder nada porque las anotaciones nunca viven en la salida, y el generador falla si el overlay apunta a algo que no existe.

**D03. Orden de construcción de superficies y criterios.**
Decisión: K1 fija spec e IR, servidor de captura y los tres SDKs contra el oráculo (C1, C3, C4 y C2/C5 parciales); K2 agrega proxy de fallos, CLI, MCP, skill y docs y cierra el comportamiento (C2, C5 a C17, C24); K3 agrega compatibilidad, releases, operación y open source (C18 a C23, C25 a C30).
Razón: todo depende de que la IR y la equivalencia en el cable sean correctas, así que se verifican primero; CLI y MCP se apoyan en el SDK TS ya validado; compatibilidad y releases necesitan superficies estables.

**D04. Commit fijado y corrección de defectos de parseo.**
Decisión: `8c6f120b3b8a72b749d68c0153a69cf0ca9f5cce`, usando `resend.yaml` copiado byte a byte (sha256 en sección 2); no se usa `resend.json`. En ese commit no hay defectos de parseo, así que no hay parches; si un pin futuro los tuviera, se corrigen con parches RFC 6902 solo sintácticos aplicados en memoria y anotados en el CHANGELOG. En el corpus, las versiones históricas que no parsean se excluyen, no se corrigen.
Razón: es el último commit al 23 nov 2026 y el YAML es la fuente de verdad declarada (el JSON va un commit atrás); excluir en vez de corregir evita alterar la semántica de lo que se compara.

**D05. Política de reintentos.**
Decisión: la de 5.3: 3 intentos; 429 de tasa y fallos antes de enviar siempre; 5xx, timeouts, cortes y 409 concurrente solo en operaciones seguras (GET, PUT, DELETE o con clave); `retry-after` + jitter de 0 a 250 ms, sin reintentar si supera 60 s; si no, backoff exponencial 500 ms × 2^(n−1) con tope de 8 s y jitter proporcional; una escritura sin clave nunca se reintenta tras un fallo ambiguo.
Razón: Resend no procesa una petición rechazada con 429, así que reintentarla es seguro; un fallo ambiguo en una escritura sin clave puede haber enviado el email, y solo la idempotencia hace seguro repetirla.

**D06. Claves de idempotencia automáticas.**
Decisión: el cliente no genera claves solo; solo usa la que da el usuario y la valida (1 a 256 caracteres).
Razón: los SDKs oficiales no la generan, así que una clave automática cambiaría el cable en la operación más importante (`emails/send`) frente al oráculo, y ocultaría que la deduplicación depende de una ventana del servidor que no se puede probar en local.

**D07. Normalización de peticiones y divergencias.**
Decisión: la de 7.1 (cuentan método, ruta decodificada, query ordenada, `authorization`, tipo de medio de `content-type`, `idempotency-key` y cuerpo JSON canónico; `user-agent` y el resto de cabeceras no cuentan) y divergencias en `verify/divergences.json` con puntero a la spec por operación, lenguaje y campo.
Razón: son las partes de la petición que cambian el efecto en el servidor; `user-agent` identifica a cada SDK por diseño, y exigir un puntero a la spec impide justificar una diferencia sin evidencia.

**D08. Cómo apuntar los SDKs oficiales y el CLI oficial a un servidor local.**
Decisión: por sus variables de entorno: `RESEND_BASE_URL` en `resend-node`, `resend-go` (con `/` final) y `resend-cli`; `RESEND_API_URL` en `resend-python`. C16 sí compara contra el CLI oficial.
Razón: se observó en el código de las versiones fijadas que esas variables definen la URL base sin tocar la lógica; en el CLI la variable no está documentada, así que si una versión futura la quita, C16 queda solo contra el contrato documentado.

**D09. Cómo forzar cada respuesta de error documentada.**
Decisión: con el proxy de fallos propio, que devuelve el estado, las cabeceras y el cuerpo `{"statusCode","name","message"}` de Resend; Prism se usa solo en C8 para validar las peticiones.
Razón: la spec fijada no define ninguna respuesta de error, así que Prism no puede producirlas desde el contrato; el proxy además controla cortes, demoras y secuencias por intento.

**D10. Comparación de API pública por SDK.**
Decisión: Python con `griffe check` (griffe 2.4.1); Go con `apidiff` (`golang.org/x/exp/cmd/apidiff` en `v0.0.0-20261121134650-e1094eeca1b5`); TS con los reportes `.api.md` de `@microsoft/api-extractor` 7.60.1 comparados entre N y N+1 (línea quitada o cambiada = mayor, solo agregadas = menor).
Razón: las tres se instalaron y ejecutaron en esta máquina; griffe detecta rupturas de API en paquetes Python y apidiff separa cambios compatibles e incompatibles; api-extractor no clasifica solo, pero su reporte es la API pública canónica de un paquete TS.

**D11. Composición y tamaño del corpus.**
Decisión: C18 y C25 usan los 91 pares históricos parseables (mínimo exigido 85, por si `oasdiff` rechaza alguno; los excluidos llevan su razón) y al menos 24 mutaciones sintéticas de la sección 10; C19 y C20 usan los pares históricos con `operationId` completo en ambos lados (37; mínimo 30) y las mismas mutaciones.
Razón: el historial real es la mejor muestra de cambios que Resend hace de verdad, las mutaciones cubren lo que el historial no trae, y generar SDKs exige `operationId`.

**D12. Puntos de corte de C22 y casos de C11.**
Decisión: los 8 puntos de 9.3 y los 10 casos de 9.2.
Razón: los puntos cubren cada transición de estado de la cola y el hueco entre cada publicación y su confirmación; los casos cubren las cuatro familias de fallo del criterio en lectura, escritura con clave y escritura sin clave.

**D13. Umbrales numéricos.**
Decisión: memoria pico de C29 bajo 8 GiB medida como `memory.peak` del cgroup v2 de un scope `systemd-run --user`; tolerancia de C9 de −25 ms a +1000 ms sobre `retry-after`; no se fija tiempo máximo de batería: se mide y se registra en el README, y cada criterio tiene solo un límite anti-cuelgue de 30 minutos.
Razón: 8 GiB deja la mitad de la máquina al sistema y `memory.peak` es una medida del kernel que incluye a todos los procesos hijos; los tiempos no se estiman a ojo antes de medirlos.

**D14. Plantillas y versión de React Email.**
Decisión: tres plantillas propias en `verify/react-email/` (`welcome.tsx`, `reset-password.tsx`, `receipt.tsx` con tabla e imagen) con `@react-email/components` 1.0.12, `@react-email/render` 2.3.1, `react` y `react-dom` 19.3.1.
Razón: cubren texto, botón, enlaces, tabla e imagen con versiones actuales que se ejecutaron en esta máquina; plantillas propias evitan depender de ejemplos que cambien.

**D15. `/emails/batch` ante errores por elemento.**
Decisión: todo o nada; sin manejo por elemento y sin cabecera de modo de validación.
Razón: ni la spec fijada ni la página oficial de la API documentan aceptación parcial; el modo `permissive` solo aparece como bandera del CLI oficial, sin forma de respuesta documentada.

**D16. Registros locales y sitio de documentación.**
Decisión: Verdaccio 7.1.2, pypiserver 2.4.3 y GOPROXY por archivos; el sitio lo emite el propio generador como HTML estático.
Razón: los tres registros corren como usuario sin servicios externos; un sitio emitido por el generador no añade una herramienta más y es determinista para C1.

**D17. Conteo de líneas de C30.**
Decisión: `scc` v3.7.0 (desde `tools/go.mod`), líneas de código sin comentarios ni blancos; producto = `generator/`, `compat/`, `release/`, `cli/`, `mcp/`; apoyo = `harness/`, `verify/`; las pruebas no cuentan en ninguno de los dos lados y se reportan aparte; los SDKs generados tampoco cuentan.
Razón: es la lista de producto del propio criterio; dejar fuera los SDKs generados evita inflar el producto con código repetido por operación.

**D18. Lenguajes adicionales.**
Decisión: ninguno.
Razón: TS, Python y Go son los únicos con oráculo oficial elegido y toolchain ya presente; otro lenguaje multiplica la matriz sin cubrir un requisito nuevo.

**D19. Licencia.**
Decisión: MIT.
Razón: permite contribuciones externas y es la licencia de la spec, los SDKs y el CLI de Resend.

**D20. Cómo mantienen consistencia SendGrid, Postmark y Supabase.**
Decisión: se toma como referencia el chequeo de Supabase (`pnpm generate:check` falla ante cualquier diferencia y los archivos generados se comparan byte a byte con su snapshot), que es lo que C1 ya exige; de SendGrid y Postmark no se toma nada.
Razón: SendGrid publica OpenAPI en beta y solo autogenera su librería Java; Postmark no publica OpenAPI ni dice cómo produce sus librerías (RESEARCH, F-CMP).

**D21. Formato de la skill y validador.**
Decisión: Agent Skills (`SKILL.md` con frontmatter `name` y `description`); se valida con `agentskills validate` del paquete PyPI `skills-ref` 0.1.1, y esa validación entra en C15.
Razón: la especificación oficial define el formato y su repositorio publica ese validador de referencia, que se ejecutó aquí y rechaza nombres inválidos.

**D22. Conformidad MCP sobre stdio.**
Decisión: el marco corre directo contra Streamable HTTP y, para stdio, contra el puente de `harness/mcp-bridge`, que reenvía los mensajes sin cambiarlos.
Razón: el marco solo acepta `--url` en modo servidor; el puente no interpreta los mensajes, así que lo que se mide sigue siendo el servidor stdio (contradicción resuelta, sección 12).

**D23. Fallos esperados de conformidad.**
Decisión: `verify/mcp-conformance-baseline.yml` solo admite escenarios que exigen herramientas, prompts o recursos de prueba del marco, con razón por entrada; nunca `server-initialize`, `ping` ni `dns-rebinding-protection`.
Razón: añadir herramientas `test_*` al servidor rompería la biyección de C14 con el contrato de Resend; el marco ya falla si una entrada del baseline pasa.

**D24. C12 sin sudo.**
Decisión: si `sudo -n true` falla, C12 sale 77 y cuenta como omitido, no como fallo.
Razón: así lo fija la idea; los fallos de C12 en espacio de usuario ya los cubre C11.

**D25. Nombres de paquetes y binarios.**
Decisión: npm `paridad-resend`, PyPI `paridad-resend` (módulo `paridad_resend`), Go `<project.go_module>` con valor inicial `github.com/CesarManzoCode/paridad/sdks/go` y paquete `resend`; binarios `paridad` y `paridad-mcp`.
Razón: nombres propios evitan confundirse con los paquetes oficiales `resend`; el módulo Go depende del repositorio público, que confirma César (sección 13).

**D26. Modelo de errores por superficie.**
Decisión: el de 5.2.
Razón: es idiomático en cada lenguaje (unión discriminada en TS como `resend-node`, excepción en Python, `error` en Go) y conserva en las cinco el mismo `code`, `message` y `statusCode`, que es lo que C6 compara.

**D27. Contrato del CLI.**
Decisión: `paridad <resource> <action>` derivado del `operationId`; JSON y salida 0/1 como el CLI oficial; errores `{"error":{"message","code","statusCode"}}`; clave enmascarada `re_...` y 4 últimos caracteres.
Razón: reproduce el contrato documentado del CLI oficial (mismas claves de primer nivel), y el nombre derivado hace mecánica la cobertura de C15.

**D28. Nombres y transportes del MCP.**
Decisión: herramienta `<resource>_<action>`, transportes stdio y Streamable HTTP en `/mcp`, con el SDK oficial `@modelcontextprotocol/sdk` 1.32.2.
Razón: el nombre es reversible al `operationId` (los recursos no tienen `_`) y solo usa caracteres que cualquier cliente acepta; el SDK oficial es una biblioteca de protocolo, no un generador de código.

**D29. Interfaz de verificación y artefactos.**
Decisión: los comandos y formatos de la sección 8, con artefactos crudos en `.paridad/runs/`.
Razón: una verificación externa puede recalcular cada criterio desde capturas, trazas y salidas crudas sin creer en lo que el programa dice de sí mismo.

**D30. Versión de OpenAPI.**
Decisión: el cargador admite OpenAPI 3.0.x y 3.1.x; la IR usa JSON Schema 2020-12.
Razón: la spec fijada es 3.1.2 (la investigación decía 3.0.3, versión vieja) y el corpus histórico incluye versiones 3.0; MCP usa 2020-12 por defecto.

**D31. Cobertura del oráculo en C3.**
Decisión: cada método público de cada SDK oficial que corresponde a una operación tiene caso; los que no tienen operación (ayudas, webhooks locales) se listan con motivo en `verify/oracle-coverage.json`; mínimo 60 operaciones comparadas por lenguaje.
Razón: los SDKs oficiales no cubren igual las 144 operaciones (`resend-go` 3.17.0 tiene 127 métodos de servicio); las operaciones sin oráculo quedan cubiertas por C5 y C8.

**D32. Dependencias de ejecución de los SDKs.**
Decisión: cero dependencias de ejecución en los tres SDKs (React Email es dependencia opcional del de TS).
Razón: C21 instala desde registros locales sin red; una dependencia de ejecución obligaría a espejar PyPI o npm.

**D33. Toolchain local y de CI.**
Decisión: Node 26, pnpm 11.25.0, Python 3.14, Go 1.27, TypeScript 7.0.2; la CI usa `actions/checkout@v7`, `pnpm/action-setup@v6`, `actions/setup-node@v7`, `actions/setup-python@v7` y `actions/setup-go@v7`, y corre `make check`.
Razón: son las versiones instaladas en la máquina de César y las últimas publicadas de cada acción; la CI corre el mismo comando de chequeo que se usa en local.

**D34. Registro de decisiones de C28.**
Decisión: `vault/DECISION-LOG.md`, escrito al cerrar K3, con las cuatro secciones del criterio.
Razón: es conocimiento público del proyecto y el vault normal es su lugar; no se crea una subcarpeta para un solo archivo.

## 12. Contradicciones resueltas

- **Versión de la spec.** La investigación dice OpenAPI 3.0.3 y `info.version` 1.5.0; el commit fijado es 3.1.2 y 1.5.1. Gana lo observado (D30).
- **Errores de C6 y spec.** C6 habla de "cada respuesta de error que la especificación define", pero la spec fijada no define ninguna. Se usa el catálogo de la página oficial de errores y la tabla de 9.1 (D09).
- **C13 y stdio.** C13 pide el marco oficial en stdio y en Streamable HTTP, pero el marco solo prueba por URL. Se resuelve con el puente que reenvía sin interpretar (D22).
- **C8 y respuestas.** `prism proxy --errors` también valida respuestas; C8 cuenta solo violaciones de petición sobre la batería de éxito, y el servidor de captura responde con ejemplos válidos para que no haya ruido.

## 13. Configuración pendiente de César

- `project.repository` y `project.go_module` en `ir/overlay.yaml` (obligatorios; la verificación de K1 comprueba que existan). Valor inicial: `https://github.com/CesarManzoCode/paridad` y `github.com/CesarManzoCode/paridad/sdks/go`. Si César publica con otro dueño o nombre, solo cambian esos dos campos y se regenera.
- Remoto `origin` del repositorio para publicar las ramas. Sin remoto, el trabajo queda en commits locales.
- Opcional: sudo sin contraseña para `ip netns` y `tc` si se quiere C12 medido en vez de omitido.
