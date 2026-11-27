import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writerArtifacts } from "./native/writer-payload";
import { nativeEventSchema, nativeVersionSchema, nativeWriterRequestSchema, nativeWriterVersion, nativeWriterLimits,
  singleProjectEnrollEventSchema, singleProjectEnrollRequestSchema, singleProjectWriterRequestSchema,
  type NativeWriterRequest, type NativeWriterResult, type NativeWriterEvent,
  type SingleProjectEnrollEvent, type SingleProjectEnrollRequest, type SingleProjectWriterRequest } from "./native-writer-contract";

const exec = promisify(execFile);
export type WriterArtifact = { version: string; protocol: number; arch: string; fixtureOnly: boolean; testing: boolean; sha256: string; base64: string };
type Ledger = NativeWriterResult["ledger"];
type HostFailure = Omit<NativeWriterResult, "targetMutated"> & { targetMutated: boolean | "unknown" };
export type FixtureWriterOutcome = { result: HostFailure; events: NativeWriterEvent[]; artifactSha256?: string;
  extraction: { removed: boolean; directory?: string }; nativeExit?: { code: number | null; signal: string | null } };
export type FixtureWriterOptions = { testing?: boolean; artifact?: WriterArtifact | null;
  onEvent?: (event: NativeWriterEvent, context: { helperPid: number }) => void | Promise<void>;
  signal?: AbortSignal;
  onAdmission?: () => Promise<boolean>;
  onProgress?: (event: Extract<NativeWriterEvent, { event: "mutation_intent" | "file_verified" | "directory_verified" }>) => void;
  // Called after target I/O settles, before the helper releases its coordinator.
  onFinalize?: (result: NativeWriterResult) => void | Promise<void>;
  // Extraction fault hook operates only on the private helper namespace.
  onExtracted?: (directory: string) => void | Promise<void> };

