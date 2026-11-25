// Skill emitter (vault/CONTRACT.md §6, D21): writes skill/paridad-resend/SKILL.md in
// the Agent Skills format. It teaches an agent the CLI; every command of the CLI is
// shown in a bash block run with the first example of its operation, so each one
// runs without edits.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IR, IROperation } from "../ir.ts";
import { command, exampleArgv } from "./cli.ts";

export const SKILL_NAME = "paridad-resend";
// `paridad contract-check` delegates to compat/ (K3, contract D03); until compat/
// exists the command fails, so the skill teaches it only once it does.
export const CONTRACT_CHECK = existsSync(resolve(import.meta.dirname, "../../../compat/src/main.ts"));
export const SKILL_DESCRIPTION = `Envía emails y administra recursos de Resend (dominios, contactos, difusiones, plantillas, webhooks y el resto de la API de Resend) desde la terminal con el CLI paridad. Úsala cuando una tarea necesite llamar a la API de Resend${CONTRACT_CHECK ? " o comparar dos versiones de su contrato OpenAPI" : ""}.`;

export function emitSkill(ir: IR, outDir: string): void {
  const root = join(outDir, "skill", SKILL_NAME);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), skillMarkdown(ir));
}

// A word of a shell command line, quoted only when it needs it.
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

// `paridad <resource> <action> [flags]` with the first example of the operation.
export function exampleCommand(op: IROperation, ir: IR): string {
  return ["paridad", ...exampleArgv(command(op, ir.schemas), op)].map(shellWord).join(" ");
}

