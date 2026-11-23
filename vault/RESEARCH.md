# Investigación y fuentes

Fuentes primarias con su revisión fijada. Todo lo marcado como "ejecutado" se instaló o corrió en la máquina de César (Arch Linux x86-64, 16 GB) el 23 nov 2026; las páginas web se leyeron ese mismo día. Lo que el contrato afirma de una herramienta externa sale de aquí.

## Entorno observado

| Herramienta | Versión observada | Cómo |
| --- | --- | --- |
| Node.js | v26.13.0 (eliminación de tipos nativa y `node:sqlite` con SQLite 3.54.0 funcionan) | `node --version`, prueba de un `.ts` y de `node:sqlite` |
| pnpm | 11.25.0 | `pnpm --version` |
| Python | 3.14.10, sin `pip` del sistema; `python3 -m venv` trae pip 26.2.2 | `python3 --version`, venv de prueba |
| Go | go1.27.4 linux/amd64 | `go version` |
| Java | OpenJDK 17.0.21 (lo necesita `vnu.jar`) | `java --version` |
| promtool | 3.16.0 | `promtool --version` |
| iproute2 (`ip`, `tc`) | 7.3.0 | `tc -V` |
| sudo | `sudo -n true` falla: pide contraseña | ejecutado |
| systemd | `systemd-run --user --scope -p MemoryAccounting=yes` crea un cgroup v2 con `memory.peak` legible | ejecutado |
| Arquitectura | x86_64, 12 hilos, 14 GiB visibles | `uname -m`, `nproc`, `free` |

## Contrato de Resend

- **F-SPEC** `https://github.com/resend/resend-openapi` commit `8c6f120b3b8a72b749d68c0153a69cf0ca9f5cce` (2026-11-23), `resend.yaml` sha256 `084209d12f51f42f1fe71946fee4bce08c0eaf0b07a214c5e87560495d58ef7b`. Ejecutado: clon completo, parseo con `yaml@2.9.1` (0 errores), conteo de operaciones, historial (`git log -- resend.yaml`: 96 commits), `git bundle` de 238 KB. Licencia MIT (Plus Five Five, Inc). El readme declara `resend.yaml` como fuente de verdad y `resend.json` como generado.
- **F-ERR** https://resend.com/docs/api-reference/errors.md — catálogo de errores (estado, `name`, mensaje, acción sugerida). No muestra la forma JSON del error.
- **F-BATCH** https://resend.com/docs/api-reference/emails/send-batch-emails.md — hasta 100 emails por llamada, `attachments` no admitido, cabecera `Idempotency-Key`; no documenta aceptación parcial ni cabecera de modo de validación.
- **F-CLIDOC** https://resend.com/docs/cli-agents.md y https://resend.com/docs/cli.md — modo máquina fuera de TTY o con `--json`, `-q` implica `--json`, salida 0/1, error `{"error":{"message","code"}}`, bandera `--batch-validation strict|permissive` (por defecto `strict`). No documenta cómo cambiar la URL base.
- **F-IDEM** https://www.resend.com/docs/dashboard/emails/idempotency-keys.md — clave de 1 a 256 caracteres; si no, 400 `invalid_idempotency_key` (citada en la investigación adjunta y coherente con F-ERR).
- **F-RATE** https://www.resend.com/docs/api-reference/rate-limit.md — 429 con `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset` y `retry-after` (investigación adjunta). Las cifras de límite por defecto discrepan entre páginas (10, 5 y 2 por segundo); paridad no usa ninguna: el proxy de fallos toma el límite como parámetro.

## Oráculos oficiales

