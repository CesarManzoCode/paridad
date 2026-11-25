---
name: paridad-resend
description: "Envía emails y administra recursos de Resend (dominios, contactos, difusiones, plantillas, webhooks y el resto de la API de Resend) desde la terminal con el CLI paridad. Úsala cuando una tarea necesite llamar a la API de Resend o comparar dos versiones de su contrato OpenAPI."
---

# paridad-resend

El CLI `paridad` llama a la API de Resend: un comando por operación de la especificación OpenAPI fijada (3.1.2, versión 1.5.1), con la forma `paridad <recurso> <acción>` derivada de su operationId. Lo genera paridad desde `ir/ir.json`; no se edita a mano.

## Configuración

El CLI lee su configuración del entorno; nada va en los argumentos.

| Variable | Qué es | Por defecto |
| --- | --- | --- |
| `RESEND_API_KEY` | Clave de la API, enviada como `Authorization: Bearer` | ninguna: sin ella todo comando falla con `missing_api_key` |
| `RESEND_BASE_URL` | URL base de la API | `https://api.resend.com` |
| `RESEND_TIMEOUT_MS` | Tiempo máximo de cada intento en milisegundos (`--timeout-ms` lo reemplaza) | `30000` |
| `PARIDAD_DEBUG` | `1` escribe en stderr una línea por intento | sin definir |

La clave nunca aparece en la salida. La configuración efectiva, con la clave enmascarada como `re_...` y sus 4 últimos caracteres:

```bash
paridad config show
```

## Salida y códigos de salida

- Si stdout no es una terminal, si `CI` está definida o con `--json`, stdout es JSON: el cuerpo de la respuesta en caso de éxito.
- En caso de error stdout es `{"error":{"message":…,"code":…,"statusCode":…}}`; `code` es el `name` del error de la API (`validation_error`, `not_found`, `rate_limit_exceeded`…), `timeout` o `connection_error`, y `statusCode` es null cuando no llegó respuesta.
- Sale con 0 en éxito y con 1 ante cualquier error. Para saber qué falló, lee el JSON, no solo el código.
- `paridad <recurso> <acción> --help` lista las banderas de un comando.

## Argumentos

- Los parámetros de ruta y de query son banderas con el nombre del parámetro en kebab case.
- Las propiedades del cuerpo también son banderas; los valores que son objetos o listas van en JSON. `--body` recibe el cuerpo completo en JSON y las banderas de propiedades reemplazan sus propiedades de primer nivel.
- `emails send` acepta además `--react` (archivo .tsx) y `--react-props` (JSON) para renderizar una plantilla de React Email en `html`.

## Reintentos e idempotencia

Cada comando hace hasta 3 intentos. Un 429 por límite de tasa se reintenta siempre, esperando `retry-after`. Los errores de servidor (500, 502, 503, 504), los timeouts y las conexiones cortadas se reintentan solo en GET, PUT y DELETE, o si la petición lleva clave de idempotencia. Un POST o PATCH sin clave nunca se repite tras un fallo ambiguo, porque el primer intento pudo haber tenido efecto.

Los comandos de las operaciones que declaran `Idempotency-Key` aceptan `--idempotency-key` (de 1 a 256 caracteres); cada intento envía la misma clave y el mismo cuerpo, así que repetir el comando con la misma clave no envía el email dos veces. El CLI nunca inventa una clave: pasa una siempre que una escritura pueda repetirse.

```bash
paridad emails send --from 'Acme <onboarding@resend.dev>' --to '["delivered@resend.dev"]' --subject 'Hello World' --html '<p>It works!</p>' --idempotency-key welcome-user-42
```

## Paginación

Los comandos de listado devuelven una página: `{"object":"list","has_more":…,"data":[…]}`. `--limit`, `--after` y `--before` eligen la página; `--all` junta todos los elementos de todas las páginas en un solo arreglo `data` (el CLI sigue `after` mientras `has_more` sea verdadero).

```bash
paridad api-keys list --all
```

## Chequeo de contrato

`paridad contract-check` compara dos versiones de la especificación OpenAPI (base y revisión, con `--json` opcional): lista los cambios que rompen, las operaciones y superficies afectadas y el salto semver propuesto, y sale con 0 si la revisión es compatible y con 1 si rompe. Desde la raíz del repositorio, comparando la especificación fijada consigo misma:

```bash
paridad contract-check spec/resend.yaml spec/resend.yaml
```

## Comandos

Una sección por recurso. Cada comando lleva valores de ejemplo que la API acepta.

## api-keys

### paridad api-keys create

Create a new API key

operationId: `api-keys/create` — `POST /api-keys` Banderas: `--body`, `--name (obligatoria)`, `--permission`, `--domain-id`.

```bash
paridad api-keys create --name example
```

### paridad api-keys list

Retrieve a list of API keys

operationId: `api-keys/list` — `GET /api-keys` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad api-keys list
```

### paridad api-keys remove

Remove an existing API key

operationId: `api-keys/remove` — `DELETE /api-keys/{api_key_id}` Destructiva: borra o cancela. Banderas: `--api-key-id (obligatoria)`.

```bash
paridad api-keys remove --api-key-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad api-keys update

Update an existing API key

operationId: `api-keys/update` — `PATCH /api-keys/{api_key_id}` Banderas: `--body`, `--api-key-id (obligatoria)`, `--name (obligatoria)`.

```bash
paridad api-keys update --api-key-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --name example
```

## audiences

### paridad audiences create

Create a list of contacts

operationId: `audiences/create` — `POST /audiences` Banderas: `--body`, `--name (obligatoria)`.

