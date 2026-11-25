// Persistent release queue (vault/CONTRACT.md §10): the `jobs` table in a SQLite file
// opened with node:sqlite in WAL mode. Every function commits before it returns, so a
// SIGKILL right after a call never loses the transition it made.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// The points of §9.3, in order. `step` holds the last one a job confirmed.
export const POINTS = ["enqueued", "claimed", "versioned", "built", "npm_published", "pypi_published", "go_published", "before_complete"] as const;
export type Point = (typeof POINTS)[number];

export type State = "queued" | "running" | "done" | "failed";

export interface Job {
  id: number;
  state: State;
  version: string | null;
  created_at: string;
  updated_at: string;
  step: Point;
  error: string | null;
}

export interface Counts {
  enqueued: number;
  completed: number;
  failed: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  step TEXT NOT NULL,
  error TEXT
)`;

export class Queue {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // Inserts a queued job and runs `prepare(id)` inside the same transaction, so the job
  // only exists once whatever `prepare` writes for it is complete. A job id rolled back
  // by a crash is reused by the next insert (no AUTOINCREMENT), and `prepare` must
  // overwrite what a previous attempt left for that id.
  enqueue(prepare: (id: number) => void): Job {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const job = this.one("INSERT INTO jobs (state, version, created_at, updated_at, step, error) VALUES ('queued', NULL, ?, ?, 'enqueued', NULL) RETURNING *", now, now)!;
      prepare(job.id);
      this.db.exec("COMMIT");
      return job;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // The oldest job left running by a previous process, if any.
  running(): Job | null {
    return this.one("SELECT * FROM jobs WHERE state = 'running' ORDER BY id LIMIT 1");
  }

  // Moves the oldest queued job to running at the `claimed` point.
  claim(): Job | null {
    return this.one(
      "UPDATE jobs SET state = 'running', step = 'claimed', updated_at = ? WHERE id = (SELECT id FROM jobs WHERE state = 'queued' ORDER BY id LIMIT 1) RETURNING *",
      new Date().toISOString(),
    );
  }

  // Confirms that a running job reached `step`, with its version once it has one.
  advance(id: number, step: Point, version?: string): Job {
    const job =
      version === undefined
        ? this.one("UPDATE jobs SET step = ?, updated_at = ? WHERE id = ? AND state = 'running' RETURNING *", step, new Date().toISOString(), id)
        : this.one("UPDATE jobs SET step = ?, version = ?, updated_at = ? WHERE id = ? AND state = 'running' RETURNING *", step, version, new Date().toISOString(), id);
    if (job === null) throw new Error(`job ${id} is not running`);
    return job;
  }

  complete(id: number): Job {
    const job = this.one("UPDATE jobs SET state = 'done', updated_at = ? WHERE id = ? AND state = 'running' RETURNING *", new Date().toISOString(), id);
    if (job === null) throw new Error(`job ${id} is not running`);
    return job;
  }

  fail(id: number, error: string): Job {
    const job = this.one("UPDATE jobs SET state = 'failed', error = ?, updated_at = ? WHERE id = ? AND state = 'running' RETURNING *", error, new Date().toISOString(), id);
    if (job === null) throw new Error(`job ${id} is not running`);
    return job;
  }

  // The last job that published a release, whose version the next one bumps.
  lastDone(): Job | null {
    return this.one("SELECT * FROM jobs WHERE state = 'done' ORDER BY id DESC LIMIT 1");
  }

  list(): Job[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY id").all() as unknown as Job[];
  }

  counts(): Counts {
    const row = this.db
      .prepare("SELECT count(*) AS enqueued, coalesce(sum(state = 'done'), 0) AS completed, coalesce(sum(state = 'failed'), 0) AS failed FROM jobs")
      .get() as unknown as Counts;
    return { enqueued: Number(row.enqueued), completed: Number(row.completed), failed: Number(row.failed) };
  }

  private one(sql: string, ...params: SQLInputValue[]): Job | null {
    return (this.db.prepare(sql).get(...params) as unknown as Job | undefined) ?? null;
  }
}
