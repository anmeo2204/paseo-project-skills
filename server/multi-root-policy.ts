import { randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { nativeEnrollmentSchema, nativeWriterVersion, type NativeEnrollment, type NativeWriterRequest } from "./native-writer-contract";
import { runSingleProjectEnroll } from "./native-writer";
import { pilotPolicyPath, toEnrollmentBinding } from "./single-project-policy";

export const maxEnrolledRoots = 64;
const maxPolicyBytes = 512 * 1024;
const lockTimeoutMs = 5000;
const staleLockMs = 30000;

export const multiRootEntrySchema = z.strictObject({
  enabled: z.boolean(),
  enrolledAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  enrollment: nativeEnrollmentSchema,
});
export type MultiRootEntry = z.infer<typeof multiRootEntrySchema>;

export const multiRootPolicyFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  roots: z.record(z.string(), multiRootEntrySchema),
});
export type MultiRootPolicyFile = z.infer<typeof multiRootPolicyFileSchema>;

function beneath(base: string, target: string) {
  const name = relative(base, target);
  return name !== "" && name !== ".." && !name.startsWith("../") && !isAbsolute(name);
}

export function multiRootRuntimeDirectory(daemonHome: string) {
  return join(daemonHome, "runtime", "project-skills");
}

export function multiRootPolicyPath(daemonHome: string) {
  return join(multiRootRuntimeDirectory(daemonHome), "enrollments.json");
}

function multiRootLockPath(daemonHome: string) {
  return join(multiRootRuntimeDirectory(daemonHome), ".enrollments.lock");
}

function checkPrivateDir(dir: string, daemonHome: string) {
  const home = realpathSync(daemonHome);
  if (!beneath(home, dir)) return false;
  const node = lstatSync(dir, { bigint: true });
  return node.isDirectory() && node.uid === BigInt(process.getuid!()) &&
    (node.mode & 0o7777n) === 0o700n && realpathSync(dir) === dir;
}

function validateAncestorsChain(enrollment: NativeEnrollment) {
  const { canonicalRoot, ancestors } = enrollment;
  if (!canonicalRoot || canonicalRoot === "/" || !isAbsolute(canonicalRoot)) return false;
  if (/[*?]/.test(canonicalRoot)) return false;
  if (ancestors.length < 2 || ancestors[0].path !== "/" || ancestors[ancestors.length - 1].path !== canonicalRoot) return false;
  for (let i = 1; i < ancestors.length; i++) {
    const prev = ancestors[i - 1].path;
    const curr = ancestors[i].path;
    if (curr === prev || dirname(curr) !== prev) return false;
  }
  return true;
}

function validatePolicyFile(policy: MultiRootPolicyFile): boolean {
  const keys = Object.keys(policy.roots);
  if (keys.length > maxEnrolledRoots) return false;
  for (const key of keys) {
    const entry = policy.roots[key];
    if (!entry || entry.enrollment.canonicalRoot !== key) return false;
    if (!validateAncestorsChain(entry.enrollment)) return false;
  }
  return true;
}