```bash
paridad audiences create --name example
```

### paridad audiences get

Retrieve a single audience

operationId: `audiences/get` — `GET /audiences/{id}` Banderas: `--id (obligatoria)`.

```bash
paridad audiences get --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad audiences list

Retrieve a list of audiences

operationId: `audiences/list` — `GET /audiences`

```bash
paridad audiences list
```

### paridad audiences remove

Remove an existing audience

operationId: `audiences/remove` — `DELETE /audiences/{id}` Destructiva: borra o cancela. Banderas: `--id (obligatoria)`.

```bash
paridad audiences remove --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

## automations

### paridad automations cancel-run

Cancel an automation run

operationId: `automations/cancel-run` — `POST /automations/{automation_id}/runs/{run_id}/cancel` Destructiva: borra o cancela. Banderas: `--automation-id (obligatoria)`, `--run-id (obligatoria)`.

```bash
paridad automations cancel-run --automation-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --run-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad automations create

Create an automation

operationId: `automations/create` — `POST /automations` Banderas: `--body`, `--name (obligatoria)`, `--status`, `--steps (obligatoria)`, `--connections (obligatoria)`.

```bash
paridad automations create --name example --steps '[{"key":"example","type":"trigger","config":{}}]' --connections '[{"from":"example","to":"example"}]'
```

### paridad automations duplicate

Duplicate an automation

operationId: `automations/duplicate` — `POST /automations/{automation_id}/duplicate` Banderas: `--automation-id (obligatoria)`.

```bash
paridad automations duplicate --automation-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad automations get

Retrieve a single automation

operationId: `automations/get` — `GET /automations/{automation_id}` Banderas: `--automation-id (obligatoria)`.

```bash
paridad automations get --automation-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad automations get-run

Retrieve a single automation run

operationId: `automations/get-run` — `GET /automations/{automation_id}/runs/{run_id}` Banderas: `--automation-id (obligatoria)`, `--run-id (obligatoria)`.

```bash
paridad automations get-run --automation-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --run-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad automations list

Retrieve a list of automations

operationId: `automations/list` — `GET /automations` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--status`, `--limit`, `--after`, `--before`.

```bash
paridad automations list
```

### paridad automations list-runs

Retrieve a list of automation runs

operationId: `automations/list-runs` — `GET /automations/{automation_id}/runs` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--automation-id (obligatoria)`, `--status`, `--limit`, `--after`, `--before`.

```bash
paridad automations list-runs --automation-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad automations remove

Delete an automation

operationId: `automations/remove` — `DELETE /automations/{automation_id}` Destructiva: borra o cancela. Banderas: `--automation-id (obligatoria)`.

```bash
paridad automations remove --automation-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad automations stop

Stop an automation

operationId: `automations/stop` — `POST /automations/{automation_id}/stop` Destructiva: borra o cancela. Banderas: `--automation-id (obligatoria)`.

```bash
paridad automations stop --automation-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad automations update

Update an automation

operationId: `automations/update` — `PATCH /automations/{automation_id}` Banderas: `--body`, `--automation-id (obligatoria)`, `--name`, `--status`, `--steps`, `--connections`.

```bash
paridad automations update --automation-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --name example
```

## broadcasts

### paridad broadcasts cancel

Cancel a broadcast

operationId: `broadcasts/cancel` — `POST /broadcasts/{id}/cancel` Destructiva: borra o cancela. Banderas: `--id (obligatoria)`.

```bash
paridad broadcasts cancel --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad broadcasts create

Create a broadcast

operationId: `broadcasts/create` — `POST /broadcasts` Banderas: `--body`, `--name`, `--segment-id (obligatoria)`, `--audience-id`, `--from (obligatoria)`, `--subject (obligatoria)`, `--reply-to`, `--preview-text`, `--html`, `--text`, `--topic-id`, `--send`, `--scheduled-at`.

```bash
paridad broadcasts create --from 'Acme <onboarding@resend.dev>' --segment-id 78261eea-8f8b-4381-83c6-79fa7120f1cf --subject 'Hello World' --html '<p>Hello World</p>'
```

### paridad broadcasts duplicate

Duplicate a broadcast

operationId: `broadcasts/duplicate` — `POST /broadcasts/{id}/duplicate` Banderas: `--id (obligatoria)`.

```bash
paridad broadcasts duplicate --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad broadcasts get

Retrieve a single broadcast

operationId: `broadcasts/get` — `GET /broadcasts/{id}` Banderas: `--id (obligatoria)`.

```bash
paridad broadcasts get --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad broadcasts list

Retrieve a list of broadcasts

operationId: `broadcasts/list` — `GET /broadcasts` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad broadcasts list
```

### paridad broadcasts list-clicked-links

Retrieve a broadcast's clicked links

operationId: `broadcasts/list-clicked-links` — `GET /broadcasts/{id}/clicked-links` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--id (obligatoria)`, `--limit`, `--after`, `--before`.

```bash
paridad broadcasts list-clicked-links --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad broadcasts recipients

Retrieve broadcast recipients

operationId: `broadcasts/recipients` — `GET /broadcasts/{id}/recipients` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--id (obligatoria)`, `--type (obligatoria)`, `--email`, `--bounce-type`, `--limit`, `--after`, `--before`.

```bash
paridad broadcasts recipients --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --type sent
```

### paridad broadcasts remove

Remove an existing broadcast that is in the draft status

operationId: `broadcasts/remove` — `DELETE /broadcasts/{id}` Destructiva: borra o cancela. Banderas: `--id (obligatoria)`.

