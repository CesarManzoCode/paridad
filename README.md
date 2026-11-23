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
| K1 | Spec fijada, representación intermedia y SDKs TS, Python y Go contra los SDKs oficiales (C1, C3, C4) | pendiente |
| K2 | Proxy de fallos, CLI, MCP, skill y documentación; comportamiento idéntico en las cinco superficies (C2, C5 a C17, C24) | pendiente |
| K3 | Compatibilidad de contrato y de SDKs, servicio de releases, operación y open source (C18 a C23, C25 a C30) | pendiente |

## Resultados

Todavía no hay resultados: el producto empieza en K1. Cada criterio se podrá reproducir con `make verify C=cN` y la batería completa con `make battery` (ver la sección 8 del contrato).

## Licencia

MIT. Ver [`LICENSE`](LICENSE).
