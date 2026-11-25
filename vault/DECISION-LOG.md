# Registro de decisiones

Registro de C28 (D34). Resume, desde `vault/CONTRACT.md` y la historia de git de la rama `k3`, qué estaba abierto, qué se descartó, qué se construyó y qué se sabe después del primer release local. Las decisiones completas, con su razón, están en la sección 11 del contrato; los límites, en `LIMITATIONS.md`.

## Problema ambiguo

La idea pide demostrar que cinco superficies generadas (SDK TS, SDK Python, SDK Go, CLI y MCP) "se comportan igual" entre sí y que los SDKs oficiales de Resend, sin cuenta de Resend y sin tocar la API real. Esa frase no se puede medir tal como está, por cinco hechos observados en K0 (sección 2 del contrato):

- La especificación fijada (`resend/resend-openapi@8c6f120b`, OpenAPI 3.1.2, 144 operaciones) no define ninguna respuesta de error: solo `200`, `201` y `202`. "Cada respuesta de error que la especificación define" es un conjunto vacío.
- Los SDKs oficiales (`resend@6.39.0`, `resend==2.55.0`, `resend-go/v3 v3.17.0`) no reintentan solos ante 429 ni 5xx. No hay oráculo externo para reintentos, idempotencia ni fallos parciales.
- Ni la especificación ni la referencia de la API documentan aceptación parcial en `/emails/batch`; el modo `permissive` solo existe como bandera del CLI oficial.
- El CLI oficial `resend-cli` 2.29.0 acepta una URL base solo por una variable que está en su código y no en su documentación.
- El marco oficial de conformidad MCP 0.1.16 solo prueba servidores por URL, y la idea pide probar también stdio.

Además, "la misma petición" no dice qué partes de la petición cuentan: `user-agent` es distinto por diseño en cada SDK y `resend-node` envía `content-type` aun sin cuerpo.

## Alternativas descartadas

Cada una con la decisión del contrato que la cierra:

- **Partir de `resend.json`** en lugar de `resend.yaml`: en el commit fijado el JSON va un commit atrás (aún declara `Idempotency-Key` en `domains/enable-forge`) y el readme del repositorio declara el YAML como fuente (D04).
- **Corregir las versiones históricas que no parsean** (`5131397`, `7983096`): se excluyen del corpus con su razón, para no alterar la semántica de lo que se compara (D04, D11).
- **Producir los errores con Prism**: la spec no tiene respuestas de error que Prism pueda servir; se usa un proxy de fallos propio, y Prism solo valida peticiones en C8 (D09).
- **Generar claves de idempotencia en el cliente**: los SDKs oficiales no lo hacen, así que cambiaría el cable de `emails/send` frente al oráculo (D06).
- **Reintentar escrituras sin clave tras un fallo ambiguo**: pueden haber enviado el email; solo se reintentan si llevan `Idempotency-Key` (D05).
- **Manejo por elemento en `/emails/batch`**: sin forma de respuesta documentada; todo o nada (D15).
- **Agregar las herramientas `test_*` del marco de conformidad al servidor MCP**: rompería la biyección herramientas ↔ operaciones de C14; esos escenarios van en el baseline con su razón (D23).
- **Comparar todas las cabeceras**: solo cuentan `authorization`, el tipo de medio de `content-type` con cuerpo e `idempotency-key` (D07).
- **Exigir las 144 operaciones contra cada SDK oficial**: `resend-go` 3.17.0 expone menos métodos de servicio; se exige un mínimo de 60 por lenguaje y `verify/oracle-coverage.json` da el motivo de cada hueco (D31).
- **Envolver `oasdiff`** en la herramienta de compatibilidad: `compat/` es una implementación propia que se compara contra `oasdiff` v1.39.0 en C18 y C25 (sección 10). En `2198953` se observó que, sin `--include-path-params`, `oasdiff` rechaza 19 pares del historial por "duplicate endpoint"; con la opción acepta los 91 pares parseables, así que la comparación se hace con ella.
- **Lenguajes adicionales**: ninguno; multiplican la matriz sin oráculo elegido (D18).
- **Un generador de sitio de documentación**: el propio generador emite HTML estático, determinista para C1 (D16).
- **Contar los SDKs generados como producto en C30**: inflarían el producto con código repetido por operación (D17).
- **Fijar un tiempo máximo de batería antes de medirlo**: solo hay un límite anti-cuelgue de 30 minutos por criterio (D13).

## Solución acotada