```bash
paridad broadcasts remove --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad broadcasts send

Send or schedule a broadcast

operationId: `broadcasts/send` — `POST /broadcasts/{id}/send` Banderas: `--body`, `--id (obligatoria)`, `--scheduled-at`.

```bash
paridad broadcasts send --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --scheduled-at 'in 1 min'
```

### paridad broadcasts update

Update an existing broadcast

operationId: `broadcasts/update` — `PATCH /broadcasts/{id}` Banderas: `--body`, `--id (obligatoria)`, `--name`, `--audience-id`, `--segment-id`, `--from`, `--subject`, `--reply-to`, `--preview-text`, `--html`, `--text`, `--topic-id`.

```bash
paridad broadcasts update --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --name example
```

## contact-properties

### paridad contact-properties create

Create a new contact property

operationId: `contact-properties/create` — `POST /contact-properties` Banderas: `--body`, `--key (obligatoria)`, `--type (obligatoria)`, `--fallback-value`.

```bash
paridad contact-properties create --key example --type string
```

### paridad contact-properties get

Retrieve a single contact property

operationId: `contact-properties/get` — `GET /contact-properties/{id}` Banderas: `--id (obligatoria)`.

```bash
paridad contact-properties get --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad contact-properties list

Retrieve a list of contact properties

operationId: `contact-properties/list` — `GET /contact-properties` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad contact-properties list
```

### paridad contact-properties remove

Remove an existing contact property

operationId: `contact-properties/remove` — `DELETE /contact-properties/{id}` Destructiva: borra o cancela. Banderas: `--id (obligatoria)`.

```bash
paridad contact-properties remove --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad contact-properties update

Update an existing contact property

operationId: `contact-properties/update` — `PATCH /contact-properties/{id}` Banderas: `--body`, `--id (obligatoria)`, `--fallback-value`.

```bash
paridad contact-properties update --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --fallback-value example
```

## contacts

### paridad contacts add-segment

Add a contact to a segment

operationId: `contacts/add-segment` — `POST /contacts/{contact_id}/segments/{segment_id}` Banderas: `--contact-id (obligatoria)`, `--segment-id (obligatoria)`.

```bash
paridad contacts add-segment --contact-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --segment-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad contacts create

Create a new contact

operationId: `contacts/create` — `POST /contacts` Banderas: `--body`, `--email (obligatoria)`, `--first-name`, `--last-name`, `--unsubscribed`, `--properties`, `--segments`, `--topics`, `--audience-id`.

```bash
paridad contacts create --email steve.wozniak@gmail.com
```

### paridad contacts create-import

Create a contact import

operationId: `contacts/create-import` — `POST /contacts/imports` Banderas: `--body`, `--file (obligatoria)`, `--column-map`, `--on-conflict`, `--segments`, `--topics`.

```bash
paridad contacts create-import --body '{"file":"example"}'
```

### paridad contacts get

Retrieve a single contact by ID or email

operationId: `contacts/get` — `GET /contacts/{id}` Banderas: `--id (obligatoria)`.

```bash
paridad contacts get --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad contacts get-import

Retrieve a single contact import

operationId: `contacts/get-import` — `GET /contacts/imports/{id}` Banderas: `--id (obligatoria)`.

```bash
paridad contacts get-import --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad contacts list

Retrieve a list of contacts

operationId: `contacts/list` — `GET /contacts` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad contacts list
```

### paridad contacts list-imports

Retrieve a list of contact imports

operationId: `contacts/list-imports` — `GET /contacts/imports` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--status`, `--limit`, `--after`, `--before`.

```bash
paridad contacts list-imports
```

### paridad contacts list-segments

Retrieve a list of segments for a contact

operationId: `contacts/list-segments` — `GET /contacts/{contact_id}/segments` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--contact-id (obligatoria)`, `--limit`, `--after`, `--before`.

```bash
paridad contacts list-segments --contact-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad contacts list-topics

Retrieve topics for a contact

operationId: `contacts/list-topics` — `GET /contacts/{contact_id}/topics` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--contact-id (obligatoria)`, `--limit`, `--after`, `--before`.

```bash
paridad contacts list-topics --contact-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad contacts remove

Remove an existing contact by ID or email

operationId: `contacts/remove` — `DELETE /contacts/{id}` Destructiva: borra o cancela. Banderas: `--id (obligatoria)`.

```bash
paridad contacts remove --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad contacts remove-segment

Remove a contact from a segment

operationId: `contacts/remove-segment` — `DELETE /contacts/{contact_id}/segments/{segment_id}` Destructiva: borra o cancela. Banderas: `--contact-id (obligatoria)`, `--segment-id (obligatoria)`.