function initialLedger(request: Pick<NativeWriterRequest, "directories" | "files">): Ledger {
  return [...request.directories.map(item => ({ destination: item.destination, kind: "directory" as const, state: "not_attempted" as const })),
    ...request.files.map(item => ({ destination: item.destination, kind: "file" as const, state: "not_attempted" as const, bytesWritten: 0 }))];
}
function hostFailure(code: string, ledger: Ledger, possibleMutation = false): HostFailure {
  return { event: "result", protocol: 1, version: nativeWriterVersion, phase: possibleMutation ? "uncertain" : "failed_before_write",
    code, targetMutated: possibleMutation ? "unknown" : false, ledger, checkpoints: 0, durability: "not_confirmed" };
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sameNode = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino;

// Not imported by index.server.ts. Both packaged helpers enforce fixture scope;
// no product write capability or caller authorization is created by this module.
export async function runFixtureWriter(raw: NativeWriterRequest, options: FixtureWriterOptions = {}): Promise<FixtureWriterOutcome> {
  const request = nativeWriterRequestSchema.parse(raw);
  const modeArg = request.durableAdmission ? "--worker" : "--primitive-fixture-worker";
  return runNativeWriterInternal(request, modeArg, options);
}

export async function runSingleProjectWriter(raw: SingleProjectWriterRequest, options: FixtureWriterOptions = {}): Promise<FixtureWriterOutcome> {
  const request = singleProjectWriterRequestSchema.parse(raw);
  const modeArg = request.durableAdmission ? "--single-project-worker" : "--single-project-probe";
  return runNativeWriterInternal(request, modeArg, options);
}

export async function runSingleProjectEnroll(raw: SingleProjectEnrollRequest, options: Pick<FixtureWriterOptions, "testing" | "artifact" | "onExtracted"> = {}): Promise<SingleProjectEnrollEvent> {
  const request = singleProjectEnrollRequestSchema.parse(raw);
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return { event: "enroll_error", protocol: 1, version: nativeWriterVersion, code: "unsupported_environment" };
  }
  const artifact = options.artifact === undefined ? writerArtifacts[options.testing ? "testing" : "standard"] : options.artifact;
  if (!artifact || !artifact.base64) return { event: "enroll_error", protocol: 1, version: nativeWriterVersion, code: "helper_missing" };
  if (artifact.version !== nativeWriterVersion || artifact.protocol !== 1 || artifact.arch !== "arm64" || !artifact.fixtureOnly || artifact.testing !== Boolean(options.testing)) {
    return { event: "enroll_error", protocol: 1, version: nativeWriterVersion, code: "helper_version" };
  }
  const bytes = Buffer.from(artifact.base64, "base64");
  if (bytes.toString("base64") !== artifact.base64 || digest(bytes) !== artifact.sha256) {
    return { event: "enroll_error", protocol: 1, version: nativeWriterVersion, code: "helper_integrity" };
  }
  let directory: string | undefined;
  let directoryIdentity: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "pps-helper-m43-"));
    directoryIdentity = await fs.lstat(directory);
    if (!directoryIdentity.isDirectory() || (directoryIdentity.mode & 0o7777) !== 0o700 || directoryIdentity.uid !== process.getuid?.()) throw new Error("extraction_unsafe");
    const helper = join(directory, "writer");
    const handle = await fs.open(helper, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
    try { await handle.writeFile(bytes); await handle.chmod(0o700); await handle.sync(); } finally { await handle.close(); }
    await options.onExtracted?.(directory);
    const versionRaw = await exec(helper, ["--version"], { timeout: 3000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", TMPDIR: tmpdir() } });
    const version = nativeVersionSchema.safeParse(JSON.parse(versionRaw.stdout));
    if (!version.success || version.data.testing !== Number(Boolean(options.testing))) throw new Error("helper_version");
    const wire = JSON.stringify({ ...request, expectedParentPid: process.pid }) + "\n";
    const child = spawn(helper, ["--enroll-root"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", TMPDIR: tmpdir(), LC_ALL: "C" } });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length + chunk.length <= 262144) stdout += chunk; });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 10000);
      child.once("close", () => { clearTimeout(timeout); resolve(); });
      child.once("error", () => { clearTimeout(timeout); resolve(); });
      child.stdin.write(wire);
    });
    const line = stdout.trim().split("\n")[0];
    if (!line) return { event: "enroll_error", protocol: 1, version: nativeWriterVersion, code: "helper_protocol" };
    const parsed = singleProjectEnrollEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : { event: "enroll_error", protocol: 1, version: nativeWriterVersion, code: "helper_protocol" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "helper_unavailable";
    const code = ["helper_integrity", "helper_version", "extraction_unsafe"].includes(message) ? message : "helper_unavailable";
    return { event: "enroll_error", protocol: 1, version: nativeWriterVersion, code };
  } finally {
    if (directory && directoryIdentity) {
      try {
        const current = await fs.lstat(directory);
        if (current.dev === directoryIdentity.dev && current.ino === directoryIdentity.ino && current.isDirectory() &&
          current.uid === process.getuid?.() && (current.mode & 0o7777) === 0o700 && await fs.realpath(directory) === directory) {
          await fs.rm(directory, { recursive: true });
        }
      } catch { /* ignore cleanup failure */ }
    }
  }
}

async function runNativeWriterInternal(
  request: NativeWriterRequest | SingleProjectWriterRequest,
  modeArg: "--worker" | "--primitive-fixture-worker" | "--single-project-worker" | "--single-project-probe",
  options: FixtureWriterOptions = {},
): Promise<FixtureWriterOutcome> {
  const events: NativeWriterEvent[] = [];
  let result: HostFailure = hostFailure("helper_missing", initialLedger(request));
  const outcome: FixtureWriterOutcome = { result, events, extraction: { removed: true } };
  let directory: string | undefined;
  let directoryIdentity: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  let possibleMutation = false;
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") { outcome.result = hostFailure("unsupported_environment", initialLedger(request)); return outcome; }
    const artifact = options.artifact === undefined ? writerArtifacts[options.testing ? "testing" : "standard"] : options.artifact;
    if (!artifact || !artifact.base64) return outcome;
    if (artifact.version !== nativeWriterVersion || artifact.protocol !== 1 || artifact.arch !== "arm64" || !artifact.fixtureOnly || artifact.testing !== Boolean(options.testing)) {
      outcome.result = hostFailure("helper_version", initialLedger(request)); return outcome;
    }
    const bytes = Buffer.from(artifact.base64, "base64");
    if (bytes.toString("base64") !== artifact.base64 || digest(bytes) !== artifact.sha256) { outcome.result = hostFailure("helper_integrity", initialLedger(request)); return outcome; }
    outcome.artifactSha256 = artifact.sha256;
    directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "pps-helper-m43-"));
    directoryIdentity = await fs.lstat(directory);
    outcome.extraction = { removed: false, directory };
    if (!directoryIdentity.isDirectory() || (directoryIdentity.mode & 0o7777) !== 0o700 || directoryIdentity.uid !== process.getuid?.()) throw new Error("extraction_unsafe");
    const helper = join(directory, "writer");
    const handle = await fs.open(helper, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
    try { await handle.writeFile(bytes); await handle.chmod(0o700); await handle.sync(); } finally { await handle.close(); }
    await options.onExtracted?.(directory);
    const verifyExtraction = async () => {
      const current = await fs.lstat(directory!);
      if (current.dev !== directoryIdentity!.dev || current.ino !== directoryIdentity!.ino || current.uid !== process.getuid?.() ||
          (current.mode & 0o7777) !== 0o700 || await fs.realpath(directory!) !== directory) throw new Error("extraction_unsafe");
      const file = await fs.open(helper, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) ||
            before.size !== BigInt(bytes.length) || (before.mode & 0o7777n) !== 0o700n) throw new Error("helper_integrity");
        const read = Buffer.alloc(bytes.length + 1);
        let size = 0;
        while (size < read.length) {
          const { bytesRead } = await file.read(read, size, read.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        const after = await file.stat({ bigint: true });
        if (!sameNode(before, after) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
            size !== bytes.length || digest(read.subarray(0, size)) !== artifact.sha256) throw new Error("helper_integrity");
        const linked = await fs.lstat(helper, { bigint: true }); if (!sameNode(after, linked)) throw new Error("helper_integrity");
      } finally { await file.close(); }
    };
    await verifyExtraction();
    const versionRaw = await exec(helper, ["--version"], { timeout: 3000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", TMPDIR: tmpdir() } });
    const version = nativeVersionSchema.safeParse(JSON.parse(versionRaw.stdout));
    if (!version.success || version.data.testing !== Number(Boolean(options.testing))) throw new Error("helper_version");
    await verifyExtraction();
    const wire = JSON.stringify({ ...request, expectedParentPid: process.pid }) + "\n";
    if (Buffer.byteLength(wire) > nativeWriterLimits.requestBytes) throw new Error("limit_exceeded");
    const child = spawn(helper, [modeArg], { stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", TMPDIR: tmpdir(), LC_ALL: "C" } });
    const abort = () => child.kill("SIGUSR1");
    options.signal?.addEventListener("abort", abort, { once: true });
    // Admission checks the signal too, covering cancellation before exec installs its handler.
    let buffer = "", received = 0, protocolError = false, nativeResult: NativeWriterResult | undefined, closed = false;
    const markUncertain = (code: string) => {
      protocolError = true; outcome.result = hostFailure(code, initialLedger(request), possibleMutation); child.kill("SIGTERM");
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      received += Buffer.byteLength(chunk);
      if (received > nativeWriterLimits.responseBytes) { markUncertain("response_limit"); return; }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const parsed = nativeEventSchema.safeParse(JSON.parse(line));
          if (!parsed.success || nativeResult) { markUncertain("helper_protocol"); return; }
          const event = parsed.data; events.push(event);
          if (event.event === "mutation_intent") possibleMutation = true;
          if (event.event === "result") nativeResult = event;
          const task = options.onEvent?.(event, { helperPid: child.pid! });
          if (event.event === "ready_to_admit") {
            Promise.resolve(task).then(() => {
              if (!closed && !protocolError && !child.stdin.destroyed) return options.onAdmission?.();
            }).then((approved) => {
              if (!closed && !protocolError && !child.stdin.destroyed) child.stdin.write(approved ? "ADMIT\n" : "DENY\n");
            }, () => markUncertain("admission_controller_failed"));
          } else if (request.durableAdmission &&
                     (event.event === "mutation_intent" || event.event === "file_verified" || event.event === "directory_verified")) {
            Promise.resolve(task).then(() => {
              if (closed || protocolError || child.stdin.destroyed) return;
              if (!options.onProgress) throw new Error("journal_unavailable");
              options.onProgress(event);
              child.stdin.write("RECORDED\n");
            }).catch(() => markUncertain("journal_progress_failed"));
          } else if (event.event === "ready_to_finalize") {
            Promise.resolve(task).then(() => {
              if (!closed && !protocolError && !child.stdin.destroyed) return options.onFinalize?.(event.result);
            }).then(() => {
              if (!closed && !protocolError && !child.stdin.destroyed) child.stdin.write("FINALIZE\n");
            }, () => markUncertain("finalization_controller_failed"));
          } else if (event.event === "barrier") {
            Promise.resolve(task).then(() => {
              if (!closed && !protocolError && !child.stdin.destroyed) child.stdin.write(`CONTINUE ${event.sequence}\n`);
            }, () => markUncertain("barrier_controller_failed"));
          } else if (task) Promise.resolve(task).catch(() => markUncertain("event_observer_failed"));
        } catch { markUncertain("helper_protocol"); return; }
      }
    });
    child.stderr.on("data", () => { /* Never surface native stderr in RPC/product output. */ });
    child.stdin.on("error", () => { /* Exit/close settles uncertain state, including a broken pipe. */ });
    const timeout = setTimeout(() => markUncertain("helper_timeout"), nativeWriterLimits.deadlineMs + 2000);
    const exit = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
      child.once("error", () => { protocolError = true; outcome.result = hostFailure("helper_missing", initialLedger(request), possibleMutation); });
      child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); });
      child.stdin.write(wire);
    });
    clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); outcome.nativeExit = exit;
    if (!protocolError && nativeResult && !buffer.trim()) {
      const expected = initialLedger(request), byPath = new Map(nativeResult.ledger.map(item => [item.destination, item]));
      const valid = byPath.size === nativeResult.ledger.length && nativeResult.ledger.every(item => expected.some(e => e.destination === item.destination && e.kind === item.kind));
      if (!valid || nativeResult.phase === "completed" && byPath.size !== expected.length ||
          nativeResult.phase === "completed" && (exit.code !== 0 || nativeResult.code !== "none" || nativeResult.ledger.some(item => !["created_verified", "unchanged_verified"].includes(item.state)))) {
        outcome.result = hostFailure("helper_protocol", initialLedger(request), possibleMutation);
      } else {
        outcome.result = { ...nativeResult, ledger: expected.map(item => byPath.get(item.destination) ?? item) };
      }
    } else {
      const rows = initialLedger(request);
      for (const event of events) {
        if (event.event === "mutation_intent") { const row = rows.find(item => item.destination === event.destination); if (row) row.state = "ownership_unknown"; }
        if (event.event === "file_verified") {
          const row = rows.find(item => item.destination === event.destination);
          if (row) {
            row.state = "created_verified";
            row.identity = event.identity;
            row.bytesWritten = request.files.find(file => file.destination === event.destination)!.sizeBytes;
          }
        }
      }
      outcome.result = hostFailure(protocolError ? outcome.result.code : "helper_exit", rows, possibleMutation);
    }
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : "helper_unavailable";
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "helper_missing" :
      ["helper_integrity", "helper_version", "extraction_unsafe", "limit_exceeded"].includes(message) ? message : "helper_unavailable";
    outcome.result = hostFailure(code, initialLedger(request), possibleMutation); return outcome;
  } finally {
    if (directory && directoryIdentity) {
      try {
        const current = await fs.lstat(directory!);
        if (current.dev === directoryIdentity.dev && current.ino === directoryIdentity.ino && current.isDirectory() &&
          current.uid === process.getuid?.() && (current.mode & 0o7777) === 0o700 && await fs.realpath(directory) === directory) {
          // Only the owned private extraction namespace. Never remove target paths.
          await fs.rm(directory, { recursive: true }); outcome.extraction.removed = true;
        }
      } catch { /* Report extraction.removed=false; do not guess ownership or delete another node. */ }
    }
  }
}
