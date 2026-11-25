# paridad

Cadena open source que toma la especificación OpenAPI pública de Resend, fijada a un commit, la convierte en una sola representación intermedia y de ella genera SDKs en TypeScript, Python y Go, un CLI, un servidor MCP, una skill para agentes y la documentación. Incluye una herramienta para saber si un cambio de contrato es seguro de publicar y un servicio local de releases con cola persistente, métricas y recuperación ante caídas.

Lo que paridad quiere demostrar se mide con herramientas externas, no con opiniones: que las cinco superficies (SDK TS, SDK Python, SDK Go, CLI y MCP) emiten las mismas peticiones entre sí y las mismas que los SDKs oficiales de Resend, y que autenticación, errores, reintentos, idempotencia, límites de tasa, paginación y fallos parciales se comportan igual en todas. Todo corre en una máquina Linux de 16 GB, sin servicios de pago, sin cuenta de Resend y sin enviar nunca una petición a la API real.

- Qué debe hacer el sistema y las decisiones cerradas: [`vault/CONTRACT.md`](vault/CONTRACT.md)
- Fuentes y versiones verificadas: [`vault/RESEARCH.md`](vault/RESEARCH.md)
- Lo que paridad no demuestra: [`LIMITATIONS.md`](LIMITATIONS.md)
- Historial de cambios y decisiones: [`CHANGELOG.md`](CHANGELOG.md)

## Estado

| Fase | Contenido | Estado |
| --- | --- | --- |
| K0 | Fundación: contrato, investigación, interfaz de verificación | hecho |
| K1 | Spec fijada, representación intermedia y SDKs TS, Python y Go contra los SDKs oficiales (C1, C3, C4) | Cerrada |
| K2 | Proxy de fallos, CLI, MCP, skill y documentación; comportamiento idéntico en las cinco superficies (C2, C5 a C17, C24) | Cerrada |
| K3 | Compatibilidad de contrato y de SDKs, servicio de releases, operación y open source (C18 a C23, C25 a C30) | pendiente |

## Resultados

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