```bash
paridad contacts remove-segment --contact-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --segment-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad contacts update

Update a single contact by ID or email

operationId: `contacts/update` — `PATCH /contacts/{id}` Banderas: `--body`, `--id (obligatoria)`, `--email`, `--first-name`, `--last-name`, `--unsubscribed`, `--properties`.

```bash
paridad contacts update --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --email steve.wozniak@gmail.com
```

### paridad contacts update-topics

Update topics for a contact

operationId: `contacts/update-topics` — `PATCH /contacts/{contact_id}/topics` Banderas: `--body`, `--contact-id (obligatoria)`, `--topics (obligatoria)`.

```bash
paridad contacts update-topics --contact-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --topics '[{"id":"b6d24b8e-af0b-4c3c-be0c-359bbd97381e","subscription":"opt_in"}]'
```

## domains

### paridad domains create

Create a new domain

operationId: `domains/create` — `POST /domains` Banderas: `--body`, `--name (obligatoria)`, `--region`, `--custom-return-path`, `--open-tracking`, `--click-tracking`, `--tls`, `--capabilities`, `--tracking-subdomain`.

```bash
paridad domains create --name example.com
```

### paridad domains create-claim

Claim a domain

operationId: `domains/create-claim` — `POST /domains/claim` Banderas: `--body`, `--name (obligatoria)`, `--region`, `--custom-return-path`, `--open-tracking`, `--click-tracking`, `--tracking-subdomain`.

```bash
paridad domains create-claim --name example.com
```

### paridad domains enable-forge

Enable Forge for a domain

operationId: `domains/enable-forge` — `POST /domains/{domain_id}/forge` Banderas: `--body`, `--domain-id (obligatoria)`, `--custom-return-path`.

```bash
paridad domains enable-forge --domain-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --custom-return-path example
```

### paridad domains get

Retrieve a single domain

operationId: `domains/get` — `GET /domains/{domain_id}` Banderas: `--domain-id (obligatoria)`.

```bash
paridad domains get --domain-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad domains get-claim

Retrieve a domain claim

operationId: `domains/get-claim` — `GET /domains/{domain_id}/claim` Banderas: `--domain-id (obligatoria)`.

```bash
paridad domains get-claim --domain-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad domains list

Retrieve a list of domains

operationId: `domains/list` — `GET /domains` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad domains list
```

### paridad domains remove

Remove an existing domain

operationId: `domains/remove` — `DELETE /domains/{domain_id}` Destructiva: borra o cancela. Banderas: `--domain-id (obligatoria)`.

```bash
paridad domains remove --domain-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad domains update

Update an existing domain

operationId: `domains/update` — `PATCH /domains/{domain_id}` Banderas: `--body`, `--domain-id (obligatoria)`, `--open-tracking`, `--click-tracking`, `--tls`, `--capabilities`, `--tracking-subdomain`.

```bash
paridad domains update --domain-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --open-tracking true
```

### paridad domains verify

Verify an existing domain

operationId: `domains/verify` — `POST /domains/{domain_id}/verify` Banderas: `--body`, `--domain-id (obligatoria)`, `--scope`.

```bash
paridad domains verify --domain-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --scope '["forge"]'
```

### paridad domains verify-claim

Verify a domain claim

operationId: `domains/verify-claim` — `POST /domains/{domain_id}/claim/verify` Banderas: `--domain-id (obligatoria)`.

```bash
paridad domains verify-claim --domain-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

## emails

### paridad emails cancel

Cancel the schedule of the e-mail.

operationId: `emails/cancel` — `POST /emails/{email_id}/cancel` Destructiva: borra o cancela. Banderas: `--email-id (obligatoria)`.

```bash
paridad emails cancel --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad emails get

Retrieve a single email

operationId: `emails/get` — `GET /emails/{email_id}` Banderas: `--email-id (obligatoria)`.

```bash
paridad emails get --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad emails get-attachment

Retrieve a single attachment for a sent email

operationId: `emails/get-attachment` — `GET /emails/{email_id}/attachments/{attachment_id}` Banderas: `--email-id (obligatoria)`, `--attachment-id (obligatoria)`.

```bash
paridad emails get-attachment --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --attachment-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad emails get-receiving

Retrieve a single received email

operationId: `emails/get-receiving` — `GET /emails/receiving/{email_id}` Banderas: `--email-id (obligatoria)`.

```bash
paridad emails get-receiving --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad emails get-receiving-attachment

Retrieve a single attachment for a received email

operationId: `emails/get-receiving-attachment` — `GET /emails/receiving/{email_id}/attachments/{attachment_id}` Banderas: `--email-id (obligatoria)`, `--attachment-id (obligatoria)`.

```bash
paridad emails get-receiving-attachment --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --attachment-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad emails list

Retrieve a list of emails

operationId: `emails/list` — `GET /emails` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad emails list
```

### paridad emails list-attachments

Retrieve a list of attachments for a sent email

operationId: `emails/list-attachments` — `GET /emails/{email_id}/attachments` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--email-id (obligatoria)`, `--limit`, `--after`, `--before`.

```bash
paridad emails list-attachments --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad emails list-receiving

Retrieve a list of received emails

operationId: `emails/list-receiving` — `GET /emails/receiving` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad emails list-receiving
```

### paridad emails list-receiving-attachments

Retrieve a list of attachments for a received email

operationId: `emails/list-receiving-attachments` — `GET /emails/receiving/{email_id}/attachments` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--email-id (obligatoria)`, `--limit`, `--after`, `--before`.

```bash
paridad emails list-receiving-attachments --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad emails metrics

Retrieve account-level email metrics

operationId: `emails/metrics` — `GET /emails/metrics` Banderas: `--start-date`, `--end-date`, `--timezone`, `--granularity`, `--metrics`, `--dimensions`, `--domain-id`, `--email-id`, `--broadcast-id`.

```bash
paridad emails metrics
```

### paridad emails send

Send an email

operationId: `emails/send` — `POST /emails` Acepta `--idempotency-key`. Banderas: `--body`, `--from (obligatoria)`, `--to (obligatoria)`, `--subject (obligatoria)`, `--bcc`, `--cc`, `--reply-to`, `--html`, `--text`, `--template`, `--headers`, `--scheduled-at`, `--attachments`, `--tags`, `--topic-id`.

```bash
paridad emails send --from 'Acme <onboarding@resend.dev>' --to '["delivered@resend.dev"]' --subject 'Hello World' --html '<p>It works!</p>'
```

### paridad emails send-batch

Trigger up to 100 batch emails at once.

operationId: `emails/send-batch` — `POST /emails/batch` Acepta `--idempotency-key`. Banderas: `--body`.

```bash
paridad emails send-batch --body '[{"from":"Acme <onboarding@resend.dev>","to":["delivered@resend.dev"],"subject":"Hello World","html":"<p>It works!</p>"},{"from":"Acme <onboarding@resend.dev>","to":["delivered@resend.dev"],"subject":"World Hello","html":"<p>It works too!</p>"}]'
```

### paridad emails share

Create a shareable link for a sent or received email.

operationId: `emails/share` — `POST /emails/{email_id}/share` Banderas: `--body`, `--email-id (obligatoria)`, `--expires-in`.

```bash
paridad emails share --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --expires-in '1 day'
```

### paridad emails update

Update a single email

operationId: `emails/update` — `PATCH /emails/{email_id}` Banderas: `--email-id (obligatoria)`.

```bash
paridad emails update --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

