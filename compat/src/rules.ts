// Contract compatibility rules of paridad (vault/CONTRACT.md §10, C18, C25): an own
// implementation, not a wrapper of oasdiff, that classifies each change between two
// versions of the spec as breaking or compatible at the ERR level of oasdiff v1.39.0.
// Each own rule names the oasdiff checks it reproduces: the ids are those of
// `oasdiff checks changelog` and of checker/*.go in the module pinned by tools/go.mod.
//
// What it follows from oasdiff:
// - Endpoints match by method and path with path parameter names included, as
//   `oasdiff breaking --include-path-params`: by default oasdiff ignores the names and
//   rejects 19 pairs of the history corpus as "duplicate endpoint" (verify/corpus/), and
//   in the generated SDKs a path parameter name is part of the public API.
// - Requests are contravariant and responses covariant: what narrows a request or
//   widens a response breaks (checker/check_types.go, bound_rules.go).
// - Without --flatten-allof a change under an allOf branch, or at a schema that has
//   allOf, is reported at WARN at most (checker/media_type_walker.go, disclaimer.go).
// - readOnly request properties and writeOnly response properties are guarded down to
//   INFO (checker/attributes.go).
import {
  SCHEMAS_REF,
  componentSchemas,
  deref,
  endpoints,
  isObject,
  toJsonSchema,
  type JsonObject,
  type JsonSchema,
  type Spec,
  type SpecEndpoint,
} from "../../generator/src/spec.ts";

export type Level = "ERR" | "WARN" | "INFO";

interface Rule {
  level: Level;
  oasdiff: string[];
}

