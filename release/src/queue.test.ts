import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Queue } from "./queue.ts";

const dir = mkdtempSync(join(tmpdir(), "paridad-queue-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
function queueFile(): string {
  return join(dir, `queue-${++files}.sqlite`);
}

test("the queue file is in WAL mode", () => {
  const queue = new Queue(queueFile());
  const row = queue.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(row.journal_mode, "wal");
  queue.close();
});

test("a job goes from queued through running to done", () => {
  const queue = new Queue(queueFile());
  const job = queue.enqueue(() => {});
  assert.equal(job.state, "queued");
  assert.equal(job.step, "enqueued");
  assert.equal(job.version, null);

  const claimed = queue.claim();
  assert.equal(claimed?.id, job.id);
  assert.equal(claimed?.state, "running");
  assert.equal(claimed?.step, "claimed");
  assert.equal(queue.claim(), null, "a running job is not claimed again");

  const versioned = queue.advance(job.id, "versioned", "0.1.0");
  assert.equal(versioned.version, "0.1.0");
  assert.equal(queue.advance(job.id, "built").version, "0.1.0", "advancing without a version keeps it");
  const done = queue.complete(job.id);
  assert.equal(done.state, "done");
  assert.equal(done.step, "built");
  assert.deepEqual(queue.lastDone(), done);
  assert.throws(() => queue.advance(job.id, "npm_published"), /not running/);
  queue.close();
});

test("a failed job keeps its error and stops counting as running", () => {
  const queue = new Queue(queueFile());
  const job = queue.enqueue(() => {});
  queue.claim();
  const failed = queue.fail(job.id, "npm paridad-resend@0.1.0 is already published");
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "npm paridad-resend@0.1.0 is already published");
  assert.equal(queue.running(), null);
  assert.equal(queue.lastDone(), null);
  assert.throws(() => queue.complete(job.id), /not running/);
  queue.close();
});

test("jobs are claimed oldest first", () => {
  const queue = new Queue(queueFile());
  const first = queue.enqueue(() => {});
  const second = queue.enqueue(() => {});
  assert.equal(queue.claim()?.id, first.id);
  queue.complete(first.id);
  assert.equal(queue.claim()?.id, second.id);
  queue.close();
});

test("a job whose preparation throws is not enqueued, and its id is reused", () => {
  const queue = new Queue(queueFile());
  const marker = join(dir, "prepared");
  let attempted = 0;
  assert.throws(
    () =>
      queue.enqueue((id) => {
        attempted = id;
        writeFileSync(marker, "half");
        throw new Error("snapshot failed");
      }),
    /snapshot failed/,
  );
  assert.equal(queue.list().length, 0);
  const job = queue.enqueue(() => {});
  assert.equal(job.id, attempted);
  assert.ok(existsSync(marker));
  queue.close();
});

test("a running job and its confirmed step survive reopening the file", () => {
  const file = queueFile();
  const first = new Queue(file);
  const job = first.enqueue(() => {});
  first.claim();
  first.advance(job.id, "npm_published", "0.2.0");
  // No close: the state must already be on disk, as after a SIGKILL.
  const second = new Queue(file);
  const running = second.running();
  assert.equal(running?.id, job.id);
  assert.equal(running?.step, "npm_published");
  assert.equal(running?.version, "0.2.0");
  second.close();
  first.close();
});

test("the counts follow the states of the table", () => {
  const queue = new Queue(queueFile());
  for (let i = 0; i < 4; i++) queue.enqueue(() => {});
  queue.complete(queue.claim()!.id);
  queue.fail(queue.claim()!.id, "boom");
  queue.claim();
  assert.deepEqual(queue.counts(), { enqueued: 4, completed: 1, failed: 1 });
  assert.deepEqual(
    queue.list().map((job) => job.state),
    ["done", "failed", "running", "queued"],
  );
  queue.close();
});