## events

### paridad events create

Create an event

operationId: `events/create` — `POST /events` Banderas: `--body`, `--name (obligatoria)`, `--schema`.

```bash
paridad events create --name example
```

### paridad events get

Retrieve a single event

operationId: `events/get` — `GET /events/{identifier}` Banderas: `--identifier (obligatoria)`.

```bash
paridad events get --identifier 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad events list

Retrieve a list of events

operationId: `events/list` — `GET /events` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad events list
```

### paridad events remove

Delete an event

operationId: `events/remove` — `DELETE /events/{identifier}` Destructiva: borra o cancela. Banderas: `--identifier (obligatoria)`.

```bash
paridad events remove --identifier 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad events send

Send an event

operationId: `events/send` — `POST /events/send` Banderas: `--body`, `--event (obligatoria)`, `--contact-id`, `--email`, `--payload`.

```bash
paridad events send --event example
```

### paridad events update

Update an event

operationId: `events/update` — `PATCH /events/{identifier}` Banderas: `--body`, `--identifier (obligatoria)`, `--schema (obligatoria)`.

```bash
paridad events update --identifier 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --schema '{}'
```

## inboxes

### paridad inboxes add-thread-labels

Add labels to an inbox thread

operationId: `inboxes/add-thread-labels` — `POST /inboxes/{inbox_id}/threads/{thread_id}/labels` Banderas: `--body`, `--inbox-id (obligatoria)`, `--thread-id (obligatoria)`, `--labels (obligatoria)`.

```bash
paridad inboxes add-thread-labels --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --thread-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --labels '["7f9c1d2e-4a6b-4c3d-8e15-9b0a7c6d5e34"]'
```

### paridad inboxes create

Create an inbox

operationId: `inboxes/create` — `POST /inboxes` Banderas: `--body`, `--email-address (obligatoria)`, `--name`, `--from-name`, `--forwarding`.

```bash
paridad inboxes create --email-address support@acme.com
```

### paridad inboxes create-draft

Create a draft

operationId: `inboxes/create-draft` — `POST /inboxes/{inbox_id}/drafts` Acepta `--idempotency-key`. Banderas: `--body`, `--inbox-id (obligatoria)`, `--to`, `--cc`, `--bcc`, `--subject`, `--html`, `--text`, `--attachments`, `--thread-id`, `--reply-to-email-id`.

```bash
paridad inboxes create-draft --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --to '["ada@example.org"]'
```

### paridad inboxes create-label

Create a label on an inbox

operationId: `inboxes/create-label` — `POST /inboxes/{inbox_id}/labels` Banderas: `--body`, `--inbox-id (obligatoria)`, `--name (obligatoria)`, `--color`.

```bash
paridad inboxes create-label --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --name Urgent
```

### paridad inboxes forward-thread-email

Forward a thread email

operationId: `inboxes/forward-thread-email` — `POST /inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}/forward` Acepta `--idempotency-key`. Banderas: `--body`, `--inbox-id (obligatoria)`, `--thread-id (obligatoria)`, `--email-id (obligatoria)`, `--to (obligatoria)`, `--cc`, `--bcc`, `--html`, `--text`, `--subject`, `--attachments`, `--headers`.

```bash
paridad inboxes forward-thread-email --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --thread-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --to '["colleague@example.org"]'
```

### paridad inboxes get

Retrieve a single inbox by ID or email address

operationId: `inboxes/get` — `GET /inboxes/{inbox_id}` Banderas: `--inbox-id (obligatoria)`.

```bash
paridad inboxes get --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1
```

### paridad inboxes get-agent

Retrieve the agent settings for an inbox

operationId: `inboxes/get-agent` — `GET /inboxes/{inbox_id}/agent` Banderas: `--inbox-id (obligatoria)`.

```bash
paridad inboxes get-agent --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1
```

### paridad inboxes get-draft

Retrieve a single draft

operationId: `inboxes/get-draft` — `GET /inboxes/{inbox_id}/drafts/{draft_id}` Banderas: `--inbox-id (obligatoria)`, `--draft-id (obligatoria)`.

```bash
paridad inboxes get-draft --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --draft-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad inboxes get-thread

Retrieve a single inbox thread

operationId: `inboxes/get-thread` — `GET /inboxes/{inbox_id}/threads/{thread_id}` Banderas: `--inbox-id (obligatoria)`, `--thread-id (obligatoria)`.

```bash
paridad inboxes get-thread --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --thread-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad inboxes get-thread-email

Retrieve a single thread email

operationId: `inboxes/get-thread-email` — `GET /inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}` Banderas: `--inbox-id (obligatoria)`, `--thread-id (obligatoria)`, `--email-id (obligatoria)`.

```bash
paridad inboxes get-thread-email --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --thread-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad inboxes list