function resources(ir: IR): Map<string, IROperation[]> {
  const grouped = new Map<string, IROperation[]>();
  for (const op of ir.operations) grouped.set(op.resource, [...(grouped.get(op.resource) ?? []), op]);
  return new Map([...grouped].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function bash(line: string): string {
  return `\`\`\`bash\n${line}\n\`\`\``;
}

const CONTRACT_CHECK_SECTION = `
## Chequeo de contrato

\`paridad contract-check\` compara dos versiones de la especificación OpenAPI (base y revisión, con \`--json\` opcional): lista los cambios que rompen, las operaciones y superficies afectadas y el salto semver propuesto, y sale con 0 si la revisión es compatible y con 1 si rompe. Desde la raíz del repositorio, comparando la especificación fijada consigo misma:

${bash("paridad contract-check spec/resend.yaml spec/resend.yaml")}
`;

function skillMarkdown(ir: IR): string {
  const paginated = ir.operations.find((op) => op.pagination !== null && op.pathParams.length === 0);
  const idempotent = ir.operations.find((op) => op.idempotency);
  if (paginated === undefined || idempotent === undefined) throw new Error("skill: the IR has no paginated or no idempotent operation to show");
  const sections = [...resources(ir)].map(([resource, ops]) => {
    const entries = ops.map((op) => {
      const cmd = command(op, ir.schemas);
      const notes = [`operationId: \`${op.id}\` — \`${op.method} ${op.path}\``];
      if (op.pagination !== null) notes.push("Paginada: `--all` trae todos los elementos de todas las páginas.");
      if (op.idempotency) notes.push("Acepta `--idempotency-key`.");
      if (op.destructive) notes.push("Destructiva: borra o cancela.");
      const flags = [...cmd.pathParams, ...cmd.queryParams, ...(cmd.body?.flags ?? [])].map((flag) => `--${flag.flag}${flag.required ? " (obligatoria)" : ""}`);
      if (cmd.body !== null) flags.unshift("--body");
      if (flags.length > 0) notes.push(`Banderas: ${flags.map((flag) => `\`${flag}\``).join(", ")}.`);
      return [`### paridad ${cmd.resource} ${cmd.action}`, "", ...(op.summary === null ? [] : [op.summary, ""]), notes.join(" "), "", bash(exampleCommand(op, ir))].join("\n");
    });
    return [`## ${resource}`, "", ...entries.flatMap((entry) => [entry, ""])].join("\n").trimEnd();
  });

  return `---
name: ${SKILL_NAME}
description: ${JSON.stringify(SKILL_DESCRIPTION)}
---

# paridad-resend

El CLI \`paridad\` llama a la API de Resend: un comando por operación de la especificación OpenAPI fijada (${ir.spec.openapi}, versión ${ir.spec.version}), con la forma \`paridad <recurso> <acción>\` derivada de su operationId. Lo genera paridad desde \`ir/ir.json\`; no se edita a mano.

## Configuración

El CLI lee su configuración del entorno; nada va en los argumentos.

| Variable | Qué es | Por defecto |
| --- | --- | --- |
| \`RESEND_API_KEY\` | Clave de la API, enviada como \`Authorization: Bearer\` | ninguna: sin ella todo comando falla con \`missing_api_key\` |
| \`RESEND_BASE_URL\` | URL base de la API | \`https://api.resend.com\` |
| \`RESEND_TIMEOUT_MS\` | Tiempo máximo de cada intento en milisegundos (\`--timeout-ms\` lo reemplaza) | \`30000\` |
| \`PARIDAD_DEBUG\` | \`1\` escribe en stderr una línea por intento | sin definir |

La clave nunca aparece en la salida. La configuración efectiva, con la clave enmascarada como \`re_...\` y sus 4 últimos caracteres:

${bash("paridad config show")}

## Salida y códigos de salida

- Si stdout no es una terminal, si \`CI\` está definida o con \`--json\`, stdout es JSON: el cuerpo de la respuesta en caso de éxito.
- En caso de error stdout es \`{"error":{"message":…,"code":…,"statusCode":…}}\`; \`code\` es el \`name\` del error de la API (\`validation_error\`, \`not_found\`, \`rate_limit_exceeded\`…), \`timeout\` o \`connection_error\`, y \`statusCode\` es null cuando no llegó respuesta.
- Sale con 0 en éxito y con 1 ante cualquier error. Para saber qué falló, lee el JSON, no solo el código.
- \`paridad <recurso> <acción> --help\` lista las banderas de un comando.

## Argumentos

- Los parámetros de ruta y de query son banderas con el nombre del parámetro en kebab case.
- Las propiedades del cuerpo también son banderas; los valores que son objetos o listas van en JSON. \`--body\` recibe el cuerpo completo en JSON y las banderas de propiedades reemplazan sus propiedades de primer nivel.
- \`emails send\` acepta además \`--react\` (archivo .tsx) y \`--react-props\` (JSON) para renderizar una plantilla de React Email en \`html\`.

## Reintentos e idempotencia

Cada comando hace hasta 3 intentos. Un 429 por límite de tasa se reintenta siempre, esperando \`retry-after\`. Los errores de servidor (500, 502, 503, 504), los timeouts y las conexiones cortadas se reintentan solo en GET, PUT y DELETE, o si la petición lleva clave de idempotencia. Un POST o PATCH sin clave nunca se repite tras un fallo ambiguo, porque el primer intento pudo haber tenido efecto.

Los comandos de las operaciones que declaran \`Idempotency-Key\` aceptan \`--idempotency-key\` (de 1 a 256 caracteres); cada intento envía la misma clave y el mismo cuerpo, así que repetir el comando con la misma clave no envía el email dos veces. El CLI nunca inventa una clave: pasa una siempre que una escritura pueda repetirse.

${bash(`${exampleCommand(idempotent, ir)} --idempotency-key welcome-user-42`)}

## Paginación

Los comandos de listado devuelven una página: \`{"object":"list","has_more":…,"data":[…]}\`. \`--limit\`, \`--after\` y \`--before\` eligen la página; \`--all\` junta todos los elementos de todas las páginas en un solo arreglo \`data\` (el CLI sigue \`after\` mientras \`has_more\` sea verdadero).

${bash(`${exampleCommand(paginated, ir)} --all`)}
${CONTRACT_CHECK ? CONTRACT_CHECK_SECTION : ""}
## Comandos

Una sección por recurso. Cada comando lleva valores de ejemplo que la API acepta.

${sections.join("\n\n")}
`;
}