- **F-NODE** npm `resend@6.39.0` (repo `resend/resend-node`). Ejecutado `npm pack` y lectura de `dist/index.mjs`: URL base = opción `baseUrl` o `RESEND_BASE_URL`; `User-Agent` `resend-node:<versión>` o `RESEND_USER_AGENT`; envía `Idempotency-Key` si se pasa `idempotencyKey`; sin lógica de reintento.
- **F-PY** PyPI `resend==2.55.0`. Ejecutado `pip download` y lectura de `resend/__init__.py` y `request.py`: `api_url = os.environ.get("RESEND_API_URL", "https://api.resend.com")`; `User-Agent: resend-python:<versión>`; lee `statusCode` y `name` del cuerpo de error; sin reintentos.
- **F-GO** `github.com/resend/resend-go/v3@v3.17.0` (commit `f0f31c6fffa961fa6e4e179aee4366a585c85f7f`). Ejecutado `go mod download` y lectura de `resend.go` y `errors.go`: `defaultBaseURL = getEnv("RESEND_BASE_URL", "https://api.resend.com/")`, `Client.BaseURL`, `Idempotency-Key` solo en POST, `RetryAfter` expuesto en el error de límite, sin reintentos; 127 métodos de servicio sin contar las variantes `WithContext`.
- **F-CLI** npm `resend-cli@2.29.0` (repo `resend/resend-cli`, binario `resend`). Ejecutado `npm pack` y lectura de `dist/cli.cjs`: usa `RESEND_BASE_URL` (con `https://api.resend.com` por defecto) y las variables `RESEND_API_KEY`, `RESEND_PROFILE`, `RESEND_TELEMETRY_DISABLED`, `RESEND_NO_UPDATE_NOTIFIER`, `RESEND_USER_AGENT`, `RESEND_CREDENTIAL_STORE`.

## MCP

- **F-MCPSPEC** https://modelcontextprotocol.io/specification/2025-11-25/server/tools — `inputSchema` debe ser JSON Schema válido y usa 2020-12 si no trae `$schema`; los errores de ejecución van en el resultado con `isError: true`, los de protocolo como error JSON-RPC; las anotaciones son pistas no confiables. Esa página no define los nombres `readOnlyHint` y `destructiveHint`; los usa el criterio C14 de la idea y los expone el SDK oficial.
- **F-CONF** npm `@modelcontextprotocol/conformance@0.1.16`. Ejecutado `conformance --help`, `server --help` y `list`: modo servidor solo con `--url`; `--expected-failures <yaml>` con claves `server:`/`client:`; sale 1 si un esperado pasa; resultados en `checks.json` con estados `SUCCESS`, `FAILURE`, `WARNING`, `INFO`; escenarios de servidor de la versión 2025-11-25, varios dependientes de herramientas de prueba `test_*`.
- **F-MCPSDK** npm `@modelcontextprotocol/sdk@1.32.2` (versión publicada; se instala en K2).

## Herramientas de comparación

- **F-PRISM** npm `@stoplight/prism-cli@5.16.0`. Ejecutado `prism proxy resend.yaml <upstream> --errors`: petición válida reenviada (`> Forwarding`), petición inválida respondida con 422 `application/problem+json` y registrada como `✖  error     Request terminated with error: …UNPROCESSABLE_ENTITY`. La documentación web de Prism respondió 404 al leerla; lo afirmado sale de la ejecución.
- **F-OASDIFF** `github.com/oasdiff/oasdiff@v1.39.0` (commit `21b8a57a0a192e7478b764ec0164b5694cce3393`; el módulo `tufin/oasdiff` apunta al mismo commit). Ejecutado `oasdiff breaking --help`: `-o, --fail-on ERR|WARN|MISSING-VERSION-BUMP`, `-f, --format` (`json`, `yaml`, `text`, …).
- **F-APIDIFF** `golang.org/x/exp/cmd/apidiff@v0.0.0-20261121134650-e1094eeca1b5`. Ejecutado: `apidiff OLD NEW`, `-m` compara módulos, `-w FILE IMPORT_PATH` escribe datos de exportación, `-incompatible` muestra solo incompatibles.
- **F-APIEX** npm `@microsoft/api-extractor@7.60.1`. Ejecutado `api-extractor --help`: comandos `init` y `run`.
- **F-GRIFFE** PyPI `griffe==2.4.1`. Ejecutado `griffe check --help`: `-a/--against REF`, `-b/--base-ref`, `-s/--search`, formatos `oneline|verbose|markdown|github|azdo`.
- **F-SCC** `github.com/boyter/scc/v3@v3.7.0` (commit `74d4df231aad307f24149456afb1bd420e0f71be`). Ejecutado: `--format json`, `-M/--not-match`, `--exclude-dir`.
- **F-VNU** npm `vnu-jar@26.11.20` (Nu Html Checker). Ejecutado `vnu --version`; el jar queda en `node_modules/vnu-jar/build/dist/vnu.jar`.
- **F-PROM** promtool 3.16.0 del sistema (`promtool check metrics` lee de stdin).