Retrieve a list of inboxes

operationId: `inboxes/list` — `GET /inboxes` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad inboxes list
```

### paridad inboxes list-drafts

Retrieve a list of drafts

operationId: `inboxes/list-drafts` — `GET /inboxes/{inbox_id}/drafts` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--inbox-id (obligatoria)`, `--limit`, `--after`, `--before`.

```bash
paridad inboxes list-drafts --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1
```

### paridad inboxes list-labels

Retrieve a list of inbox labels

operationId: `inboxes/list-labels` — `GET /inboxes/{inbox_id}/labels` Banderas: `--inbox-id (obligatoria)`.

```bash
paridad inboxes list-labels --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1
```

### paridad inboxes list-thread-emails

Retrieve a list of thread emails

operationId: `inboxes/list-thread-emails` — `GET /inboxes/{inbox_id}/threads/{thread_id}/emails` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--inbox-id (obligatoria)`, `--thread-id (obligatoria)`, `--limit`, `--after`, `--before`.

```bash
paridad inboxes list-thread-emails --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --thread-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad inboxes list-threads

Retrieve a list of inbox threads

operationId: `inboxes/list-threads` — `GET /inboxes/{inbox_id}/threads` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--inbox-id (obligatoria)`, `--folders`, `--labels`, `--read`, `--limit`, `--after`, `--before`.

```bash
paridad inboxes list-threads --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1
```

### paridad inboxes remove

Remove an existing inbox by ID or email address

operationId: `inboxes/remove` — `DELETE /inboxes/{inbox_id}` Destructiva: borra o cancela. Banderas: `--inbox-id (obligatoria)`.

```bash
paridad inboxes remove --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1
```

### paridad inboxes remove-draft

Remove an existing draft

operationId: `inboxes/remove-draft` — `DELETE /inboxes/{inbox_id}/drafts/{draft_id}` Destructiva: borra o cancela. Banderas: `--inbox-id (obligatoria)`, `--draft-id (obligatoria)`.

```bash
paridad inboxes remove-draft --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --draft-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad inboxes remove-label

Remove an existing inbox label

operationId: `inboxes/remove-label` — `DELETE /inboxes/{inbox_id}/labels/{label_id}` Destructiva: borra o cancela. Banderas: `--inbox-id (obligatoria)`, `--label-id (obligatoria)`.

```bash
paridad inboxes remove-label --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --label-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad inboxes remove-thread

Remove an existing inbox thread

operationId: `inboxes/remove-thread` — `DELETE /inboxes/{inbox_id}/threads/{thread_id}` Destructiva: borra o cancela. Banderas: `--inbox-id (obligatoria)`, `--thread-id (obligatoria)`.

```bash
paridad inboxes remove-thread --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --thread-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad inboxes remove-thread-label

Remove a label from an inbox thread

operationId: `inboxes/remove-thread-label` — `DELETE /inboxes/{inbox_id}/threads/{thread_id}/labels/{label_id}` Destructiva: borra o cancela. Banderas: `--inbox-id (obligatoria)`, `--thread-id (obligatoria)`, `--label-id (obligatoria)`.

```bash
paridad inboxes remove-thread-label --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --thread-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --label-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad inboxes reply-thread-email

Reply to a thread email

operationId: `inboxes/reply-thread-email` — `POST /inboxes/{inbox_id}/threads/{thread_id}/emails/{email_id}/reply` Acepta `--idempotency-key`. Banderas: `--body`, `--inbox-id (obligatoria)`, `--thread-id (obligatoria)`, `--email-id (obligatoria)`, `--cc`, `--bcc`, `--html`, `--text`, `--subject`, `--reply-all`, `--attachments`, `--headers`.

```bash
paridad inboxes reply-thread-email --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --thread-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --email-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --html '<p>Refund issued for order 1041.</p>'
```

### paridad inboxes search-threads

Search the threads of an inbox

operationId: `inboxes/search-threads` — `GET /inboxes/{inbox_id}/threads/search` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--inbox-id (obligatoria)`, `--query`, `--from`, `--to`, `--cc`, `--bcc`, `--has-attachment`, `--start-date`, `--end-date`, `--folders`, `--labels`, `--read`, `--limit`, `--after`, `--before`.

```bash
paridad inboxes search-threads --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1
```

### paridad inboxes send-draft

Send a draft

operationId: `inboxes/send-draft` — `POST /inboxes/{inbox_id}/drafts/{draft_id}/send` Acepta `--idempotency-key`. Banderas: `--body`, `--inbox-id (obligatoria)`, `--draft-id (obligatoria)`, `--headers`.

```bash
paridad inboxes send-draft --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --draft-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --headers '{"X-Ticket-Id":"4821"}'
```

### paridad inboxes set-thread-labels

Set the labels of an inbox thread

operationId: `inboxes/set-thread-labels` — `PUT /inboxes/{inbox_id}/threads/{thread_id}/labels` Banderas: `--body`, `--inbox-id (obligatoria)`, `--thread-id (obligatoria)`, `--labels (obligatoria)`.

```bash
paridad inboxes set-thread-labels --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --thread-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --labels '["7f9c1d2e-4a6b-4c3d-8e15-9b0a7c6d5e34"]'
```

### paridad inboxes update

Update an existing inbox by ID or email address

operationId: `inboxes/update` — `PATCH /inboxes/{inbox_id}` Banderas: `--body`, `--inbox-id (obligatoria)`, `--name`, `--from-name`.