// Own rule → its level and the oasdiff v1.39.0 checks it covers.
export const RULES = {
  // check_api_removed.go
  "operation-removed": { level: "ERR", oasdiff: ["api-removed-without-deprecation", "api-path-removed-without-deprecation"] },
  "operation-removed-before-sunset": { level: "ERR", oasdiff: ["api-removed-before-sunset", "api-path-removed-before-sunset"] },
  "operation-removed-sunset-parse": { level: "ERR", oasdiff: ["api-path-sunset-parse"] },
  "operation-removed-after-deprecation": { level: "INFO", oasdiff: ["api-removed-with-deprecation", "api-path-removed-with-deprecation"] },
  // check_api_added.go
  "operation-added": { level: "INFO", oasdiff: ["endpoint-added"] },
  // check_api_deprecation.go, with the default sunset grace period of 0 days
  "operation-deprecated": { level: "INFO", oasdiff: ["endpoint-deprecated", "endpoint-deprecated-with-sunset"] },
  "operation-deprecated-sunset-parse": { level: "ERR", oasdiff: ["api-deprecated-sunset-parse"] },
  "operation-deprecated-sunset-past": { level: "ERR", oasdiff: ["api-sunset-date-too-small"] },
  "operation-reactivated": { level: "INFO", oasdiff: ["endpoint-reactivated"] },
  // check_webhook_updated.go
  "webhook-removed": { level: "ERR", oasdiff: ["webhook-removed"] },
  "webhook-added": { level: "INFO", oasdiff: ["webhook-added"] },
  // check_api_security_updated.go and anonymous_access.go, on the effective security
  // of each operation (its own, or the global one it inherits)
  "security-anonymous-access-removed": { level: "ERR", oasdiff: ["api-security-anonymous-access-removed"] },
  "security-anonymous-access-added": { level: "INFO", oasdiff: ["api-security-anonymous-access-added"] },
  "security-requirement-removed": { level: "ERR", oasdiff: ["api-security-removed"] },
  "security-requirement-added": { level: "INFO", oasdiff: ["api-security-added"] },
  "security-scope-added": { level: "ERR", oasdiff: ["api-security-scope-added"] },
  "security-scope-removed": { level: "INFO", oasdiff: ["api-security-scope-removed"] },
  // global security with no operation inheriting it is reported at INFO
  "security-global-changed": { level: "INFO", oasdiff: ["api-global-security-removed", "api-global-security-added", "api-global-security-scope-added", "api-global-security-scope-removed"] },
  // check_components_security_updated.go
  "security-scheme-changed": {
    level: "ERR",
    oasdiff: ["api-security-component-type-changed", "api-security-component-http-scheme-changed", "api-security-component-api-key-name-changed", "api-security-component-api-key-in-changed"],
  },
  "security-scheme-removed": { level: "INFO", oasdiff: ["api-security-component-removed"] },
  "security-scheme-added": { level: "INFO", oasdiff: ["api-security-component-added"] },
  // check_new_request_non_path_parameter.go, check_request_path_parameter_added.go,
  // check_new_request_non_path_default_parameter.go (a parameter added at path level
  // reaches each operation of the path through the loader)
  "parameter-added-required": { level: "ERR", oasdiff: ["new-required-request-parameter", "new-required-request-default-parameter-to-existing-path"] },
  "parameter-added-path": { level: "ERR", oasdiff: ["new-request-path-parameter"] },
  "parameter-added-optional": { level: "INFO", oasdiff: ["new-optional-request-parameter"] },
  // check_request_parameter_removed.go
  "parameter-removed": { level: "WARN", oasdiff: ["request-parameter-removed"] },
  // check_request_parameter_required_value_updated.go
  "parameter-became-required": { level: "ERR", oasdiff: ["request-parameter-became-required"] },
  "parameter-became-optional": { level: "INFO", oasdiff: ["request-parameter-became-optional"] },
  // check_added_required_request_body.go, check_request_body_removed.go,
  // check_request_body_required_value_updated.go
  "request-body-added-required": { level: "ERR", oasdiff: ["request-body-added-required"] },
  "request-body-added-optional": { level: "INFO", oasdiff: ["request-body-added-optional"] },
  "request-body-removed": { level: "ERR", oasdiff: ["request-body-removed"] },
  "request-body-became-required": { level: "ERR", oasdiff: ["request-body-became-required"] },
  "request-body-became-optional": { level: "INFO", oasdiff: ["request-body-became-optional"] },
  // check_request_body_mediatype_updated.go, check_media_type_schema_existence.go
  "request-media-type-removed": { level: "ERR", oasdiff: ["request-body-media-type-removed"] },
  "request-media-type-added": { level: "INFO", oasdiff: ["request-body-media-type-added"] },
  "request-media-type-schema-added": { level: "ERR", oasdiff: ["request-body-media-type-schema-added"] },
  "request-media-type-schema-removed": { level: "INFO", oasdiff: ["request-body-media-type-schema-removed"] },
  // check_response_status_updated.go
  "response-success-status-removed": { level: "ERR", oasdiff: ["response-success-status-removed"] },
  "response-non-success-status-removed": { level: "INFO", oasdiff: ["response-non-success-status-removed"] },
  "response-status-added": { level: "INFO", oasdiff: ["response-success-status-added", "response-non-success-status-added"] },
  // check_response_mediatype_updated.go, check_media_type_schema_existence.go
  "response-media-type-removed": { level: "ERR", oasdiff: ["response-media-type-removed"] },
  "response-media-type-added": { level: "INFO", oasdiff: ["response-media-type-added"] },
  "response-media-type-schema-removed": { level: "ERR", oasdiff: ["response-body-media-type-schema-removed"] },
  "response-media-type-schema-added": { level: "INFO", oasdiff: ["response-body-media-type-schema-added"] },
  // check_response_header_removed.go, check_response_header_became_optional.go,
  // check_response_header_added.go
  "response-header-required-removed": { level: "ERR", oasdiff: ["required-response-header-removed"] },
  "response-header-optional-removed": { level: "INFO", oasdiff: ["optional-response-header-removed"] },
  "response-header-became-optional": { level: "ERR", oasdiff: ["response-header-became-optional"] },
  "response-header-added": { level: "INFO", oasdiff: ["response-required-header-added", "response-optional-header-added"] },
  // check_request_property_type_changed.go, check_request_parameters_type_changed.go,
  // check_request_property_list_of_types_changed.go,
  // check_request_property_became_not_nuallable.go,
  // check_request_parameter_became_nullable.go (null is one more type, check_types.go)
  "request-type-changed": {
    level: "ERR",
    oasdiff: [
      "request-body-type-changed",
      "request-property-type-changed",
      "request-parameter-type-changed",
      "request-body-list-of-types-narrowed",
      "request-property-list-of-types-narrowed",
      "request-parameter-list-of-types-narrowed",
      "request-body-became-not-nullable",
      "request-property-became-not-nullable",
      "request-parameter-became-not-nullable",
    ],
  },
  "request-type-generalized": { level: "INFO", oasdiff: ["request-body-type-generalized", "request-property-type-generalized", "request-parameter-type-generalized"] },
  // check_response_property_type_changed.go, check_response_header_type_changed.go,
  // check_response_property_list_of_types_changed.go,
  // check_response_property_became_nuallable.go, check_response_header_became_nullable.go
  "response-type-changed": {
    level: "ERR",
    oasdiff: [
      "response-body-type-changed",
      "response-property-type-changed",
      "response-header-type-changed",
      "response-body-type-generalized",
      "response-property-type-generalized",
      "response-header-type-generalized",
      "response-body-list-of-types-widened",
      "response-property-list-of-types-widened",
      "response-body-became-nullable",
      "response-property-became-nullable",
      "response-header-became-nullable",
    ],
  },
  "response-type-specialized": { level: "INFO", oasdiff: ["response-body-type-specialized", "response-property-type-specialized"] },
  // check_request_body_enum_deleted.go, check_request_property_enum_value_updated.go,
  // check_request_parameter_enum_value_updated.go
  "request-enum-value-removed": { level: "ERR", oasdiff: ["request-body-enum-value-removed", "request-property-enum-value-removed", "request-parameter-enum-value-removed"] },
  "request-enum-value-added": { level: "INFO", oasdiff: ["request-property-enum-value-added", "request-parameter-enum-value-added"] },
  // check_request_body_became_enum.go, check_request_property_became_enum.go,
  // check_request_parameter_became_enum.go
  "request-became-enum": { level: "ERR", oasdiff: ["request-body-became-enum", "request-property-became-enum", "request-parameter-became-enum"] },
  "request-became-not-enum": { level: "INFO", oasdiff: ["request-body-became-not-enum", "request-property-became-not-enum", "request-parameter-became-not-enum"] },
  // check_response_property_enum_value_added.go, check_response_mediatype_enum_value_added.go
  "response-enum-value-added": { level: "ERR", oasdiff: ["response-property-enum-value-added", "response-mediatype-enum-value-added"] },
  "response-enum-value-removed": { level: "INFO", oasdiff: ["response-property-enum-value-removed", "response-mediatype-enum-value-removed"] },
  // check_response_property_became_not_enum.go, check_response_mediatype_became_not_enum.go
  "response-became-not-enum": { level: "ERR", oasdiff: ["response-property-became-not-enum", "response-mediatype-became-not-enum"] },
  "response-became-enum": { level: "INFO", oasdiff: ["response-property-became-enum", "response-mediatype-became-enum"] },
  // check_request_property_const_changed.go
  "request-const-changed": { level: "ERR", oasdiff: ["request-body-const-added", "request-body-const-changed", "request-property-const-added", "request-property-const-changed"] },
  "request-const-removed": { level: "INFO", oasdiff: ["request-body-const-removed", "request-property-const-removed"] },
  // check_response_property_const_changed.go
  "response-const-changed": { level: "ERR", oasdiff: ["response-body-const-changed", "response-body-const-removed", "response-property-const-changed", "response-property-const-removed"] },
  "response-const-added": { level: "INFO", oasdiff: ["response-body-const-added", "response-property-const-added"] },
  // bound_rules.go (generated set/unset/increased/decreased cells) and the
  // hand-written min/max checks it defers to
  "request-bound-narrowed": { level: "ERR", oasdiff: ["request-{body,property,parameter}-{max,min,max-length,min-length,max-items,min-items,max-properties,min-properties,max-contains,min-contains,exclusive-max,exclusive-min}-{set,increased,decreased}"] },
  "request-bound-widened": { level: "INFO", oasdiff: ["request-{body,property,parameter}-{…}-{unset,increased,decreased}"] },
  "response-bound-widened": { level: "ERR", oasdiff: ["response-{body,property,header}-{max,min,max-length,min-length,max-items,min-items,max-properties,min-properties,max-contains,min-contains,exclusive-max,exclusive-min}-{unset,increased,decreased}"] },
  "response-bound-narrowed": { level: "INFO", oasdiff: ["response-{body,property,header}-{…}-{set,increased,decreased}"] },
  // check_request_property_multiple_of_updated.go and bound_rules.go
  "request-multiple-of-changed": { level: "ERR", oasdiff: ["request-body-multiple-of-set", "request-body-multiple-of-changed", "request-property-multiple-of-set", "request-property-multiple-of-changed", "request-parameter-multiple-of-set"] },
  "response-multiple-of-changed": {
    level: "ERR",
    oasdiff: ["response-body-multiple-of-changed", "response-body-multiple-of-unset", "response-property-multiple-of-changed", "response-property-multiple-of-unset", "response-header-multiple-of-unset"],
  },
  "multiple-of-relaxed": { level: "INFO", oasdiff: ["request-*-multiple-of-unset", "response-*-multiple-of-set"] },
  // check_request_property_unique_items_updated.go, check_response_property_unique_items_unset.go
  "request-unique-items-set": { level: "ERR", oasdiff: ["request-body-unique-items-set", "request-property-unique-items-set"] },
  "response-unique-items-unset": { level: "ERR", oasdiff: ["response-body-unique-items-unset", "response-property-unique-items-unset"] },
  // check_request_property_pattern_added_or_changed.go,
  // check_request_parameter_pattern_added_or_changed.go
  "request-pattern-added": { level: "ERR", oasdiff: ["request-property-pattern-added", "request-parameter-pattern-added"] },
  "request-pattern-changed": { level: "WARN", oasdiff: ["request-property-pattern-changed", "request-parameter-pattern-changed"] },
  // check_response_pattern_added_or_changed.go
  "response-pattern-removed": { level: "ERR", oasdiff: ["response-property-pattern-removed"] },
  "response-pattern-changed": { level: "WARN", oasdiff: ["response-property-pattern-changed"] },
  // check_schema_became_false.go
  "request-schema-became-false": { level: "ERR", oasdiff: ["request-body-schema-became-false", "request-property-schema-became-false", "request-parameter-schema-became-false"] },
  "response-schema-became-false": { level: "ERR", oasdiff: ["response-body-schema-became-false"] },
  "response-schema-became-not-false": { level: "ERR", oasdiff: ["response-property-schema-became-not-false", "response-header-schema-became-not-false"] },
  // check_request_property_{contains,if,unevaluated,property_names,pattern_properties,
  // dependent_required,dependent_schemas,content}_updated.go
  "request-keyword-added": {
    level: "ERR",
    oasdiff: [
      "request-{body,property}-{contains,if,then,else,property-names,unevaluated-items,unevaluated-properties,content-schema,dependent-required,dependent-schema,pattern-property}-added",
      "request-{body,property}-{dependent-required,content-encoding,content-media-type}-changed",
    ],
  },
  "request-keyword-removed": { level: "INFO", oasdiff: ["request-{body,property}-{…}-removed"] },
  // check_response_property_{contains,if,unevaluated,property_names,pattern_properties,
  // dependent_required,dependent_schemas,content}_updated.go
  "response-keyword-removed": {
    level: "ERR",
    oasdiff: [
      "response-{body,property}-{contains,if,then,else,property-names,unevaluated-items,unevaluated-properties,content-schema,dependent-required,dependent-schema,pattern-property}-removed",
      "response-{body,property}-{dependent-required,content-encoding,content-media-type}-changed",
    ],
  },
  "response-keyword-added": { level: "INFO", oasdiff: ["response-{body,property}-{…}-added"] },
  // check_request_property_{one_of,any_of,all_of}_updated.go
  "request-one-of-removed": { level: "ERR", oasdiff: ["request-body-one-of-removed", "request-property-one-of-removed"] },
  "request-any-of-removed": { level: "ERR", oasdiff: ["request-body-any-of-removed", "request-property-any-of-removed"] },
  "request-all-of-added": { level: "ERR", oasdiff: ["request-body-all-of-added", "request-property-all-of-added"] },
  "request-subschema-relaxed": { level: "INFO", oasdiff: ["request-{body,property}-one-of-added", "request-{body,property}-any-of-added", "request-{body,property}-all-of-removed"] },
  // check_response_property_{one_of,any_of,all_of}_updated.go
  "response-one-of-added": { level: "ERR", oasdiff: ["response-body-one-of-added", "response-property-one-of-added"] },
  "response-any-of-added": { level: "ERR", oasdiff: ["response-body-any-of-added", "response-property-any-of-added"] },
  "response-all-of-removed": { level: "ERR", oasdiff: ["response-body-all-of-removed", "response-property-all-of-removed"] },
  "response-subschema-narrowed": { level: "INFO", oasdiff: ["response-{body,property}-one-of-removed", "response-{body,property}-any-of-removed", "response-{body,property}-all-of-added"] },
  // check_request_property_updated.go, check_response_required_property_updated.go:
  // the oneof-wrapping transition of transition_claims.go at the body root
  // (diff/one_of_wrapping_diff.go), WARN when an alternative keeps the base contract
  "request-body-wrapped-in-one-of": { level: "ERR", oasdiff: ["request-body-wrapped-in-one-of"] },
  "request-body-wrapped-in-one-of-preserved": { level: "WARN", oasdiff: ["request-body-wrapped-in-one-of-original-preserved"] },
  "response-body-wrapped-in-one-of": { level: "ERR", oasdiff: ["response-body-wrapped-in-one-of"] },
  "response-body-wrapped-in-one-of-preserved": { level: "WARN", oasdiff: ["response-body-wrapped-in-one-of-original-preserved"] },
  // check_request_property_updated.go
  "request-property-added-required": { level: "ERR", oasdiff: ["new-required-request-property", "new-required-request-property-with-default"] },
  "request-property-added-optional": { level: "INFO", oasdiff: ["new-optional-request-property"] },
  "request-property-removed": { level: "WARN", oasdiff: ["request-property-removed"] },
  "request-property-removed-after-deprecation": { level: "INFO", oasdiff: ["request-property-removed-with-deprecation"] },
  // check_request_property_required_updated.go
  "request-property-became-required": { level: "ERR", oasdiff: ["request-property-became-required", "request-property-became-required-with-default"] },
  "request-property-became-optional": { level: "INFO", oasdiff: ["request-property-became-optional"] },
  // check_request_property_write_only_read_only.go
  "request-required-property-became-not-read-only": { level: "ERR", oasdiff: ["request-required-property-became-not-read-only"] },
  // check_response_required_property_updated.go, check_response_optional_property_updated.go
  "response-required-property-removed": { level: "ERR", oasdiff: ["response-required-property-removed"] },
  "response-required-property-removed-after-deprecation": { level: "INFO", oasdiff: ["response-required-property-removed-with-deprecation", "response-required-write-only-property-removed"] },
  "response-optional-property-removed": { level: "INFO", oasdiff: ["response-optional-property-removed"] },
  "response-property-added": { level: "INFO", oasdiff: ["response-required-property-added", "response-optional-property-added"] },
  // check_response_property_became_optional.go, check_response_property_became_required.go
  "response-property-became-optional": { level: "ERR", oasdiff: ["response-property-became-optional", "response-write-only-property-became-optional"] },
  "response-property-became-required": { level: "INFO", oasdiff: ["response-property-became-required"] },
  // check_response_required_property_write_only_read_only.go
  "response-required-property-became-write-only": { level: "ERR", oasdiff: ["response-required-property-became-write-only"] },
} satisfies Record<string, Rule>;