function ensurePrivateDir(daemonHome: string) {
  const home = realpathSync(daemonHome);
  const runtime = join(home, "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const dir = multiRootRuntimeDirectory(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!checkPrivateDir(dir, home)) throw new Error("unsafe_policy_directory");
  return { home, dir };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withPolicyLock<T>(daemonHome: string, fn: (home: string, dir: string) => T): T {
  const { home, dir } = ensurePrivateDir(daemonHome);
  const lockPath = multiRootLockPath(home);
  const deadline = Date.now() + lockTimeoutMs;
  let acquired = false;
  const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + "\n";

  while (!acquired) {
    try {
      const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Check for stale lock from a crashed process.
      try {
        const st = lstatSync(lockPath);
        if (st.isFile() && st.uid === process.getuid!()) {
          const fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let raw = "";
          try {
            const buf = Buffer.alloc(Math.min(st.size, 1024));
            const n = readSync(fd, buf, 0, buf.length, 0);
            raw = buf.subarray(0, n).toString("utf8");
          } finally {
            closeSync(fd);
          }
          const parsed = JSON.parse(raw) as { pid?: number; createdAt?: number };
          const stale = (typeof parsed.pid === "number" && !isPidAlive(parsed.pid)) ||
            (typeof parsed.createdAt === "number" && Date.now() - parsed.createdAt > staleLockMs);
          if (stale) {
            try { unlinkSync(lockPath); } catch { /* raced with another cleaner */ }
            continue;
          }
        }
      } catch { /* ignore transient read/parse errors while contender writes lock */ }
      if (Date.now() >= deadline) throw new Error("policy_lock_timeout");
      sleepSync(20);
    }
  }

  try {
    return fn(home, dir);
  } finally {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

function readPolicyFileRaw(daemonHome: string): { status: "missing" } | { status: "ok"; policy: MultiRootPolicyFile } | { status: "unsafe" } {
  try {
    const dir = multiRootRuntimeDirectory(daemonHome);
    if (!checkPrivateDir(dir, daemonHome)) return { status: "unsafe" };
    const filePath = multiRootPolicyPath(daemonHome);
    let fd: number;
    try {
      fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "unsafe" };
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() ||
          (stat.mode & 0o7777) !== 0o600 || stat.size <= 0 || stat.size > maxPolicyBytes) {
        return { status: "unsafe" };
      }
      const buf = Buffer.alloc(stat.size + 1);
      let readBytes = 0;
      while (readBytes < buf.length) {
        const n = readSync(fd, buf, readBytes, buf.length - readBytes, readBytes);
        if (!n) break;
        readBytes += n;
      }
      if (readBytes !== stat.size) return { status: "unsafe" };
      const parsed = multiRootPolicyFileSchema.safeParse(JSON.parse(buf.subarray(0, readBytes).toString("utf8")));
      if (!parsed.success || !validatePolicyFile(parsed.data)) return { status: "unsafe" };
      return { status: "ok", policy: parsed.data };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { status: "unsafe" };
  }
}

function writePolicyFileAtomic(home: string, dir: string, policy: MultiRootPolicyFile): string {
  const validated = multiRootPolicyFileSchema.parse(policy);
  if (!validatePolicyFile(validated)) throw new Error("invalid_policy_file");
  if (!checkPrivateDir(dir, home)) throw new Error("unsafe_policy_directory");
  const target = multiRootPolicyPath(home);
  const temp = join(dir, ".enrollments-" + randomBytes(16).toString("hex"));
  const bytes = Buffer.from(JSON.stringify(validated, null, 2) + "\n", "utf8");
  if (bytes.length > maxPolicyBytes) throw new Error("policy_limit_exceeded");
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } finally {
    try { unlinkSync(temp); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return target;
}

/**
 * Migration policy from single-root Pilot: NEVER auto-grants write capability.
 * Reports read-only whether a legacy pilot enrollment file exists so operators
 * know to explicitly re-enroll via the multi-root CLI.
 */
export function inspectLegacyPilotMigrationStatus(daemonHome: string): {
  legacyPilotPolicyPresent: boolean;
  autoMigrated: false;
} {
  try {
    const legacy = pilotPolicyPath(daemonHome);
    const st = lstatSync(legacy);
    return { legacyPilotPolicyPresent: st.isFile(), autoMigrated: false };
  } catch {
    return { legacyPilotPolicyPresent: false, autoMigrated: false };
  }
}

/**
 * Reads the active enrollment for an exact canonicalRoot.
 * Fail-closed: returns undefined when missing, disabled, malformed, unsafe, or non-exact match.
 * Never auto-migrates or falls back to single-root pilot enrollment.json.
 */
export function readActiveMultiRootEnrollment(daemonHome: string, canonicalRoot: string): NativeEnrollment | undefined {
  if (!canonicalRoot || !isAbsolute(canonicalRoot) || /[*?]/.test(canonicalRoot)) return undefined;
  const raw = readPolicyFileRaw(daemonHome);
  if (raw.status !== "ok") return undefined;
  const entry = Object.prototype.hasOwnProperty.call(raw.policy.roots, canonicalRoot)
    ? raw.policy.roots[canonicalRoot]
    : undefined;
  if (!entry || !entry.enabled) return undefined;
  if (entry.enrollment.canonicalRoot !== canonicalRoot) return undefined;
  return entry.enrollment;
}

export function readActiveMultiRootBinding(daemonHome: string, canonicalRoot: string) {
  const active = readActiveMultiRootEnrollment(daemonHome, canonicalRoot);
  return active ? toEnrollmentBinding(active) : undefined;
}

export function listMultiRootEnrollments(daemonHome: string) {
  const raw = readPolicyFileRaw(daemonHome);
  if (raw.status === "missing") return { status: "ok" as const, roots: [] as MultiRootEntry[] };
  if (raw.status === "unsafe") {
    // Distinguish absent runtime dir (fresh daemon) from corrupted/unsafe policy file.
    try {
      lstatSync(multiRootRuntimeDirectory(daemonHome));
      return { status: "unsafe" as const, roots: [] as MultiRootEntry[] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "ok" as const, roots: [] as MultiRootEntry[] };
      return { status: "unsafe" as const, roots: [] as MultiRootEntry[] };
    }
  }
  const roots = Object.keys(raw.policy.roots).sort().map(key => raw.policy.roots[key]);
  return { status: "ok" as const, roots };
}

export async function enrollMultiRoot(input: {
  daemonHome: string;
  root: string;
  environment: NativeWriterRequest["environment"];
  enabled?: boolean;
  testing?: boolean;
}): Promise<{ status: "enrolled"; entry: MultiRootEntry; path: string } | { status: "error"; code: string }> {
  if (!input.root || !isAbsolute(input.root) || /[*?]/.test(input.root)) {
    return { status: "error", code: "invalid_target" };
  }
  const result = await runSingleProjectEnroll({
    protocol: 1,
    helperVersion: nativeWriterVersion,
    root: input.root,
    expectedParentPid: process.pid,
    environment: input.environment,
  }, { testing: input.testing });
  if (result.event !== "enrolled") return { status: "error", code: result.code };

  const now = new Date().toISOString();
  const entry: MultiRootEntry = {
    enabled: input.enabled ?? true,
    enrolledAt: now,
    updatedAt: now,
    enrollment: {
      policyRevision: randomBytes(32).toString("hex"),
      canonicalRoot: result.canonicalRoot,
      volume: result.volume,
      ancestors: result.ancestors,
    },
  };

  return withPolicyLock(input.daemonHome, (home, dir) => {
    const raw = readPolicyFileRaw(home);
    if (raw.status === "unsafe") return { status: "error" as const, code: "unsafe_policy_file" };
    const existing = raw.status === "ok" ? raw.policy : { schemaVersion: 1 as const, roots: {} };
    const alreadyExists = Object.prototype.hasOwnProperty.call(existing.roots, result.canonicalRoot);
    if (!alreadyExists && Object.keys(existing.roots).length >= maxEnrolledRoots) {
      return { status: "error" as const, code: "policy_limit_exceeded" };
    }
    const next: MultiRootPolicyFile = {
      schemaVersion: 1,
      roots: {
        ...existing.roots,
        [result.canonicalRoot]: {
          ...entry,
          enrolledAt: alreadyExists ? existing.roots[result.canonicalRoot].enrolledAt : now,
        },
      },
    };
    const path = writePolicyFileAtomic(home, dir, next);
    return { status: "enrolled" as const, entry: next.roots[result.canonicalRoot], path };
  });
}

export function setMultiRootOptIn(
  daemonHome: string,
  canonicalRoot: string,
  enabled: boolean,
  rotateRevision = false,
): { status: "updated"; entry: MultiRootEntry; path: string } | { status: "error"; code: string } {
  return withPolicyLock(daemonHome, (home, dir) => {
    const raw = readPolicyFileRaw(home);
    if (raw.status === "missing") return { status: "error" as const, code: "not_enrolled" };
    if (raw.status === "unsafe") return { status: "error" as const, code: "unsafe_policy_file" };
    if (!Object.prototype.hasOwnProperty.call(raw.policy.roots, canonicalRoot)) {
      return { status: "error" as const, code: "not_enrolled" };
    }
    const current = raw.policy.roots[canonicalRoot];
    const updated: MultiRootEntry = {
      ...current,
      enabled,
      updatedAt: new Date().toISOString(),
      enrollment: rotateRevision
        ? { ...current.enrollment, policyRevision: randomBytes(32).toString("hex") }
        : current.enrollment,
    };
    const next: MultiRootPolicyFile = {
      schemaVersion: 1,
      roots: { ...raw.policy.roots, [canonicalRoot]: updated },
    };
    const path = writePolicyFileAtomic(home, dir, next);
    return { status: "updated" as const, entry: updated, path };
  });
}

export function revokeMultiRoot(
  daemonHome: string,
  canonicalRoot: string,
): { status: "revoked"; canonicalRoot: string; path: string } | { status: "error"; code: string } {
  return withPolicyLock(daemonHome, (home, dir) => {
    const raw = readPolicyFileRaw(home);
    if (raw.status === "missing") return { status: "error" as const, code: "not_enrolled" };
    if (raw.status === "unsafe") return { status: "error" as const, code: "unsafe_policy_file" };
    if (!Object.prototype.hasOwnProperty.call(raw.policy.roots, canonicalRoot)) {
      return { status: "error" as const, code: "not_enrolled" };
    }
    const remaining = { ...raw.policy.roots };
    delete remaining[canonicalRoot];
    const path = writePolicyFileAtomic(home, dir, { schemaVersion: 1, roots: remaining });
    return { status: "revoked" as const, canonicalRoot, path };
  });
}