```bash
paridad inboxes update --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --name 'Customer Support'
```

### paridad inboxes update-agent

Update the agent settings for an inbox

operationId: `inboxes/update-agent` — `PATCH /inboxes/{inbox_id}/agent` Banderas: `--body`, `--inbox-id (obligatoria)`, `--instructions`, `--tone`, `--actions`.

```bash
paridad inboxes update-agent --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --instructions 'Answer refund questions yourself. Escalate legal threats.'
```

### paridad inboxes update-draft

Update an existing draft

operationId: `inboxes/update-draft` — `PATCH /inboxes/{inbox_id}/drafts/{draft_id}` Banderas: `--body`, `--inbox-id (obligatoria)`, `--draft-id (obligatoria)`, `--to`, `--cc`, `--bcc`, `--subject`, `--html`, `--text`, `--attachments`.

```bash
paridad inboxes update-draft --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --draft-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --to '["ada@example.org"]'
```

### paridad inboxes update-label

Update an existing inbox label

operationId: `inboxes/update-label` — `PATCH /inboxes/{inbox_id}/labels/{label_id}` Banderas: `--body`, `--inbox-id (obligatoria)`, `--label-id (obligatoria)`, `--name`, `--color`.

```bash
paridad inboxes update-label --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --label-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --name Billing
```

### paridad inboxes update-thread

Update an existing inbox thread

operationId: `inboxes/update-thread` — `PATCH /inboxes/{inbox_id}/threads/{thread_id}` Banderas: `--body`, `--inbox-id (obligatoria)`, `--thread-id (obligatoria)`, `--read`, `--folder`.

```bash
paridad inboxes update-thread --inbox-id b3e2b2b6-3f0e-4c8e-9ad3-2f43a1e2c7f1 --thread-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --read true
```

## logs

### paridad logs get

Retrieve a single log

operationId: `logs/get` — `GET /logs/{log_id}` Banderas: `--log-id (obligatoria)`.

```bash
paridad logs get --log-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad logs list

Retrieve a list of logs

operationId: `logs/list` — `GET /logs` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad logs list
```

## oauth

### paridad oauth list-grants

Retrieve a list of OAuth grants

operationId: `oauth/list-grants` — `GET /oauth/grants` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad oauth list-grants
```

### paridad oauth revoke-grant

Revoke an OAuth grant

operationId: `oauth/revoke-grant` — `DELETE /oauth/grants/{oauth_grant_id}` Destructiva: borra o cancela. Banderas: `--oauth-grant-id (obligatoria)`.

```bash
paridad oauth revoke-grant --oauth-grant-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

## segments

### paridad segments create

Create a new segment

operationId: `segments/create` — `POST /segments` Banderas: `--body`, `--name (obligatoria)`, `--audience-id`, `--filter`.

```bash
paridad segments create --name example
```

### paridad segments get

Retrieve a single segment

operationId: `segments/get` — `GET /segments/{id}` Banderas: `--id (obligatoria)`.

```bash
paridad segments get --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad segments list

Retrieve a list of segments

operationId: `segments/list` — `GET /segments` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad segments list
```

### paridad segments list-contacts

Retrieve a list of contacts in a segment

operationId: `segments/list-contacts` — `GET /segments/{id}/contacts` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--id (obligatoria)`, `--limit`, `--after`, `--before`.

```bash
paridad segments list-contacts --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad segments remove

Remove an existing segment

operationId: `segments/remove` — `DELETE /segments/{id}` Destructiva: borra o cancela. Banderas: `--id (obligatoria)`.

```bash
paridad segments remove --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad segments update

Update an existing segment

operationId: `segments/update` — `PATCH /segments/{id}` Banderas: `--body`, `--id (obligatoria)`, `--name (obligatoria)`.

```bash
paridad segments update --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --name example
```

## suppressions

### paridad suppressions add

Create a suppression

operationId: `suppressions/add` — `POST /suppressions` Banderas: `--body`, `--email (obligatoria)`.

```bash
paridad suppressions add --email steve.wozniak@gmail.com
```

### paridad suppressions batch-add

Add up to 100 suppressions at once

operationId: `suppressions/batch-add` — `POST /suppressions/batch/add` Banderas: `--body`, `--emails (obligatoria)`.

```bash
paridad suppressions batch-add --emails '["steve.wozniak@gmail.com"]'
```

### paridad suppressions batch-remove

Remove up to 100 suppressions at once

operationId: `suppressions/batch-remove` — `POST /suppressions/batch/remove` Destructiva: borra o cancela. Banderas: `--body`, `--emails`, `--ids`.

```bash
paridad suppressions batch-remove --emails '["steve.wozniak@gmail.com"]'
```

### paridad suppressions get

Retrieve a single suppression by ID or email

operationId: `suppressions/get` — `GET /suppressions/{suppression}` Banderas: `--suppression (obligatoria)`.

```bash
paridad suppressions get --suppression 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad suppressions list

Retrieve a list of suppressions

operationId: `suppressions/list` — `GET /suppressions` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--origin`, `--limit`, `--after`, `--before`.

```bash
paridad suppressions list
```

### paridad suppressions remove

Remove a single suppression by ID or email

operationId: `suppressions/remove` — `DELETE /suppressions/{suppression}` Destructiva: borra o cancela. Banderas: `--suppression (obligatoria)`.

```bash
paridad suppressions remove --suppression 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

## templates

### paridad templates create

Create a template

operationId: `templates/create` — `POST /templates` Banderas: `--body`, `--name (obligatoria)`, `--alias`, `--from`, `--subject`, `--reply-to`, `--html (obligatoria)`, `--text`, `--variables`.

