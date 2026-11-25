// The pieces of C16, C17 and C24: the map of the official CLI, the extractor of the
// examples of the documentation, the checker of its internal links and the templates
// of React Email.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DOC_LANGUAGES, MIN_OFFICIAL_PAIRS, TEMPLATES, brokenLinks, docExamples, officialMapProblems, readOfficialMap, renderTemplate } from "./cli-docs-email.ts";

const ROOT = resolve(import.meta.dirname, "..");

test("the map of the official CLI has at least 20 pairs with unique ids, successes and forced errors", () => {
  const pairs = readOfficialMap(readFileSync(join(ROOT, "verify/official-cli-map.json"), "utf8"));
  assert.ok(pairs.length >= MIN_OFFICIAL_PAIRS, `${pairs.length} pairs`);
  assert.equal(new Set(pairs.map((pair) => pair.id)).size, pairs.length);
  assert.deepEqual(officialMapProblems(pairs), []);
  assert.ok(pairs.some((pair) => pair.respond !== undefined));
  assert.ok(pairs.some((pair) => pair.respond === undefined));
});

test("the map checker flags a repeated id and too few pairs", () => {
  const pair = { id: "domains-list", ours: ["domains", "list"], official: ["domains", "list"] };
  assert.deepEqual(officialMapProblems([pair, pair]), ["2 pairs, at least 20 needed", "domains-list is listed twice"]);
});

const SAMPLE_PAGE = `<!DOCTYPE html>
<html lang="es"><head><title>emails</title></head><body><main>
${["emails/get", "emails/send"]
  .map(
    (id) => `<section id="${id}" data-operation-id="${id}">
<h2><code>${id}</code></h2>
<pre><code class="language-typescript" data-operation-id="${id}">import { Resend } from &quot;paridad-resend&quot;;
const a = 1 &lt; 2 &amp;&amp; 3 &gt; 2;
</code></pre>
<pre><code class="language-python" data-operation-id="${id}">print(&quot;ok&quot;)
</code></pre>
<pre><code class="language-go" data-operation-id="${id}">package main
</code></pre>
<pre><code class="language-bash" data-operation-id="${id}">paridad emails get --email-id 1
</code></pre>
</section>`,
  )
  .join("\n")}
</main></body></html>
`;

test("the extractor finds the four examples of each operation of a page and undoes the escapes", () => {
  const examples = docExamples(SAMPLE_PAGE);
  assert.equal(examples.length, 8);
  for (const id of ["emails/get", "emails/send"]) {
    assert.deepEqual(
      examples.filter((example) => example.operation === id).map((example) => example.language),
      [...DOC_LANGUAGES],
    );
  }
  assert.equal(examples[0]!.code, 'import { Resend } from "paridad-resend";\nconst a = 1 < 2 && 3 > 2;\n');
});

test("the link checker finds a broken page link and a broken fragment, and accepts the rest", () => {
  const pages = new Map([
    ["index.html", '<a href="emails.html">emails</a> <a href="emails.html#emails/get">get</a> <a href="missing.html">x</a> <a href="https://resend.com">resend</a>'],
    ["emails.html", '<a href="index.html">index</a> <section id="emails/get"></section> <a href="#emails/get">get</a> <a href="#emails/none">none</a>'],
  ]);
  assert.deepEqual(brokenLinks(pages), [
    { file: "index.html", href: "missing.html" },
    { file: "emails.html", href: "#emails/none" },
  ]);
});

for (const name of TEMPLATES) {
  test(`the React Email template ${name} renders without error`, async () => {
    const html = await renderTemplate(name);
    assert.match(html, /^<!DOCTYPE html/);
    if (name === "receipt") {
      assert.match(html, /<table/);
      assert.match(html, /<img/);
    }
  });
}
