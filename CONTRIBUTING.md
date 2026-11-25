# Cómo contribuir

Gracias por querer mejorar paridad. Este documento explica cómo preparar el entorno, cómo cambiar lo que se genera y cómo comprobar un cambio antes de abrir un pull request. Lo que el sistema debe hacer está en [`vault/CONTRACT.md`](vault/CONTRACT.md); si un cambio contradice el contrato, el pull request tiene que decirlo y cambiar también el contrato.

## Requisitos

Las versiones son las de la sección D33 del contrato y de [`vault/RESEARCH.md`](vault/RESEARCH.md):

- Node 26 y pnpm 11.25.0
- Python 3.14
- Go 1.27
- GNU Make y git

Todo corre en local, sin cuenta de Resend. Nunca uses una clave real ni apuntes las pruebas a `https://api.resend.com`: la batería usa la clave de prueba `re_paridad_test_9f8e7d6c5b4a39281706` contra servidores locales.

## Preparar el entorno

Desde la raíz del repositorio:

```bash
make bootstrap
```

Instala el workspace pnpm con `pnpm install --frozen-lockfile`, crea `.venv` con `requirements-dev.txt` y descarga las herramientas Go fijadas en `tools/go.mod` (`oasdiff`, `apidiff`, `scc`). Si cambias una dependencia, fija la versión exacta y anótala en `vault/RESEARCH.md`.

## Regenerar

```bash
make generate
```

Reescribe por completo `ir/ir.json`, `sdks/`, `cli/`, `mcp/`, `skill/` y `docs/` a partir de `spec/resend.yaml` e `ir/overlay.yaml`. Dos corridas seguidas dan los mismos bytes (C1), así que después de regenerar `git status` solo debe mostrar lo que tu cambio explica.

## No se edita código generado

`ir/ir.json`, `sdks/`, `cli/`, `mcp/`, `skill/` y `docs/` salen del generador y no se editan a mano: `make generate` borra cualquier edición. Para cambiarlos:

- Comportamiento o forma del código: `generator/` y sus plantillas en `generator/templates/`.
- Lo que la especificación no dice (nombres idiomáticos que la regla haría feos, operaciones destructivas que no son DELETE, ejemplos, política de reintentos, catálogo de errores): `ir/overlay.yaml`.
- La especificación: `spec/resend.yaml` es copia byte a byte del commit fijado en `spec/PIN`. Un cambio local de la spec actualiza el sha256 de `spec/PIN` y lo marca con una línea `patch:`; `verify/c26/add-operation.patch` es un ejemplo.

Incluye en el mismo commit el cambio de la fuente y la salida regenerada.

## Comprobar un cambio

```bash
make check
```

Es el comando que corre la CI (`.github/workflows/ci.yml`): incluye `bootstrap`, los chequeos de tipos de cada paquete, las pruebas de Node (`node --test`), `mypy --strict` y `pytest` del SDK Python, y `go vet` y `go test` del SDK Go. Las pruebas viven junto al código (`*.test.ts`, `test_*.py`, `*_test.go`).

Para medir un criterio de aceptación concreto:

```bash
make verify C=c5
make verify C=c5 SURFACES=ts,python,go
```

Cada corrida borra y reescribe `.paridad/runs/cN/` con sus artefactos crudos y sale 0 si pasa, 1 si falla y 77 si se omite (por ejemplo C12 sin `sudo`). `make battery` corre C1 a C26 en orden. La tabla del [`README.md`](README.md) dice qué comando reproduce cada criterio, y la sección 9 del contrato dice cuándo pasa.

## Pull requests

- Commits y código en inglés; documentación en español.
- Un cambio, un pull request. Di qué criterios afecta y qué comando corriste, con su resultado tal cual salió.
- No escribas "más rápido" ni "compatible" sin la medición que lo respalde.
- Si encuentras un límite de lo que paridad demuestra, agrégalo a [`LIMITATIONS.md`](LIMITATIONS.md), que es el único lugar donde se registran.
- Los cambios visibles para quien usa los SDKs, el CLI o el MCP van en [`CHANGELOG.md`](CHANGELOG.md).
- No se usan generadores de terceros (Stainless, Speakeasy, openapi-generator) para producir código entregado.

## Reportar un problema

Usa las plantillas de [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). Para un error, incluye el comando, la salida completa y, si viene de un criterio, los archivos de `.paridad/runs/cN/` que lo muestran. Nunca pegues una clave real.

## Licencia

Al contribuir aceptas que tu aporte se publique con la licencia MIT del proyecto ([`LICENSE`](LICENSE)).