Una sola tubería (sección 3): `spec/resend.yaml` (copia byte a byte, sha256 en `spec/PIN`) más `ir/overlay.yaml` dan `ir/ir.json`, y de la IR salen los tres SDKs, el CLI, el MCP, la skill y la documentación con `make generate`. El overlay guarda solo lo que la especificación no dice. "Igual" se define así:

- **Peticiones**: igualdad de la petición normalizada de la sección 7.1 entre las cinco superficies (C5) y contra los SDKs oficiales (C3). Cada diferencia con un oficial necesita una entrada en `verify/divergences.json` con un puntero a la spec que muestre que la petición propia la sigue (D07).
- **Errores**: el catálogo de la página oficial de errores, forzado por el proxy de fallos con la tabla de 9.1 (D09, sección 12).
- **Reintentos, idempotencia y fallos parciales**: una política declarada (5.3) que las cinco superficies copian de la IR y que se compara entre ellas y contra las trazas del proxy (C9 a C11), porque no hay oráculo oficial.
- **MCP sobre stdio**: un puente que reenvía los mensajes sin cambiarlos (D22).
- **Compatibilidad y releases**: `paridad contract-check` propio, contrastado con `oasdiff`, `api-extractor`, `griffe` y `apidiff` sobre el historial real y 26 mutaciones sintéticas (C18 a C20, C25), y un servicio de releases con cola SQLite que publica a Verdaccio, pypiserver y un GOPROXY por archivos (C21 a C23).

Cada criterio se mide con `make verify C=cN` sobre artefactos crudos en `.paridad/runs/` (D29). Orden de construcción (D03), según la historia de git: K1 fijó spec, IR, servidor de captura y los tres SDKs (`7c747fc` a `7b3c3cf`, cierre `127d6a8`); K2 agregó proxy de fallos, CLI, MCP, skill, documentación y sus corredores (`813988b` a `962b011`, cierre `3ba0f27`); K3 agregó `compat/` (`f85c93a`), el corpus (`2198953`), el semver de los SDKs (`c822a2e`), el servicio de releases (`2720354`), los registros locales (`8777824`) y, en k3-06, los corredores C26, C27, C29 y C30 y los archivos para contribuidores.

Queda fuera, por construcción: la API real de Resend (deduplicación, límites por equipo, entrega), otros sistemas operativos que Arch Linux en x86-64 y cualquier generador de terceros.

## Seguimiento después del primer release

Hechos observados al escribir esta sección (k3-06, sobre `8777824`):

- Todavía no hay un primer release local registrado. El servicio de releases existe desde `2720354` y los corredores que lo ejercitan (C21 release completo con prueba de humo, C22 cortes con SIGKILL, C23 métricas) desde `8777824`, pero en la máquina de desarrollo no existen `.paridad/registries/` ni `.paridad/release/`: ninguno de esos corredores se ha ejecutado. Los mini sprints de K3 no ejecutan pruebas; la verificación se hace al cerrar el K.
- En K2 el mismo modo de trabajo dejó defectos que solo aparecieron en el cierre: los commits `9ccf72d` (determinismo, límites de tasa y contrato del CLI) y `962b011` (`argv` de C16) llegaron después de los corredores.
- La dependencia del release con `compat/` está construida: la versión es `0.1.0` en el primer trabajo y después la del último trabajo terminado más el salto de `compat/` (máximo entre contrato y SDKs).

Lo que queda abierto hasta que se corra el primer release y la batería completa:

- Si dos construcciones de la misma copia dan los mismos bytes (lo necesita C22 para comparar sha256): hipótesis sin medir.
- Si el zip de módulo Go se instala con `go` desde el GOPROXY por archivos: lo mide C21.
- La coincidencia de `paridad contract-check` con `oasdiff breaking --fail-on ERR` sobre el corpus: la miden C18 y C25.
- Si `make battery` cabe bajo 8 GiB (C29), si cabe en el límite anti-cuelgue de `make verify`, y la relación de líneas de producto y apoyo (C30): sin medir.
- Si un clon nuevo pasa `make check` antes y después del parche de C26, y si la CI devuelve el 77 de C12 sin Guile en GNU Make.
- C12 sigue omitido mientras `sudo -n true` falle en la máquina de desarrollo.
- `project.repository` y `project.go_module` usan el valor inicial `github.com/CesarManzoCode/paridad`; si el repositorio público cambia de dueño o nombre, cambian esos dos campos y se regenera (sección 13).

Esta sección se actualiza con lo observado cuando esas corridas existan.
