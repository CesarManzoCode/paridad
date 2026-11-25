## Qué cambia

<!-- Resumen en términos del producto. -->

## Por qué

<!-- Issue, sección del contrato o criterio relacionado. -->

## Cómo se comprobó

<!-- Comandos que corriste y su resultado tal cual salió. -->

- [ ] `make check` sale 0
- [ ] Criterios afectados (`make verify C=cN`):

## Lista

- [ ] No edité a mano código generado (`ir/ir.json`, `sdks/`, `cli/`, `mcp/`, `skill/`, `docs/`); cambié `generator/`, sus plantillas o `ir/overlay.yaml` y corrí `make generate`.
- [ ] La salida regenerada está en el mismo commit que su fuente.
- [ ] Si cambió el comportamiento visible, actualicé `CHANGELOG.md`.
- [ ] Si encontré un límite nuevo, lo registré en `LIMITATIONS.md`.
- [ ] Ninguna prueba usa una clave real ni la API real de Resend.
