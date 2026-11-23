import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { differences, normalize, type RawRequest } from "./normalize.ts";

const KEY = "Bearer re_paridad_test_9f8e7d6c5b4a39281706";

function raw(overrides: Partial<RawRequest> & { body?: string | Buffer }): RawRequest {
  const { body = "", ...rest } = overrides;
  return {
    method: "GET",
    target: "/domains",
    headers: [],
    body_b64: Buffer.from(body).toString("base64"),
    ...rest,
  };
}

test("method is upper-cased", () => {
  assert.equal(normalize(raw({ method: "post" })).method, "POST");
});

test("path is the target before ? with percent-decoding", () => {
  assert.equal(normalize(raw({ target: "/contacts/steve%40example.com/a%2Fb%20c?x=1" })).path, "/contacts/steve@example.com/a/b c");
  // A malformed sequence is kept as received.
  assert.equal(normalize(raw({ target: "/contacts/%E0%A4%A" })).path, "/contacts/%E0%A4%A");
});

test("query is form-decoded and sorted by key and then value", () => {
  assert.deepEqual(normalize(raw({ target: "/contacts?limit=2&after=b&after=a&q=a+b%21&empty=" })).query, [
    ["after", "a"],
    ["after", "b"],
    ["empty", ""],
    ["limit", "2"],
    ["q", "a b!"],
  ]);
  assert.deepEqual(normalize(raw({ target: "/contacts" })).query, []);
});

test("only authorization, content-type and idempotency-key count, lower-cased and trimmed", () => {
  const normalized = normalize(
    raw({
      method: "POST",
      target: "/emails",
      headers: [
        ["User-Agent", "paridad-ts/0.0.0-dev"],
        ["Accept", "application/json"],
        ["Accept-Encoding", "gzip"],
        ["Content-Length", "2"],
        ["Host", "127.0.0.1"],
        ["Connection", "keep-alive"],
        ["X-Other", "1"],
        ["Authorization", `  ${KEY} `],
        ["Idempotency-Key", " welcome-user-123 "],
        ["Content-Type", "Application/JSON; charset=utf-8"],
      ],
      body: "{}",
    }),
  );
  assert.deepEqual(normalized.headers, {
    authorization: KEY,
    "content-type": "application/json",
    "idempotency-key": "welcome-user-123",
  });
});

test("content-type counts only when there is a body", () => {
  const headers: [string, string][] = [
    ["authorization", KEY],
    ["content-type", "application/json"],
  ];
  assert.deepEqual(normalize(raw({ headers })).headers, { authorization: KEY });
  assert.deepEqual(normalize(raw({ method: "POST", headers, body: "{}" })).headers, {
    authorization: KEY,
    "content-type": "application/json",
  });
});

test("an empty body is null", () => {
  assert.equal(normalize(raw({ headers: [["content-type", "application/json"]] })).body, null);
});

test("a JSON body is re-serialized with sorted keys, no whitespace and integral numbers as integers", () => {
  const body = '{ "b": 1.0, "a": [2.50, 3e0, -0.0, 1e21, "x"], "c": { "z": 1, "y": null, "x": true } }';
  const normalized = normalize(raw({ method: "POST", headers: [["content-type", "application/json"]], body }));
  assert.equal(normalized.body, '{"a":[2.5,3,0,1000000000000000000000,"x"],"b":1,"c":{"x":true,"y":null,"z":1}}');
});

test("a body that is not JSON is the sha256 of its bytes", () => {
  const bytes = Buffer.from([0x68, 0x69, 0x00, 0xff]);
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(normalize(raw({ method: "POST", headers: [["content-type", "text/plain"]], body: bytes })).body, hash);
  assert.equal(normalize(raw({ method: "POST", body: bytes })).body, hash);
  // Declared JSON that does not parse is hashed too.
  const broken = Buffer.from("{not json");
  assert.equal(
    normalize(raw({ method: "POST", headers: [["content-type", "application/json"]], body: broken })).body,
    `sha256:${createHash("sha256").update(broken).digest("hex")}`,
  );
});

test("differences lists the difference fields that differ", () => {
  const a = normalize(
    raw({
      method: "POST",
      target: "/emails?b=1&a=2",
      headers: [
        ["authorization", KEY],
        ["content-type", "application/json"],
        ["user-agent", "resend-node"],
      ],
      body: '{"to":"a@b.com","n":1.0}',
    }),
  );
  const same = normalize(
    raw({
      method: "post",
      target: "/emails?a=2&b=1",
      headers: [
        ["Content-Type", "application/json; charset=utf-8"],
        ["Authorization", KEY],
        ["User-Agent", "paridad-ts"],
      ],
      body: '{"n":1,"to":"a@b.com"}',
    }),
  );
  assert.deepEqual(differences(a, same), []);
  const other = normalize(
    raw({
      method: "PATCH",
      target: "/emails/x?a=3",
      headers: [
        ["authorization", "Bearer other"],
        ["idempotency-key", "k"],
      ],
      body: "",
    }),
  );
  assert.deepEqual(differences(a, other), [
    "method",
    "path",
    "query",
    "header:authorization",
    "header:content-type",
    "header:idempotency-key",
    "body",
  ]);
});