```bash
paridad templates create --name example --html example
```

### paridad templates duplicate

Duplicate a template

operationId: `templates/duplicate` — `POST /templates/{id}/duplicate` Banderas: `--id (obligatoria)`.

```bash
paridad templates duplicate --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad templates get

Retrieve a single template

operationId: `templates/get` — `GET /templates/{id}` Banderas: `--id (obligatoria)`.

```bash
paridad templates get --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad templates list

Retrieve a list of templates

operationId: `templates/list` — `GET /templates` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad templates list
```

### paridad templates publish

Publish a template

operationId: `templates/publish` — `POST /templates/{id}/publish` Banderas: `--id (obligatoria)`.

```bash
paridad templates publish --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad templates remove

Remove an existing template

operationId: `templates/remove` — `DELETE /templates/{id}` Destructiva: borra o cancela. Banderas: `--id (obligatoria)`.

```bash
paridad templates remove --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad templates update

Update an existing template

operationId: `templates/update` — `PATCH /templates/{id}` Banderas: `--body`, `--id (obligatoria)`, `--name`, `--alias`, `--from`, `--subject`, `--reply-to`, `--html`, `--text`, `--variables`.

```bash
paridad templates update --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --name example
```

## topics

### paridad topics create

Create a new topic

operationId: `topics/create` — `POST /topics` Banderas: `--body`, `--name (obligatoria)`, `--default-subscription (obligatoria)`, `--description`, `--visibility`.

```bash
paridad topics create --name example --default-subscription opt_in
```

### paridad topics get

Retrieve a single topic

operationId: `topics/get` — `GET /topics/{id}` Banderas: `--id (obligatoria)`.

```bash
paridad topics get --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad topics list

Retrieve a list of topics

operationId: `topics/list` — `GET /topics` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad topics list
```

### paridad topics remove

Remove an existing topic

operationId: `topics/remove` — `DELETE /topics/{id}` Destructiva: borra o cancela. Banderas: `--id (obligatoria)`.

```bash
paridad topics remove --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad topics update

Update an existing topic

operationId: `topics/update` — `PATCH /topics/{id}` Banderas: `--body`, `--id (obligatoria)`, `--name`, `--description`, `--visibility`.

```bash
paridad topics update --id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --name example
```

## usage

### paridad usage get

Retrieve account usage

operationId: `usage/get` — `GET /usage`

```bash
paridad usage get
```

## webhooks

### paridad webhooks create

Create a new webhook

operationId: `webhooks/create` — `POST /webhooks` Banderas: `--body`, `--endpoint (obligatoria)`, `--events (obligatoria)`.

```bash
paridad webhooks create --endpoint https://webhook.example.com/handler --events '["email.sent","email.delivered","email.bounced","email.suppressed"]'
```

### paridad webhooks get

Retrieve a single webhook

operationId: `webhooks/get` — `GET /webhooks/{webhook_id}` Banderas: `--webhook-id (obligatoria)`.

```bash
paridad webhooks get --webhook-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad webhooks get-event

Retrieve a single webhook event

operationId: `webhooks/get-event` — `GET /webhooks/{webhook_id}/events/{event_id}` Banderas: `--webhook-id (obligatoria)`, `--event-id (obligatoria)`.

```bash
paridad webhooks get-event --webhook-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --event-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad webhooks list

Retrieve a list of webhooks

operationId: `webhooks/list` — `GET /webhooks` Paginada: `--all` trae todos los elementos de todas las páginas. Banderas: `--limit`, `--after`, `--before`.

```bash
paridad webhooks list
```

### paridad webhooks list-event-attempts

Retrieve a list of webhook event attempts

operationId: `webhooks/list-event-attempts` — `GET /webhooks/{webhook_id}/events/{event_id}/attempts` Banderas: `--webhook-id (obligatoria)`, `--event-id (obligatoria)`, `--limit`, `--after`.

```bash
paridad webhooks list-event-attempts --webhook-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --event-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad webhooks list-events

Retrieve a list of webhook events

operationId: `webhooks/list-events` — `GET /webhooks/{webhook_id}/events` Banderas: `--webhook-id (obligatoria)`, `--limit`, `--after`.

```bash
paridad webhooks list-events --webhook-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad webhooks remove

Remove an existing webhook

operationId: `webhooks/remove` — `DELETE /webhooks/{webhook_id}` Destructiva: borra o cancela. Banderas: `--webhook-id (obligatoria)`.

```bash
paridad webhooks remove --webhook-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad webhooks replay-event

Replay a webhook event

operationId: `webhooks/replay-event` — `POST /webhooks/{webhook_id}/events/{event_id}/replay` Banderas: `--webhook-id (obligatoria)`, `--event-id (obligatoria)`.

```bash
paridad webhooks replay-event --webhook-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --event-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad webhooks rotate-signing-secret

Rotate a webhook signing secret

operationId: `webhooks/rotate-signing-secret` — `POST /webhooks/{webhook_id}/signing-secret/rotate` Destructiva: borra o cancela. Banderas: `--webhook-id (obligatoria)`.

```bash
paridad webhooks rotate-signing-secret --webhook-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794
```

### paridad webhooks update

Update an existing webhook

operationId: `webhooks/update` — `PATCH /webhooks/{webhook_id}` Banderas: `--body`, `--webhook-id (obligatoria)`, `--endpoint`, `--events`, `--status`.

```bash
paridad webhooks update --webhook-id 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794 --endpoint https://webhook.example.com/new-handler
```
