# paridad

Cadena open source que toma la especificación OpenAPI pública de Resend, fijada a un commit, la convierte en una sola representación intermedia y de ella genera SDKs en TypeScript, Python y Go, un CLI, un servidor MCP, una skill para agentes y la documentación. Incluye una herramienta para saber si un cambio de contrato es seguro de publicar y un servicio local de releases con cola persistente, métricas y recuperación ante caídas.

Lo que paridad quiere demostrar se mide con herramientas externas, no con opiniones: que las cinco superficies (SDK TS, SDK Python, SDK Go, CLI y MCP) emiten las mismas peticiones entre sí y las mismas que los SDKs oficiales de Resend, y que autenticación, errores, reintentos, idempotencia, límites de tasa, paginación y fallos parciales se comportan igual en todas. Todo corre en una máquina Linux de 16 GB, sin servicios de pago, sin cuenta de Resend y sin enviar nunca una petición a la API real.

- Qué debe hacer el sistema y las decisiones cerradas: [`vault/CONTRACT.md`](vault/CONTRACT.md)
- Fuentes y versiones verificadas: [`vault/RESEARCH.md`](vault/RESEARCH.md)
- Lo que paridad no demuestra: [`LIMITATIONS.md`](LIMITATIONS.md)
- Historial de cambios y decisiones: [`CHANGELOG.md`](CHANGELOG.md)
- Registro de decisiones (problema, alternativas, solución y seguimiento): [`vault/DECISION-LOG.md`](vault/DECISION-LOG.md)
- Cómo contribuir: [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Estado

| Fase | Contenido | Estado |
| --- | --- | --- |
| K0 | Fundación: contrato, investigación, interfaz de verificación | hecho |
| K1 | Spec fijada, representación intermedia y SDKs TS, Python y Go contra los SDKs oficiales (C1, C3, C4) | Cerrada |
| K2 | Proxy de fallos, CLI, MCP, skill y documentación; comportamiento idéntico en las cinco superficies (C2, C5 a C17, C24) | Cerrada |
| K3 | Compatibilidad de contrato y de SDKs, servicio de releases, operación y open source (C18 a C23, C25 a C30) | Cerrada |

## Criterios

Cada criterio de aceptación se reproduce desde la raíz del repositorio, después de `make bootstrap`. Cuándo pasa cada uno está en la sección 9 del contrato; los artefactos crudos quedan en `.paridad/runs/cN/`. `make battery` corre C1 a C26 en orden y escribe `.paridad/runs/battery.json`.

| Criterio | Qué mide | Comando |
| --- | --- | --- |
| C1 | `make generate` es determinista | `make verify C=c1` |
| C2 | cada operación en las cinco superficies y en `docs/` | `make verify C=c2` |
| C3 | mismas peticiones que los SDKs oficiales | `make verify C=c3` |
| C4 | tipos estrictos y pruebas de los tres SDKs | `make verify C=c4` |
| C5 | mismas peticiones entre las cinco superficies | `make verify C=c5` |
| C6 | mismos errores en las cinco superficies | `make verify C=c6` |
| C7 | la clave no aparece en ninguna salida | `make verify C=c7` |
| C8 | peticiones válidas según la spec (`prism proxy --errors`) | `make verify C=c8` |
| C9 | esperas ante 429 según `retry-after` | `make verify C=c9` |
| C10 | idempotencia en reintentos y claves inválidas | `make verify C=c10` |
| C11 | fallos parciales en espacio de usuario | `make verify C=c11` |
| C12 | fallos de red con `tc netem` (77 sin `sudo`) | `make verify C=c12` |
| C13 | conformidad MCP en Streamable HTTP y stdio | `make verify C=c13` |
| C14 | herramientas MCP ↔ operaciones e `inputSchema` | `make verify C=c14` |
| C15 | comandos de la skill y `agentskills validate` | `make verify C=c15` |
| C16 | contrato JSON y de salida del CLI | `make verify C=c16` |
| C17 | ejemplos de la documentación, `vnu` y enlaces | `make verify C=c17` |
| C18 | clasificación de compatibilidad contra `oasdiff` | `make verify C=c18` |
| C19 | salto semver contra `oasdiff`, api-extractor, griffe y apidiff | `make verify C=c19` |
| C20 | proyectos de ejemplo de N contra N+1 | `make verify C=c20` |
| C21 | release a los tres registros locales y prueba de humo | `make verify C=c21` |
| C22 | recuperación tras SIGKILL en cada punto de corte | `make verify C=c22` |
| C23 | métricas de Prometheus contra la tabla `jobs` | `make verify C=c23` |
| C24 | HTML de React Email igual al de `render` | `make verify C=c24` |
| C25 | `paridad contract-check` contra `oasdiff breaking` | `make verify C=c25` |
| C26 | un clon nuevo pasa `make check` antes y después de agregar una operación | `make verify C=c26` |
| C27 | archivos para contribuidores y CI con `make check` | `make verify C=c27` |
| C28 | registro de decisiones con sus cuatro secciones | revisión humana de [`vault/DECISION-LOG.md`](vault/DECISION-LOG.md) |
| C29 | memoria pico de `make battery` bajo 8 GiB | `make verify C=c29` |
| C30 | líneas de producto mayores que las de apoyo (`scc`) | `make verify C=c30` |

## Resultados

Medidos en el cierre de K3, en la máquina de desarrollo:

| Medida | Resultado |
| --- | --- |
| Batería completa (`make battery`) | C1 a C26 salen 0, salvo C12, que sale 77 (omitido: `sudo -n true` falla en esta máquina) |
| C18, compatibilidad de contrato | 0 desacuerdos con `oasdiff breaking --fail-on ERR` en 117 pares: 91 históricos y 26 sintéticos |
| C19, semver de los SDKs | ningún salto propuesto menor que el que exigen `oasdiff`, api-extractor, `griffe` y `apidiff` en 58 pares: 32 históricos y 26 sintéticos |
| C20, actualización | 25 pares sin salto mayor: los proyectos de ejemplo de TypeScript, Python y Go pasan sin cambios contra N+1 |
| C21, release | la versión 0.1.0 está en Verdaccio, pypiserver y el GOPROXY por archivos; las pruebas de humo de npm, Python y Go pasan |
| C22, recuperación tras SIGKILL | los 8 puntos de corte convergen al estado de los registros de la corrida de referencia |
| C23, métricas | `promtool check metrics` acepta las métricas, y los contadores cuadran con la tabla `jobs` en 4 trabajos |
| C25, `paridad contract-check` | los 117 pares coinciden con `oasdiff` en código de salida y operaciones afectadas |
| C26, contribución | un clon nuevo pasa `make bootstrap` y `make check`; tras el parche de ejemplo, `topics/check-name` aparece en las cinco superficies y en `docs/` |
| C27, archivos para contribuidores | `LICENSE`, `CONTRIBUTING.md`, plantillas de issue y de PR, y la CI declara `make check` |
| C28, registro de decisiones | las cuatro secciones existen; su calidad requiere juicio humano |
| C29, memoria | `memory.peak` de la batería completa: 4.03 GiB, bajo 8 GiB |
| C30, producto contra apoyo | 22 896 líneas de producto contra 12 347 de apoyo, sin pruebas (`scc`) |
| C15, skill (criterio de K2) | 148 comandos salen 0, ahora con `paridad contract-check` |
| `make check` | sale 0 en 42.0 s: 725 pruebas de Node y 172 de pytest pasan, mypy sin problemas, `go test` ok (resultado en caché de Go) |
| Verificación de los 13 criterios de salida de K3 | 1496.6 s |
| Criterios de K0, K1 y K2 en la rama de K3 | siguen pasando: 11, 8 (145.0 s) y 16 (674.9 s) |

Medidos en el cierre de K2, en la máquina de desarrollo:

| Medida | Resultado |
| --- | --- |
| C1, determinismo | 62 archivos generados idénticos (IR, SDKs, CLI, MCP, skill y docs) en dos `make generate` seguidos |
| C2, cobertura | `faltantes=0`: las 144 operaciones en las capturas de TS, Python, Go, CLI y MCP, y como `data-operation-id` en `docs/` |
| C5, igualdad entre superficies | 144 casos, `distintas=0` entre TS, Python, Go, CLI y MCP |
| C6, errores | los 13 casos de error de la tabla 9.1 dan el mismo resultado en las cinco superficies |
| C7, la clave no se filtra | 0 apariciones de la clave de prueba en 10 809 salidas |
| C8, peticiones válidas según la spec | 720 peticiones reenviadas por `prism proxy --errors`, 0 violaciones |
| C9, límites de tasa | las trazas siguen la política y coinciden en las cinco superficies |
| C10, idempotencia | misma clave y mismo cuerpo en cada reintento; claves inválidas rechazadas antes de enviar |
| C11, fallos parciales | los 10 casos coinciden con la tabla esperada en las cinco superficies |
| C12, fallos de red con `tc netem` | omitido (77): `sudo -n true` falla en esta máquina |
| C13, conformidad MCP | el marco oficial sale 0 en Streamable HTTP y en stdio |
| C14, descubrimiento MCP | 144 herramientas; el `inputSchema` y la spec dan el mismo veredicto en un corpus de 742 ejemplos |
| C15, skill | 147 comandos salen 0, cada comando del CLI aparece en la skill y la skill es válida |
| C16, contrato del CLI | 198 invocaciones siguen el contrato; 27 coinciden con `resend-cli` 2.29.0 |
| C17, documentación | 576 ejemplos producen la petición de su operación; `vnu` sin errores; 0 enlaces internos rotos |
| C24, React Email | 3 plantillas: el `html` que envían el SDK TS y el CLI es igual byte a byte al de `render` |
| `make check` | sale 0 en 42.8 s: 634 pruebas de Node y 172 de pytest pasan, mypy sin problemas, `go test` ok (resultado en caché de Go) |
| Verificación de los 16 criterios de salida de K2 | 725.2 s |
| Criterios de K1 en la rama de K2 | los 8 siguen pasando (155.7 s) |

Medidos en el cierre de K1, en la máquina de desarrollo:

| Medida | Resultado |
| --- | --- |
| Especificación fijada | `resend.yaml` de `resend/resend-openapi@8c6f120b`, igual byte a byte (sha256 de `spec/PIN`) |
| Operaciones en la IR | 144, las de la especificación |
| C1, determinismo | 27 archivos generados idénticos en dos `make generate` seguidos |
| C2 parcial, cobertura de los SDKs | `faltantes=0`: las 144 operaciones en las capturas de los SDKs TS, Python y Go |
| C3, igualdad con los SDKs oficiales | 0 diferencias sin justificar; operaciones comparadas: 139 con `resend-node`, 138 con `resend-python`, 100 con `resend-go`; 204 diferencias justificadas en `verify/divergences.json` |
| C4, tipos y pruebas | `tsc --strict`, `mypy --strict`, `go vet` y las tres suites salen 0 |
| C5 parcial, igualdad entre los SDKs propios | 144 casos, `distintas=0` entre TS, Python y Go |
| `make check` | sale 0 en 36.7 s: 237 pruebas de Node y 172 de pytest pasan, `go test` ok (resultado en caché de Go) |
| Verificación de los 8 criterios de salida de K1 | 145.0 s |

Los límites de estos resultados están en [`LIMITATIONS.md`](LIMITATIONS.md). Cada criterio se reproduce con `make verify C=cN` y la batería completa con `make battery` (ver la sección 8 del contrato).

## Licencia

MIT. Ver [`LICENSE`](LICENSE).