export type RuleId = keyof typeof RULES;

export interface Change {
  rule: RuleId;
  level: Level;
  oasdiff: string[];
  // `MÉTODO /ruta`, with the path of the base (the revision's for an added operation);
  // null for changes outside any operation (webhooks, security schemes).
  operation: string | null;
  operationId: string | null;
  detail: string;
}

// The five executable surfaces plus the documentation and the skill (contract §10).
export const SURFACES = ["ts", "python", "go", "cli", "mcp", "docs", "skill"];

export interface Report {
  classification: "breaking" | "compatible";
  bump: "major" | "minor" | "patch";
  exitCode: 0 | 1;
  operations: string[];
  surfaces: { operation: string; operationId: string | null; surfaces: string[] }[];
  changes: Change[];
}

const LEVELS: Level[] = ["INFO", "WARN", "ERR"];

type Emit = (rule: RuleId, detail: string, ceiling?: Level | null) => void;

// The listed operations are those of the changes that decide the classification: the
// breaking ones when the revision breaks, otherwise every change. The contract bump is
// major for ERR and for WARN (oasdiff's "potentially breaking"), minor for any other
// change and patch when nothing changed.
export function report(changes: Change[]): Report {
  const breaking = changes.filter((change) => change.level === "ERR");
  const deciding = breaking.length > 0 ? breaking : changes;
  const ids = new Map<string, string | null>();
  for (const change of deciding) {
    if (change.operation !== null && !ids.get(change.operation)) ids.set(change.operation, change.operationId);
  }
  const operations = [...ids.keys()].sort(compare);
  return {
    classification: breaking.length > 0 ? "breaking" : "compatible",
    bump: changes.some((change) => change.level !== "INFO") ? "major" : changes.length > 0 ? "minor" : "patch",
    exitCode: breaking.length > 0 ? 1 : 0,
    operations,
    surfaces: operations.map((operation) => ({ operation, operationId: ids.get(operation) ?? null, surfaces: [...SURFACES] })),
    changes,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Side {
  spec: Spec;
  schemas: Record<string, JsonSchema>;
  endpoints: Map<string, SpecEndpoint>;
  paths: Set<string>;
}

function endpointKey(method: string, path: string): string {
  return `${method} ${path}`;
}

function side(spec: Spec): Side {
  const map = new Map<string, SpecEndpoint>();
  for (const endpoint of endpoints(spec)) map.set(endpointKey(endpoint.method, endpoint.path), endpoint);
  return { spec, schemas: componentSchemas(spec), endpoints: map, paths: new Set([...map.values()].map((endpoint) => endpoint.path)) };
}

export function compareSpecs(baseSpec: Spec, revisionSpec: Spec): Change[] {
  const base = side(baseSpec);
  const revision = side(revisionSpec);
  const changes: Change[] = [];
  const emitter =
    (operation: string | null, operationId: string | null): Emit =>
    (rule, detail, ceiling = null) => {
      const own: Rule = RULES[rule];
      const level = ceiling !== null && LEVELS.indexOf(ceiling) < LEVELS.indexOf(own.level) ? ceiling : own.level;
      changes.push({ rule, level, oasdiff: own.oasdiff, operation, operationId, detail });
    };

  for (const [key, before] of base.endpoints) {
    const after = revision.endpoints.get(key);
    const label = `${before.method} ${before.path}`;
    if (after === undefined) {
      removedOperation(emitter(label, before.operationId), before, !revision.paths.has(before.path));
      continue;
    }
    compareOperation(emitter(label, after.operationId ?? before.operationId), base, revision, before, after);
  }
  for (const [key, after] of revision.endpoints) {
    if (!base.endpoints.has(key)) emitter(`${after.method} ${after.path}`, after.operationId)("operation-added", "operation added");
  }

  const emitGlobal = emitter(null, null);
  const webhooksBefore = mapping(baseSpec.document["webhooks"]);
  const webhooksAfter = mapping(revisionSpec.document["webhooks"]);
  for (const name of Object.keys(webhooksBefore)) if (!Object.hasOwn(webhooksAfter, name)) emitGlobal("webhook-removed", `webhook ${name} removed`);
  for (const name of Object.keys(webhooksAfter)) if (!Object.hasOwn(webhooksBefore, name)) emitGlobal("webhook-added", `webhook ${name} added`);
  compareGlobalSecurity(emitGlobal, base, revision);
  compareSecuritySchemes(emitGlobal, baseSpec, revisionSpec);
  return changes;
}

function mapping(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

// --- Operations -------------------------------------------------------------------

function removedOperation(emit: Emit, before: SpecEndpoint, wholePath: boolean): void {
  const stability = before.source["x-stability-level"];
  // checkRemovedPaths skips draft and alpha operations.
  if (wholePath && (stability === "draft" || stability === "alpha")) return;
  if (before.source["deprecated"] !== true) return emit("operation-removed", wholePath ? "path and operation removed" : "operation removed");
  const sunset = before.source["x-sunset"];
  if (sunset === undefined) return emit("operation-removed-after-deprecation", "deprecated operation removed");
  const date = sunsetDate(sunset);
  if (date === null) return emit("operation-removed-sunset-parse", `deprecated operation removed with an invalid x-sunset ${JSON.stringify(sunset)}`);
  if (today() < date) emit("operation-removed-before-sunset", `operation removed before its sunset date ${date}`);
}

// civil.ParseDate (YYYY-MM-DD) or an RFC 3339 date-time, as deprecation.SunsetDate.
function sunsetDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/i.exec(value);
  if (match === null || Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`))) return null;
  return match[1]!;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function compareOperation(emit: Emit, base: Side, revision: Side, before: SpecEndpoint, after: SpecEndpoint): void {
  if (before.source["deprecated"] !== true && after.source["deprecated"] === true) {
    const sunset = after.source["x-sunset"];
    const date = sunset === undefined ? undefined : sunsetDate(sunset);
    if (date === null) emit("operation-deprecated-sunset-parse", `operation deprecated with an invalid x-sunset ${JSON.stringify(sunset)}`);
    else if (date !== undefined && date < today()) emit("operation-deprecated-sunset-past", `operation deprecated with a sunset date ${date} already past`);
    else emit("operation-deprecated", "operation deprecated");
  } else if (before.source["deprecated"] === true && after.source["deprecated"] !== true) {
    emit("operation-reactivated", "operation no longer deprecated");
  }
  compareOperationSecurity(emit, base, revision, before, after);
  compareParameters(emit, base, revision, before, after);
  compareRequestBody(emit, base, revision, before, after);
  compareResponses(emit, base, revision, before, after);
}

// --- Security ---------------------------------------------------------------------

type Requirements = Map<string, Map<string, string[]>>;

function requirements(value: unknown): Requirements | null {
  if (!Array.isArray(value)) return null;
  const result: Requirements = new Map();
  for (const requirement of value) {
    if (!isObject(requirement)) continue;
    const schemes = new Map(Object.entries(requirement).map(([name, scopes]) => [name, Array.isArray(scopes) ? scopes.map(String) : []]));
    result.set([...schemes.keys()].sort(compare).join(" AND "), schemes);
  }
  return result;
}

// No requirement, or an empty one, lets unauthenticated requests through.
function allowsAnonymous(value: Requirements | null): boolean {
  return value === null || value.size === 0 || value.has("");
}

function compareRequirements(emit: Emit, before: Requirements | null, after: Requirements | null): void {
  const anonymousBefore = allowsAnonymous(before);
  const anonymousAfter = allowsAnonymous(after);
  if (anonymousBefore && !anonymousAfter) return emit("security-anonymous-access-removed", "unauthenticated requests are rejected now");
  if (!anonymousBefore && anonymousAfter) return emit("security-anonymous-access-added", "unauthenticated requests are accepted now");
  const old = before ?? new Map<string, Map<string, string[]>>();
  const next = after ?? new Map<string, Map<string, string[]>>();
  for (const name of next.keys()) if (name !== "" && !old.has(name)) emit("security-requirement-added", `security requirement ${name} added`);
  for (const [name, schemes] of old) {
    if (name === "") continue;
    const revised = next.get(name);
    if (revised === undefined) {
      if (!anonymousAfter) emit("security-requirement-removed", `security requirement ${name} removed`);
      continue;
    }
    for (const [scheme, scopes] of schemes) {
      const revisedScopes = revised.get(scheme) ?? [];
      for (const scope of revisedScopes) if (!scopes.includes(scope) && !anonymousAfter) emit("security-scope-added", `scope ${scope} added to ${scheme}`);
      for (const scope of scopes) if (!revisedScopes.includes(scope)) emit("security-scope-removed", `scope ${scope} removed from ${scheme}`);
    }
  }
}

function compareOperationSecurity(emit: Emit, base: Side, revision: Side, before: SpecEndpoint, after: SpecEndpoint): void {
  const own = (endpoint: SpecEndpoint, spec: Spec): Requirements | null => requirements(endpoint.source["security"]) ?? requirements(spec.document["security"]);
  compareRequirements(emit, own(before, base.spec), own(after, revision.spec));
}

// Global security changes reach each operation that inherits them through
// compareOperationSecurity; they stand alone (at INFO) only when no operation does.
function compareGlobalSecurity(emit: Emit, base: Side, revision: Side): void {
  for (const [key, before] of base.endpoints) {
    const after = revision.endpoints.get(key);
    if (after !== undefined && before.source["security"] === undefined && after.source["security"] === undefined) return;
  }
  const before = JSON.stringify(base.spec.document["security"] ?? null);
  const after = JSON.stringify(revision.spec.document["security"] ?? null);
  if (before !== after) emit("security-global-changed", `global security changed from ${before} to ${after}`);
}

function compareSecuritySchemes(emit: Emit, base: Spec, revision: Spec): void {
  const schemes = (spec: Spec): JsonObject => mapping(mapping(spec.document["components"])["securitySchemes"]);
  const before = schemes(base);
  const after = schemes(revision);
  for (const [name, raw] of Object.entries(before)) {
    if (!Object.hasOwn(after, name)) {
      emit("security-scheme-removed", `security scheme ${name} removed`);
      continue;
    }
    const old = deref(base, raw, `security scheme ${name}`);
    const next = deref(revision, after[name], `security scheme ${name}`);
    for (const field of ["type", "scheme", "name", "in"]) {
      if (old[field] !== next[field]) emit("security-scheme-changed", `${field} of security scheme ${name} changed from ${JSON.stringify(old[field] ?? null)} to ${JSON.stringify(next[field] ?? null)}`);
    }
  }
  for (const name of Object.keys(after)) if (!Object.hasOwn(before, name)) emit("security-scheme-added", `security scheme ${name} added`);
}

// --- Parameters -------------------------------------------------------------------

function compareParameters(emit: Emit, base: Side, revision: Side, before: SpecEndpoint, after: SpecEndpoint): void {
  // Both paths are equal, so path parameters match by name; header names are
  // case-insensitive (the default --case-insensitive-headers).
  const key = (location: string, name: string): string => `${location}:${location === "header" ? name.toLowerCase() : name}`;
  const revised = new Map(after.parameters.map((parameter) => [key(parameter.in, parameter.name), parameter]));
  const matched = new Set<string>();
  for (const parameter of before.parameters) {
    const next = revised.get(key(parameter.in, parameter.name));
    const where = `${parameter.in} parameter ${parameter.name}`;
    if (next === undefined) {
      emit("parameter-removed", `${where} removed`);
      continue;
    }
    matched.add(key(next.in, next.name));
    if (!parameter.required && next.required) emit("parameter-became-required", `${where} became required`);
    if (parameter.required && !next.required) emit("parameter-became-optional", `${where} became optional`);
    compareSchema(walk(emit, base, revision, "request", "parameter", false), parameter.schema, next.schema, where);
  }
  for (const [name, parameter] of revised) {
    if (matched.has(name)) continue;
    const where = `${parameter.in} parameter ${parameter.name}`;
    if (parameter.in === "path") emit("parameter-added-path", `${where} added`);
    else if (parameter.required) emit("parameter-added-required", `required ${where} added`);
    else emit("parameter-added-optional", `optional ${where} added`);
  }
}

// --- Request bodies ---------------------------------------------------------------

function requestBody(spec: Spec, endpoint: SpecEndpoint): JsonObject | null {
  const raw = endpoint.source["requestBody"];
  return raw === undefined ? null : deref(spec, raw, `the request body of ${endpoint.method} ${endpoint.path}`);
}

// Strongly typed media types are JSON ones (check_types.go isStronglyTyped): in any
// other, a value of any type can be read as a string.
function isJson(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function mediaSchema(spec: Spec, media: unknown): JsonSchema | null {
  return isObject(media) && media["schema"] !== undefined ? toJsonSchema(spec, media["schema"]) : null;
}

function compareRequestBody(emit: Emit, base: Side, revision: Side, before: SpecEndpoint, after: SpecEndpoint): void {
  const old = requestBody(base.spec, before);
  const next = requestBody(revision.spec, after);
  if (old === null && next === null) return;
  if (old === null) return emit(next!["required"] === true ? "request-body-added-required" : "request-body-added-optional", "request body added");
  if (next === null) return emit("request-body-removed", "request body removed");
  if (old["required"] !== true && next["required"] === true) emit("request-body-became-required", "request body became required");
  if (old["required"] === true && next["required"] !== true) emit("request-body-became-optional", "request body became optional");
  const oldContent = mapping(old["content"]);
  const nextContent = mapping(next["content"]);
  for (const [mediaType, media] of Object.entries(oldContent)) {
    if (!Object.hasOwn(nextContent, mediaType)) {
      emit("request-media-type-removed", `request media type ${mediaType} removed`);
      continue;
    }
    const oldSchema = mediaSchema(base.spec, media);
    const nextSchema = mediaSchema(revision.spec, nextContent[mediaType]);
    if (oldSchema === null && nextSchema !== null) emit("request-media-type-schema-added", `schema added to request media type ${mediaType}`);
    else if (oldSchema !== null && nextSchema === null) emit("request-media-type-schema-removed", `schema removed from request media type ${mediaType}`);
    else if (oldSchema !== null && nextSchema !== null) {
      compareSchema(walk(emit, base, revision, "request", "body", isJson(mediaType)), oldSchema, nextSchema, `request body ${mediaType}`);
    }
  }
  for (const mediaType of Object.keys(nextContent)) if (!Object.hasOwn(oldContent, mediaType)) emit("request-media-type-added", `request media type ${mediaType} added`);
}

// --- Responses --------------------------------------------------------------------

function compareResponses(emit: Emit, base: Side, revision: Side, before: SpecEndpoint, after: SpecEndpoint): void {
  const old = mapping(before.source["responses"]);
  const next = mapping(after.source["responses"]);
  for (const [status, raw] of Object.entries(old)) {
    if (!Object.hasOwn(next, status)) {
      // Only numeric statuses count as success or not (strconv.Atoi in responseStatusUpdated).
      if (/^\d+$/.test(status)) {
        const code = Number(status);
        emit(code >= 200 && code <= 299 ? "response-success-status-removed" : "response-non-success-status-removed", `response ${status} removed`);
      }
      continue;
    }
    const where = `${before.method} ${before.path} response ${status}`;
    compareResponse(emit, base, revision, deref(base.spec, raw, where), deref(revision.spec, next[status], where), status);
  }
  for (const status of Object.keys(next)) if (!Object.hasOwn(old, status) && /^\d+$/.test(status)) emit("response-status-added", `response ${status} added`);
}

function compareResponse(emit: Emit, base: Side, revision: Side, old: JsonObject, next: JsonObject, status: string): void {
  const oldContent = mapping(old["content"]);
  const nextContent = mapping(next["content"]);
  for (const [mediaType, media] of Object.entries(oldContent)) {
    if (!Object.hasOwn(nextContent, mediaType)) {
      emit("response-media-type-removed", `media type ${mediaType} of response ${status} removed`);
      continue;
    }
    const oldSchema = mediaSchema(base.spec, media);
    const nextSchema = mediaSchema(revision.spec, nextContent[mediaType]);
    if (oldSchema !== null && nextSchema === null) emit("response-media-type-schema-removed", `schema removed from media type ${mediaType} of response ${status}`);
    else if (oldSchema === null && nextSchema !== null) emit("response-media-type-schema-added", `schema added to media type ${mediaType} of response ${status}`);
    else if (oldSchema !== null && nextSchema !== null) {
      compareSchema(walk(emit, base, revision, "response", "body", isJson(mediaType)), oldSchema, nextSchema, `response ${status} ${mediaType}`);
    }
  }
  for (const mediaType of Object.keys(nextContent)) if (!Object.hasOwn(oldContent, mediaType)) emit("response-media-type-added", `media type ${mediaType} of response ${status} added`);

  const headers = (spec: Spec, response: JsonObject): Map<string, JsonObject> =>
    new Map(Object.entries(mapping(response["headers"])).map(([name, raw]) => [name.toLowerCase(), deref(spec, raw, `response header ${name}`)]));
  const oldHeaders = headers(base.spec, old);
  const nextHeaders = headers(revision.spec, next);
  for (const [name, header] of oldHeaders) {
    const revised = nextHeaders.get(name);
    const where = `header ${name} of response ${status}`;
    if (revised === undefined) {
      emit(header["required"] === true ? "response-header-required-removed" : "response-header-optional-removed", `${where} removed`);
      continue;
    }
    if (header["required"] === true && revised["required"] !== true) emit("response-header-became-optional", `${where} became optional`);
    const oldSchema = header["schema"] === undefined ? null : toJsonSchema(base.spec, header["schema"]);
    const nextSchema = revised["schema"] === undefined ? null : toJsonSchema(revision.spec, revised["schema"]);
    if (oldSchema !== null && nextSchema !== null) compareSchema(walk(emit, base, revision, "response", "header", false), oldSchema, nextSchema, where);
  }
  for (const name of nextHeaders.keys()) if (!oldHeaders.has(name)) emit("response-header-added", `header ${name} of response ${status} added`);
}

// --- Schemas ----------------------------------------------------------------------

type Direction = "request" | "response";
// body: a media type schema and everything under it; parameter and header: the
// schema of a parameter or a response header, compared at its root only.
type Scope = "body" | "parameter" | "header";

interface Walk {
  emit: Emit;
  direction: Direction;
  scope: Scope;
  stronglyTyped: boolean;
  base: Record<string, JsonSchema>;
  revision: Record<string, JsonSchema>;
  // Pairs of components already compared in this walk: a recursive or shared schema
  // is compared once (schemawalk.Walker.seen).
  seen: Set<string>;
  // The root has allOf on either side: every change in this media type is under the
  // allOf disclaimer (mediaTypeInfo.newChange).
  rootAllOf: boolean;
}

function walk(emit: Emit, base: Side, revision: Side, direction: Direction, scope: Scope, stronglyTyped: boolean): Walk {
  return { emit, direction, scope, stronglyTyped, base: base.schemas, revision: revision.schemas, seen: new Set(), rootAllOf: false };
}

function resolve(schema: JsonSchema, components: Record<string, JsonSchema>): { schema: JsonSchema; ref: string | null } {
  let current = schema;
  let ref: string | null = null;
  const seen = new Set<string>();
  while (isObject(current) && typeof current["$ref"] === "string" && !seen.has(current["$ref"])) {
    ref = current["$ref"];
    seen.add(ref);
    const name = ref.slice(SCHEMAS_REF.length).replaceAll("~1", "/").replaceAll("~0", "~");
    const target = components[decodeURIComponent(name)];
    if (target === undefined) throw new Error(`compat: $ref ${ref} does not resolve`);
    current = target;
  }
  return { schema: current, ref };
}

function hasAllOf(schema: JsonSchema): boolean {
  return isObject(schema) && Array.isArray(schema["allOf"]) && schema["allOf"].length > 0;
}

function compareSchema(w: Walk, base: JsonSchema, revision: JsonSchema, where: string): void {
  const b = resolve(base, w.base).schema;
  const r = resolve(revision, w.revision).schema;
  w.rootAllOf = hasAllOf(b) || hasAllOf(r);
  compareNode(w, base, revision, where, w.rootAllOf, true);
}

// One pair of schemas: the rules of the node, then its children. underAllOf is the
// allOf disclaimer of the walk (the root's allOf, or an allOf branch above).
function compareNode(w: Walk, rawBase: JsonSchema, rawRevision: JsonSchema, where: string, underAllOf: boolean, root: boolean): void {
  const base = resolve(rawBase, w.base);
  const revision = resolve(rawRevision, w.revision);
  if (base.ref !== null || revision.ref !== null) {
    const pair = `${base.ref ?? where}|${revision.ref ?? where}|${underAllOf}`;
    if (w.seen.has(pair)) return;
    w.seen.add(pair);
  }
  const b = base.schema;
  const r = revision.schema;
  const { emit, direction } = w;
  if (direction === "request" && r === false && b !== false) return emit("request-schema-became-false", `${where} became false`, nodeCeiling(w, b, r, underAllOf));
  if (direction === "response" && w.scope === "body" && root && r === false && b !== false) return emit("response-schema-became-false", `${where} became false`, nodeCeiling(w, b, r, underAllOf));
  if (direction === "response" && !(w.scope === "body" && root) && b === false && r !== false) return emit("response-schema-became-not-false", `${where} is no longer false`, nodeCeiling(w, b, r, underAllOf));
  if (!isObject(b) || !isObject(r)) return;
  // Guards: a readOnly property never appears in a request, a writeOnly one in a response.
  const guarded = direction === "request" ? b["readOnly"] === true || r["readOnly"] === true : b["writeOnly"] === true || r["writeOnly"] === true;
  const ceiling = guarded ? "INFO" : nodeCeiling(w, b, r, underAllOf);
  // A oneOf wrapping claims the type change of its node (transition_claims.go).
  const wrapping = w.scope === "body" ? oneOfWrapping(w, b, r) : null;
  if (wrapping !== null && root) {
    const detail = `${where} wrapped in a oneOf of ${wrapping.alternatives} alternatives`;
    if (direction === "request") emit(wrapping.preserved ? "request-body-wrapped-in-one-of-preserved" : "request-body-wrapped-in-one-of", detail, ceiling);
    else emit(wrapping.preserved ? "response-body-wrapped-in-one-of-preserved" : "response-body-wrapped-in-one-of", detail, ceiling);
  }
  if (wrapping === null) compareType(w, b, r, where, ceiling);
  compareEnum(w, b, r, where, ceiling);
  compareConst(w, b, r, where, ceiling);
  compareBounds(w, b, r, where, ceiling);
  compareKeywords(w, b, r, where, ceiling, root);
  if (w.scope !== "body") return;
  compareProperties(w, b, r, where, underAllOf, root, wrapping?.moved ?? []);
  compareSubschemas(w, b, r, where, underAllOf, wrapping !== null, root);
  for (const keyword of ["items", "additionalProperties", "not", "contains", "propertyNames", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties", "contentSchema"]) {
    const old = b[keyword];
    const next = r[keyword];
    if ((isObject(old) || typeof old === "boolean") && (isObject(next) || typeof next === "boolean")) compareNode(w, old, next, `${where}/${keyword}`, underAllOf, false);
  }
  const oldPrefix = Array.isArray(b["prefixItems"]) ? (b["prefixItems"] as JsonSchema[]) : [];
  const nextPrefix = Array.isArray(r["prefixItems"]) ? (r["prefixItems"] as JsonSchema[]) : [];
  for (let index = 0; index < Math.min(oldPrefix.length, nextPrefix.length); index++) {
    compareNode(w, oldPrefix[index]!, nextPrefix[index]!, `${where}/prefixItems[${index}]`, underAllOf, false);
  }
  for (const keyword of ["patternProperties", "dependentSchemas"]) {
    const old = mapping(b[keyword]);
    const next = mapping(r[keyword]);
    for (const [name, schema] of Object.entries(old)) {
      if (Object.hasOwn(next, name)) compareNode(w, schema as JsonSchema, next[name] as JsonSchema, `${where}/${keyword}[${name}]`, underAllOf, false);
    }
  }
}

// diff/one_of_wrapping_diff.go: an object with properties and no oneOf became a oneOf
// with no type or properties of its own, and at least one property moved into an
// alternative. A nullable wrapping (oneOf of a bare null and the base schema) is not
// one (diff/nullable_wrapping_diff.go): it reads as the type change it is.
function oneOfWrapping(w: Walk, b: JsonObject, r: JsonObject): { alternatives: number; moved: string[]; preserved: boolean } | null {
  const properties = Object.keys(mapping(b["properties"]));
  if ((Array.isArray(b["oneOf"]) && b["oneOf"].length > 0) || properties.length === 0) return null;
  const branches = Array.isArray(r["oneOf"]) ? (r["oneOf"] as JsonSchema[]) : [];
  if (branches.length === 0 || Object.keys(mapping(r["properties"])).length > 0 || types(r).length > 0) return null;
  const alternatives = branches.map((branch) => resolve(branch, w.revision).schema);
  const moved = properties.filter((name) => alternatives.some((alternative) => isObject(alternative) && Object.hasOwn(mapping(alternative["properties"]), name)));
  if (moved.length === 0) return null;
  const base = contract(b, w.base);
  const preserved = branches.some((branch) => contract(branch, w.revision) === base);
  const bareNull = (schema: JsonSchema): boolean =>
    isObject(schema) && types(schema).join() === "null" && Object.keys(schema).every((key) => key === "type" || ANNOTATIONS.has(key));
  if (branches.length === 2 && preserved && alternatives.some(bareNull) && !types(b).includes("null")) return null;
  return { alternatives: branches.length, moved, preserved };
}

// The allOf disclaimer caps a node's own changes at WARN (propertyInfo.newChange).
function nodeCeiling(w: Walk, b: JsonSchema, r: JsonSchema, underAllOf: boolean): Level | null {
  return w.scope === "body" && (underAllOf || hasAllOf(b) || hasAllOf(r)) ? "WARN" : null;
}

function types(schema: JsonObject): string[] {
  const type = schema["type"];
  if (typeof type === "string") return [type];
  return Array.isArray(type) ? type.filter((entry): entry is string => typeof entry === "string") : [];
}

// isSubtype: the same type, or integer within number.
function isSubtype(sub: string, sup: string): boolean {
  return sub === sup || (sub === "integer" && sup === "number");
}

// isTypeSetSubset: sub is non-empty and each of its types is covered by sup.
function isTypeSetSubset(sub: string[], sup: string[]): boolean {
  return sub.length > 0 && sub.every((type) => sup.some((other) => isSubtype(type, other)));
}

// isTypeContained: the new type `to` still accepts every value of the old `from`.
function isTypeContained(to: string[], from: string[], stronglyTyped: boolean): boolean {
  if (to.length === 1 && from.length === 1 && isSubtype(from[0]!, to[0]!)) return true;
  if (!stronglyTyped) return to.length === 0 || (to.length === 1 && to[0] === "string");
  return false;
}

// isFormatContained: the format `to` accepts every value of `from`, for the type `type`.
function isFormatContained(type: string[], to: string, from: string): boolean {
  if (to === "") return true;
  if (type.length !== 1) return false;
  if (type[0] === "number") return to === "double" && from === "float";
  if (type[0] === "integer") return (to === "int64" && from === "int32") || (to === "bigint" && (from === "int32" || from === "int64"));
  return false;
}

function difference(a: string[], b: string[]): string[] {
  return a.filter((entry) => !b.includes(entry));
}

// requestTypeFormatBreaking and responseTypeFormatBreaking (check_types.go). A null
// type is one more type, which also covers the nullability checks.
function compareType(w: Walk, b: JsonObject, r: JsonObject, where: string, ceiling: Level | null): void {
  const oldTypes = types(b);
  const nextTypes = types(r);
  const typeChanged = difference(oldTypes, nextTypes).length > 0 || difference(nextTypes, oldTypes).length > 0;
  const oldFormat = typeof b["format"] === "string" ? b["format"] : "";
  const nextFormat = typeof r["format"] === "string" ? r["format"] : "";
  if (!typeChanged && oldFormat === nextFormat) return;
  // Requests are judged toward the revision type, responses toward the base type.
  const [from, to, fromFormat, toFormat] = w.direction === "request" ? [oldTypes, nextTypes, oldFormat, nextFormat] : [nextTypes, oldTypes, nextFormat, oldFormat];
  // A widening (request) or a narrowing (response) of the type set drops the type axis.
  const typeAxis = typeChanged && !isTypeSetSubset(from, to);
  let breaking: boolean;
  if (typeAxis && to.length === 0) breaking = false;
  else {
    const typeBreaking = typeAxis && !isTypeContained(difference(to, from), difference(from, to), w.stronglyTyped);
    const formatBreaking = oldFormat !== nextFormat && !isFormatContained(to, toFormat, fromFormat);
    breaking = typeBreaking || formatBreaking;
  }
  const detail = `type/format of ${where} changed from ${typeFormat(oldTypes, oldFormat)} to ${typeFormat(nextTypes, nextFormat)}`;
  if (w.direction === "request") w.emit(breaking ? "request-type-changed" : "request-type-generalized", detail, ceiling);
  else w.emit(breaking ? "response-type-changed" : "response-type-specialized", detail, ceiling);
}

function typeFormat(type: string[], format: string): string {
  const shown = type.length === 0 ? "any" : type.join(", ");
  return format === "" ? shown : `${shown}/${format}`;
}

// Canonical JSON with sorted keys, to compare enum and const values.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function compareEnum(w: Walk, b: JsonObject, r: JsonObject, where: string, ceiling: Level | null): void {
  if (w.direction === "response" && w.scope === "header") return;
  const values = (schema: JsonObject): string[] | null => (Array.isArray(schema["enum"]) && schema["enum"].length > 0 ? schema["enum"].map(canonical) : null);
  const old = values(b);
  const next = values(r);
  if (old === null && next === null) return;
  if (w.direction === "request") {
    if (old === null) return w.emit("request-became-enum", `${where} became an enum`, ceiling);
    if (next === null) return w.emit("request-became-not-enum", `${where} is no longer an enum`, ceiling);
    for (const value of difference(old, next)) w.emit("request-enum-value-removed", `enum value ${value} removed from ${where}`, ceiling);
    for (const value of difference(next, old)) w.emit("request-enum-value-added", `enum value ${value} added to ${where}`, ceiling);
    return;
  }
  if (next === null) return w.emit("response-became-not-enum", `${where} is no longer an enum`, ceiling);
  if (old === null) return w.emit("response-became-enum", `${where} became an enum`, ceiling);
  for (const value of difference(next, old)) w.emit("response-enum-value-added", `enum value ${value} added to ${where}`, ceiling);
  for (const value of difference(old, next)) w.emit("response-enum-value-removed", `enum value ${value} removed from ${where}`, ceiling);
}

function compareConst(w: Walk, b: JsonObject, r: JsonObject, where: string, ceiling: Level | null): void {
  if (w.scope !== "body") return;
  const old = b["const"] === undefined ? null : canonical(b["const"]);
  const next = r["const"] === undefined ? null : canonical(r["const"]);
  if (old === next) return;
  const detail = `const of ${where} changed from ${old ?? "none"} to ${next ?? "none"}`;
  if (w.direction === "request") w.emit(next === null ? "request-const-removed" : "request-const-changed", detail, ceiling);
  else w.emit(old === null ? "response-const-added" : "response-const-changed", detail, ceiling);
}

// boundSpecs of bound_rules.go: which side of the range each keyword bounds.
const BOUNDS: [string, "upper" | "lower"][] = [
  ["maximum", "upper"],
  ["minimum", "lower"],
  ["maxLength", "upper"],
  ["minLength", "lower"],
  ["maxItems", "upper"],
  ["minItems", "lower"],
  ["maxProperties", "upper"],
  ["minProperties", "lower"],
  ["maxContains", "upper"],
  ["minContains", "lower"],
  ["exclusiveMaximum", "upper"],
  ["exclusiveMinimum", "lower"],
];

function compareBounds(w: Walk, b: JsonObject, r: JsonObject, where: string, ceiling: Level | null): void {
  const number = (value: unknown): number | null => (typeof value === "number" ? value : null);
  for (const [keyword, polarity] of BOUNDS) {
    const old = number(b[keyword]);
    const next = number(r[keyword]);
    if (old === next) continue;
    // Setting a bound narrows and unsetting it widens; otherwise its polarity decides.
    const narrows = old === null || (next !== null && (polarity === "lower" ? next > old : next < old));
    const detail = `${keyword} of ${where} changed from ${old ?? "none"} to ${next ?? "none"}`;
    if (w.direction === "request") w.emit(narrows ? "request-bound-narrowed" : "request-bound-widened", detail, ceiling);
    else w.emit(narrows ? "response-bound-narrowed" : "response-bound-widened", detail, ceiling);
  }
  const oldMultiple = number(b["multipleOf"]);
  const nextMultiple = number(r["multipleOf"]);
  if (oldMultiple !== nextMultiple) {
    const detail = `multipleOf of ${where} changed from ${oldMultiple ?? "none"} to ${nextMultiple ?? "none"}`;
    // Parameters only have the set cell, response headers only the unset one.
    const breaking =
      w.direction === "request"
        ? nextMultiple !== null && (oldMultiple === null || w.scope !== "parameter")
        : oldMultiple !== null && (nextMultiple === null || w.scope !== "header");
    w.emit(breaking ? (w.direction === "request" ? "request-multiple-of-changed" : "response-multiple-of-changed") : "multiple-of-relaxed", detail, ceiling);
  }
  if (w.scope === "body") {
    if (w.direction === "request" && b["uniqueItems"] !== true && r["uniqueItems"] === true) w.emit("request-unique-items-set", `${where} requires unique items now`, ceiling);
    if (w.direction === "response" && b["uniqueItems"] === true && r["uniqueItems"] !== true) w.emit("response-unique-items-unset", `${where} no longer has unique items`, ceiling);
  }
}

const PRESENCE_KEYWORDS = ["contains", "if", "then", "else", "propertyNames", "unevaluatedItems", "unevaluatedProperties", "contentSchema"];
const KEYED_KEYWORDS = ["dependentRequired", "dependentSchemas", "patternProperties"];
const VALUE_KEYWORDS = ["contentEncoding", "contentMediaType"];

// Keywords that constrain a value only by being there: adding one narrows a request
// and removing one widens a response. The pattern rules exist for properties and
// parameters, not for a body root.
function compareKeywords(w: Walk, b: JsonObject, r: JsonObject, where: string, ceiling: Level | null, root: boolean): void {
  const oldPattern = typeof b["pattern"] === "string" ? b["pattern"] : null;
  const nextPattern = typeof r["pattern"] === "string" ? r["pattern"] : null;
  if (oldPattern !== nextPattern && !(w.scope === "body" && root)) {
    const detail = `pattern of ${where} changed from ${oldPattern ?? "none"} to ${nextPattern ?? "none"}`;
    if (w.direction === "request") {
      if (oldPattern === null) w.emit("request-pattern-added", detail, ceiling);
      else if (nextPattern !== null) w.emit("request-pattern-changed", detail, ceiling);
    } else if (w.scope === "body") {
      if (nextPattern === null) w.emit("response-pattern-removed", detail, ceiling);
      else if (oldPattern !== null) w.emit("response-pattern-changed", detail, ceiling);
    }
  }
  if (w.scope !== "body") return;
  const added = w.direction === "request" ? "request-keyword-added" : "response-keyword-added";
  const removed = w.direction === "request" ? "request-keyword-removed" : "response-keyword-removed";
  const changed = w.direction === "request" ? "request-keyword-added" : "response-keyword-removed";
  for (const keyword of PRESENCE_KEYWORDS) {
    if (b[keyword] === undefined && r[keyword] !== undefined) w.emit(added, `${keyword} added to ${where}`, ceiling);
    if (b[keyword] !== undefined && r[keyword] === undefined) w.emit(removed, `${keyword} removed from ${where}`, ceiling);
  }
  for (const keyword of KEYED_KEYWORDS) {
    const old = mapping(b[keyword]);
    const next = mapping(r[keyword]);
    for (const name of Object.keys(next)) if (!Object.hasOwn(old, name)) w.emit(added, `${keyword} ${name} added to ${where}`, ceiling);
    for (const name of Object.keys(old)) {
      if (!Object.hasOwn(next, name)) w.emit(removed, `${keyword} ${name} removed from ${where}`, ceiling);
      else if (keyword === "dependentRequired" && canonical(old[name]) !== canonical(next[name])) w.emit(changed, `${keyword} ${name} of ${where} changed`, ceiling);
    }
  }
  for (const keyword of VALUE_KEYWORDS) {
    if (b[keyword] !== r[keyword]) w.emit(changed, `${keyword} of ${where} changed from ${String(b[keyword] ?? "none")} to ${String(r[keyword] ?? "none")}`, ceiling);
  }
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

// moved: properties that went into the alternatives of a oneOf wrapping, which are not
// removed from the contract (oasdiff#702).
function compareProperties(w: Walk, b: JsonObject, r: JsonObject, where: string, underAllOf: boolean, root: boolean, moved: string[]): void {
  const old = mapping(b["properties"]);
  const next = mapping(r["properties"]);
  const oldRequired = list(b["required"]);
  const nextRequired = list(r["required"]);
  const property = (schema: unknown, components: Record<string, JsonSchema>): JsonObject => {
    const resolved = resolve(schema as JsonSchema, components).schema;
    return isObject(resolved) ? resolved : {};
  };
  // Added and removed properties carry the allOf disclaimer of the walk only; a change
  // of `required` in a request carries the root's (check_request_property_required_updated.go),
  // in a response the node's (check_response_property_became_optional.go).
  const walkCeiling = underAllOf ? "WARN" : null;
  const rootCeiling = w.rootAllOf ? "WARN" : null;
  const nodeCeil = nodeCeiling(w, b, r, underAllOf);
  const { emit } = w;
  for (const name of Object.keys(next)) {
    if (Object.hasOwn(old, name)) continue;
    const added = property(next[name], w.revision);
    const at = `${where}/${name}`;
    if (w.direction === "request") {
      if (added["readOnly"] === true) continue;
      emit(nextRequired.includes(name) ? "request-property-added-required" : "request-property-added-optional", `property ${at} added`, walkCeiling);
    } else emit("response-property-added", `property ${at} added`, walkCeiling);
  }
  for (const name of Object.keys(old)) {
    if (Object.hasOwn(next, name) || moved.includes(name)) continue;
    const removed = property(old[name], w.base);
    const at = `${where}/${name}`;
    if (w.direction === "request") {
      if (removed["readOnly"] === true) continue;
      emit(removed["deprecated"] === true ? "request-property-removed-after-deprecation" : "request-property-removed", `property ${at} removed`, walkCeiling);
    } else if (oldRequired.includes(name)) {
      const after = removed["writeOnly"] === true || removed["deprecated"] === true;
      emit(after ? "response-required-property-removed-after-deprecation" : "response-required-property-removed", `required property ${at} removed`, walkCeiling);
    } else emit("response-optional-property-removed", `optional property ${at} removed`, walkCeiling);
  }
  for (const name of Object.keys(old)) {
    if (!Object.hasOwn(next, name)) continue;
    const oldProperty = property(old[name], w.base);
    const nextProperty = property(next[name], w.revision);
    const at = `${where}/${name}`;
    const wasRequired = oldRequired.includes(name);
    const isRequired = nextRequired.includes(name);
    if (w.direction === "request") {
      if (nextProperty["readOnly"] !== true && !wasRequired && isRequired) emit("request-property-became-required", `property ${at} became required`, rootCeiling);
      if (nextProperty["readOnly"] !== true && wasRequired && !isRequired) emit("request-property-became-optional", `property ${at} became optional`, rootCeiling);
      if (isRequired && oldProperty["readOnly"] === true && nextProperty["readOnly"] !== true) {
        emit("request-required-property-became-not-read-only", `required property ${at} is no longer readOnly`, nodeCeil);
      }
    } else {
      // A writeOnly property never appears in a response: its change is INFO.
      if (wasRequired && !isRequired) emit("response-property-became-optional", `property ${at} became optional`, oldProperty["writeOnly"] === true ? "INFO" : nodeCeil);
      if (!wasRequired && isRequired) emit("response-property-became-required", `property ${at} became required`, nodeCeil);
      if (isRequired && oldProperty["writeOnly"] !== true && nextProperty["writeOnly"] === true) {
        emit("response-required-property-became-write-only", `required property ${at} became writeOnly`, nodeCeil);
      }
    }
    compareNode(w, old[name] as JsonSchema, next[name] as JsonSchema, at, underAllOf, false);
  }
}

// The annotations that do not change what a schema validates (diff: validation contract).
const ANNOTATIONS = new Set(["title", "description", "default", "examples", "example", "$comment", "externalDocs"]);

function contract(schema: JsonSchema, components: Record<string, JsonSchema>): string {
  const resolved = resolve(schema, components).schema;
  if (!isObject(resolved)) return canonical(resolved);
  return canonical(Object.fromEntries(Object.entries(resolved).filter(([key]) => !ANNOTATIONS.has(key))));
}

// Pairs the branches of oneOf, anyOf or allOf as diff/subschemas_diff.go does: $refs
// by name; inline schemas when identical, by title, by validation contract, or as the
// last unmatched pair; then (anyOf and oneOf) an inline schema and a $ref with the
// same validation contract.
function matchBranches(w: Walk, old: JsonSchema[], next: JsonSchema[], keyword: string): { pairs: [JsonSchema, JsonSchema][]; added: number; removed: number } {
  const pairs: [JsonSchema, JsonSchema][] = [];
  const oldLeft = new Set(old.keys());
  const nextLeft = new Set(next.keys());
  const ref = (schema: JsonSchema): string | null => (isObject(schema) && typeof schema["$ref"] === "string" ? schema["$ref"] : null);
  const pair = (i: number, j: number): void => {
    pairs.push([old[i]!, next[j]!]);
    oldLeft.delete(i);
    nextLeft.delete(j);
  };
  const matchBy = (inlineOnly: boolean, same: (a: JsonSchema, b: JsonSchema) => boolean): void => {
    for (const i of [...oldLeft]) {
      if (inlineOnly && ref(old[i]!) !== null) continue;
      for (const j of nextLeft) {
        if (inlineOnly && ref(next[j]!) !== null) continue;
        if (same(old[i]!, next[j]!)) {
          pair(i, j);
          break;
        }
      }
    }
  };
  matchBy(false, (a, b) => ref(a) !== null && ref(a) === ref(b));
  matchBy(true, (a, b) => canonical(a) === canonical(b));
  const title = (schema: JsonSchema): unknown => (isObject(schema) ? schema["title"] : undefined);
  matchBy(true, (a, b) => title(a) !== undefined && title(a) === title(b));
  matchBy(true, (a, b) => title(a) === undefined && title(b) === undefined && contract(a, w.base) === contract(b, w.revision));
  const oldInline = [...oldLeft].filter((i) => ref(old[i]!) === null && title(old[i]!) === undefined);
  const nextInline = [...nextLeft].filter((j) => ref(next[j]!) === null && title(next[j]!) === undefined);
  if (oldInline.length === 1 && nextInline.length === 1) pair(oldInline[0]!, nextInline[0]!);
  if (keyword !== "allOf") matchBy(false, (a, b) => (ref(a) === null) !== (ref(b) === null) && contract(a, w.base) === contract(b, w.revision));
  return { pairs, added: nextLeft.size, removed: oldLeft.size };
}

// wrapped: the node is a oneOf wrapping, which claims its structure changes; below the
// body root the oneOf added is the change that reports it (transition_claims.go).
function compareSubschemas(w: Walk, b: JsonObject, r: JsonObject, where: string, underAllOf: boolean, wrapped: boolean, root: boolean): void {
  const ceiling = nodeCeiling(w, b, r, underAllOf);
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    const old = Array.isArray(b[keyword]) ? (b[keyword] as JsonSchema[]) : [];
    const next = Array.isArray(r[keyword]) ? (r[keyword] as JsonSchema[]) : [];
    if (old.length === 0 && next.length === 0) continue;
    const { pairs, added, removed } = matchBranches(w, old, next, keyword);
    pairs.forEach(([old, next], index) => compareNode(w, old, next, `${where}/${keyword}[${index}]`, underAllOf || keyword === "allOf", false));
    if (wrapped && (root || keyword !== "oneOf")) continue;
    // Narrowing a request: a oneOf/anyOf branch removed, an allOf branch added (which
    // never carries the allOf disclaimer). Widening a response: the mirror.
    const request = w.direction === "request";
    if (removed > 0) {
      const detail = `${removed} ${keyword} branch(es) removed from ${where}`;
      if (keyword === "allOf") w.emit(request ? "request-subschema-relaxed" : "response-all-of-removed", detail, ceiling);
      else w.emit(request ? (keyword === "oneOf" ? "request-one-of-removed" : "request-any-of-removed") : "response-subschema-narrowed", detail, ceiling);
    }
    if (added > 0) {
      const detail = `${added} ${keyword} branch(es) added to ${where}`;
      if (keyword === "allOf") w.emit(request ? "request-all-of-added" : "response-subschema-narrowed", detail, request ? null : ceiling);
      else w.emit(request ? "request-subschema-relaxed" : keyword === "oneOf" ? "response-one-of-added" : "response-any-of-added", detail, ceiling);
    }
  }
}
