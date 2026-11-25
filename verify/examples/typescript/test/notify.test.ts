import assert from "node:assert/strict";
import { test } from "node:test";
import { client, domainCount, emailId, sendWelcome } from "../src/notify.ts";

const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

test("sends a welcome email", async () => {
  const id = await sendWelcome(client(), "delivered@resend.dev");
  assert.equal(typeof id, "string");
});

test("reads an email", async () => {
  assert.equal(typeof (await emailId(client(), EMAIL_ID)), "string");
});

test("counts the domains of a page", async () => {
  assert.ok((await domainCount(client())) >= 0);
});
