# Escenarios del proxy de fallos

Un archivo JSON por corrida, que lee `harness/faults/proxy.ts --scenarios <archivo>`:

```json
{
  "cases": {
    "timeout-get": [{ "action": "delay", "delay_ms": 2000 }, { "action": "pass" }],
    "cut-post-key": [{ "action": "cut" }],
    "error-404-not_found": [
      { "action": "respond", "status": 404, "body": { "statusCode": 404, "name": "not_found", "message": "…" } }
    ]
  }
}
```

- La clave es el id de caso; la lista da la acción del intento n en la posición n − 1. Un intento sin acción en la lista, o de un caso sin escenario, es `pass`. El mismo escenario vale para todas las superficies.
- Los intentos se cuentan por (caso, superficie) desde el último `POST /__paridad/session` de ese par en el puerto de control del proxy. El corredor fija la sesión en el proxy y en el servidor de captura.
- Acciones:
  - `pass`: reenvía y devuelve la respuesta del servidor de captura.
  - `respond`: responde `status`, `headers` (objeto opcional de cadenas) y `body` `{"statusCode","name","message"}` sin reenviar.
  - `delay`: reenvía y retiene la respuesta `delay_ms` milisegundos.
  - `cut`: reenvía, envía el estado, las cabeceras con el `content-length` completo y la primera mitad del cuerpo, y destruye el socket.
- El 429 de tasa se construye con `rateLimitResponse({ limit, retryAfter })` de `harness/faults/proxy.ts`: cabeceras `ratelimit-limit`, `ratelimit-remaining: 0`, `ratelimit-reset` y `retry-after` (por defecto 1) y `name` `rate_limit_exceeded`.
- Cada intento escribe una línea en `traces.jsonl` (sección 8 del contrato); `t_recv_ns` y `t_resp_end_ns` son `process.hrtime.bigint()` escritos como números JSON enteros.
