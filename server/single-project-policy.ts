import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { EnrollmentBinding } from "../shared/preview-receipt";
import { nativeEnrollmentSchema, nativeWriterVersion, type NativeEnrollment, type NativeWriterRequest } from "./native-writer-contract";
import { runSingleProjectEnroll } from "./native-writer";
import { canonicalSerialize } from "./preview-receipts";

export const singleProjectPolicyFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  enrollment: nativeEnrollmentSchema,
});
export type SingleProjectPolicyFile = z.infer<typeof singleProjectPolicyFileSchema>;
export type ActiveSingleProjectPolicy = NativeEnrollment;

const maxPolicyBytes = 64 * 1024;

function beneath(base: string, path: string) {
  const name = relative(base, path);
  return name !== "" && name !== ".." && !name.startsWith("../") && !isAbsolute(name);
}

export function pilotRuntimeDirectory(daemonHome: string) {
  return join(daemonHome, "runtime", "project-skills-pilot");
}

export function pilotPolicyPath(daemonHome: string) {
  return join(pilotRuntimeDirectory(daemonHome), "enrollment.json");
}

export function toEnrollmentBinding(enrollment: NativeEnrollment): EnrollmentBinding {
  const root = enrollment.ancestors[enrollment.ancestors.length - 1];
  const ancestorsDigest = createHash("sha256")
    .update("paseo-project-skills/single-project-ancestors/v1\0")
    .update(canonicalSerialize(enrollment.ancestors))
    .digest("hex");
  return {
    policyRevision: enrollment.policyRevision,
    canonicalRoot: enrollment.canonicalRoot,
    volume: enrollment.volume,
    rootIdentity: {
      dev: root.dev,
      ino: root.ino,
      mode: root.mode,
      uid: root.uid,
      gid: root.gid,
    },
    ancestorsDigest,
  };
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
  if (ancestors.length < 2 || ancestors[0].path !== "/" || ancestors[ancestors.length - 1].path !== canonicalRoot) return false;
  for (let i = 1; i < ancestors.length; i++) {
    const prev = ancestors[i - 1].path;
    const curr = ancestors[i].path;
    if (curr === prev || dirname(curr) !== prev) return false;
  }
  return true;
}

/**
 * Reads the daemon-private single-project enrollment policy.
 * Fail-closed: returns undefined when opt-in is off, missing, malformed, or unsafe.
 */
export function readActiveSingleProjectPolicy(daemonHome: string): ActiveSingleProjectPolicy | undefined {
  try {
    const dir = pilotRuntimeDirectory(daemonHome);
    if (!checkPrivateDir(dir, daemonHome)) return undefined;
    const filePath = pilotPolicyPath(daemonHome);
    const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() ||
          (stat.mode & 0o7777) !== 0o600 || stat.size <= 0 || stat.size > maxPolicyBytes) return undefined;
      const buf = Buffer.alloc(stat.size + 1);
      let readBytes = 0;
      while (readBytes < buf.length) {
        const n = readSync(fd, buf, readBytes, buf.length - readBytes, readBytes);
        if (!n) break;
        readBytes += n;
      }
      if (readBytes !== stat.size) return undefined;
      const parsed = singleProjectPolicyFileSchema.safeParse(JSON.parse(buf.subarray(0, readBytes).toString("utf8")));
      if (!parsed.success || !parsed.data.enabled) return undefined;
      if (!validateAncestorsChain(parsed.data.enrollment)) return undefined;
      return parsed.data.enrollment;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export function writeSingleProjectPolicyFile(daemonHome: string, policy: SingleProjectPolicyFile) {
  const validated = singleProjectPolicyFileSchema.parse(policy);
  if (!validateAncestorsChain(validated.enrollment)) throw new Error("invalid_enrollment_chain");
  const home = realpathSync(daemonHome);
  const runtime = join(home, "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const dir = pilotRuntimeDirectory(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!checkPrivateDir(dir, home)) throw new Error("unsafe_policy_directory");
  const target = pilotPolicyPath(home);
  const temp = join(dir, ".enrollment-" + randomBytes(16).toString("hex"));
  const bytes = Buffer.from(JSON.stringify(validated, null, 2) + "\n", "utf8");
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

export async function enrollSingleProjectRoot(input: {
  daemonHome: string;
  root: string;
  environment: NativeWriterRequest["environment"];
  enabled?: boolean;
  testing?: boolean;
}): Promise<{ status: "enrolled"; policy: SingleProjectPolicyFile; path: string } | { status: "error"; code: string }> {
  const result = await runSingleProjectEnroll({
    protocol: 1,
    helperVersion: nativeWriterVersion,
    root: input.root,
    expectedParentPid: process.pid,
    environment: input.environment,
  }, { testing: input.testing });
  if (result.event !== "enrolled") return { status: "error", code: result.code };
  const policy: SingleProjectPolicyFile = {
    schemaVersion: 1,
    enabled: input.enabled ?? true,
    enrollment: {
      policyRevision: randomBytes(32).toString("hex"),
      canonicalRoot: result.canonicalRoot,
      volume: result.volume,
      ancestors: result.ancestors,
    },
  };
  const path = writeSingleProjectPolicyFile(input.daemonHome, policy);
  return { status: "enrolled", policy, path };
}

export function setSingleProjectOptIn(daemonHome: string, enabled: boolean, rotateRevision = false) {
  const dir = pilotRuntimeDirectory(daemonHome);
  if (!checkPrivateDir(dir, daemonHome)) throw new Error("unsafe_policy_directory");
  const filePath = pilotPolicyPath(daemonHome);
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let current: SingleProjectPolicyFile;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o600 || stat.size > maxPolicyBytes) {
      throw new Error("unsafe_policy_file");
    }
    const buf = Buffer.alloc(stat.size);
    let readBytes = 0;
    while (readBytes < stat.size) {
      const n = readSync(fd, buf, readBytes, stat.size - readBytes, readBytes);
      if (!n) break;
      readBytes += n;
    }
    current = singleProjectPolicyFileSchema.parse(JSON.parse(buf.toString("utf8")));
  } finally {
    closeSync(fd);
  }
  const updated: SingleProjectPolicyFile = {
    ...current,
    enabled,
    enrollment: rotateRevision
      ? { ...current.enrollment, policyRevision: randomBytes(32).toString("hex") }
      : current.enrollment,
  };
  writeSingleProjectPolicyFile(daemonHome, updated);
  return updated;
}
