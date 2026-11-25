---
name: Reporte de error
about: Algo de paridad no se comporta como dice el contrato
title: ""
labels: bug
---

## Qué pasó

<!-- Lo que observaste, sin interpretar. -->

## Qué esperabas

<!-- Lo que dice vault/CONTRACT.md (sección o criterio), o lo que hace el SDK oficial de Resend. -->

## Cómo reproducirlo

```bash
# Comandos exactos desde la raíz del repositorio, por ejemplo:
make bootstrap
make verify C=c5 SURFACES=ts,python
```

## Salida

<!-- Salida completa del comando. Si viene de un criterio, adjunta los archivos de .paridad/runs/cN/ que lo muestran. Nunca pegues una clave real de Resend. -->

## Superficie

- [ ] SDK TypeScript
- [ ] SDK Python
- [ ] SDK Go
- [ ] CLI
- [ ] MCP
- [ ] Skill
- [ ] Documentación
- [ ] `contract-check` / `compat/`
- [ ] Servicio de releases
- [ ] Arnés de verificación

## Entorno

- Commit de paridad (`git rev-parse HEAD`):
- Sistema operativo:
- Versiones (`node --version`, `pnpm --version`, `python3 --version`, `go version`):