## Skill

- **F-SKILL** https://agentskills.io/specification — `SKILL.md` con frontmatter obligatorio `name` (1 a 64 caracteres, minúsculas, dígitos y guiones, sin guion al inicio o al final ni `--`, igual al nombre del directorio) y `description` (1 a 1024); opcionales `license`, `compatibility`, `metadata`, `allowed-tools`. Validador de referencia `skills-ref`.
- **F-SKILLREF** PyPI `skills-ref==0.1.1` (repo `anthropics/agentskills`). Ejecutado: el binario se llama `agentskills`; `agentskills validate <dir>` sale 0 con una skill válida y 1 con un nombre inválido o distinto del directorio.

## React Email

- **F-REMAIL** npm `@react-email/render@2.3.1` (exporta `render`, `pretty`, `toPlainText`), `@react-email/components@1.0.12`, `react@19.3.1`, `react-dom@19.3.1`. Ejecutado: `await render(<Html><Button/></Html>)` devuelve HTML con doctype XHTML 1.0 Transitional.
- **F-ESBUILD** npm `esbuild@0.28.2`. Ejecutado: `build({bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', packages: 'external'})` sobre una plantilla `.tsx`, importación del resultado y `render` con props: funciona. Node 26 no ejecuta JSX con la eliminación de tipos.

## Registros y publicación

- **F-VERD** npm `verdaccio@7.1.2` (etiqueta `latest`). Observado: `verdaccio --version` imprime `v9.0.0-next-9.46` aunque el paquete instalado es 7.1.2.
- **F-PYPISRV** PyPI `pypiserver==2.4.3` (`pypi-server run -p PORT -a AUTH -P PASSWORDS`), `twine==7.0.0`, `build==1.6.1`, `hatchling==1.33.0`.
- **GOPROXY por archivos**: el protocolo de módulos de Go (`list`, `.info`, `.mod`, `.zip` bajo `@v/`, rutas con mayúsculas escapadas como `!c`). Se verificará al construir el servicio en K3 con `GOPROXY=file://…`.

## Dependencias de desarrollo fijadas

npm: `typescript@7.0.2`, `yaml@2.9.1`, `ajv@8.20.0`, `@types/node@26.6.6`, `@types/react@19.3.0`. PyPI: `mypy==2.4.1`, `pytest==9.2.0`. Todas consultadas en su registro el 23 nov 2026.

## Integración continua

Últimas versiones publicadas el 23 nov 2026 (API de GitHub): `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `actions/setup-python` v7.1.0, `actions/setup-go` v7.1.0, `pnpm/action-setup` v6.1.1.

## Comparables

- **F-CMP** SendGrid: https://github.com/twilio/sendgrid-oai publica OpenAPI en beta y solo autogenera `sendgrid-java`; el README de `sendgrid-nodejs` no menciona generación. Postmark: https://postmarkapp.com/developer no publica OpenAPI; el README de `postmark.js` no dice cómo se produce. Supabase: https://github.com/supabase/cli (`packages/api`) genera un SDK de la Management API desde su OpenAPI; `pnpm generate:check` falla ante cualquier diferencia y una prueba compara lo generado byte a byte con su snapshot.
- Stripe, Stainless, Twilio y Speakeasy: ver la investigación adjunta del proyecto (fuentes de octubre y noviembre de 2026); son contexto, no entran en ninguna medición.

## Vacante

Publicaciones Ashby `53d3710a-2d55-42ac-ba90-cdfd306bf560` (Américas) y `2e3d92c5-79d9-4511-8faf-e2326e7a081e` (Europa), listadas al 23 nov 2026 según https://api.ashbyhq.com/posting-api/job-board/resend?includeCompensation=true. La tabla requisito → criterio está en la investigación adjunta.

## Huecos que siguen abiertos

- Si los SDKs oficiales se generan desde el OpenAPI o se escriben a mano.
- Forma de la respuesta de `/emails/batch` en modo `permissive`.
- Sandbox oficial gratuito para probar deduplicación y límites reales: no existe a esta fecha.
