// `prism proxy --errors` (Prism 5.16.0, root dev dependency) in front of the capture
// server for C8, and the reading of its log: request violations and forwarded
// requests (contract §2, §9 C8).
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PRISM = join(ROOT, "node_modules/.bin/prism");
// Markers of a request violation in the log of C8.
export const VIOLATION_MARKERS = ["✖", "UNPROCESSABLE_ENTITY", "Violation: request"];
// Time Prism has to start listening, and to exit after SIGTERM.
const START_LIMIT_MS = 120_000;
const STOP_GRACE_MS = 10_000;

// Colors are removed so the markers match whatever the terminal settings are.
function plain(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

// Lines of the log with a violation marker.
export function violationLines(log: string): string[] {
  return log
    .split("\n")
    .map(plain)
    .filter((line) => VIOLATION_MARKERS.some((marker) => line.includes(marker)));
}

// Number of `> Forwarding` lines: requests Prism passed to the upstream.
export function forwardedCount(log: string): number {
  return log
    .split("\n")
    .map(plain)
    .filter((line) => line.includes("> Forwarding")).length;
}

export interface Prism {
  url: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

// Starts `prism proxy --errors spec/resend.yaml <upstream>` on 127.0.0.1 and resolves
// when it listens. Its stdout and stderr go, as they arrive, to the log file.
export async function startPrism(upstream: string, log: string): Promise<Prism> {
  const port = await freePort();
  const file = createWriteStream(log);
  const child = spawn(PRISM, ["proxy", "--errors", "-h", "127.0.0.1", "-p", String(port), "spec/resend.yaml", upstream], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((done) => child.on("close", () => done()));
  let seen = "";
  const listening = new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`prism did not listen within ${START_LIMIT_MS} ms; see ${log}`)), START_LIMIT_MS);
    const watch = (chunk: Buffer): void => {
      file.write(chunk);
      seen += plain(chunk.toString("utf8"));
      if (seen.includes("Prism is listening")) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      fail(new Error(`prism exited ${code} before listening; see ${log}`));
    });
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
      await exited;
      clearTimeout(timer);
    }
    await new Promise<void>((done) => file.end(done));
  };
  try {
    await listening;
  } catch (error) {
    await stop();
    throw error;
  }
  return { url: `http://127.0.0.1:${port}`, stop };
}
