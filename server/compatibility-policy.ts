import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { writerArtifacts } from "./native/writer-payload";
import { nativeWriterVersion } from "./native-writer-contract";

export const safeApplyCompatibilityPolicy = Object.freeze({
  policyVersion: "m4.p2-v1",
  platform: "darwin" as const,
  arch: "arm64" as const,
  minMacOsVersion: "14.0.0",
  minPaseoVersion: "0.17.5",
  maxPaseoMinorExclusive: "0.18.0",
  minSdkVersion: "0.17.4",
  maxSdkMinorExclusive: "0.18.0",
  filesystem: "apfs" as const,
  caseMode: "insensitive" as const,
  trustModel: "single_user_local_host" as const,
  helperVersion: nativeWriterVersion,
});

export type CompatibilityFailureReason =
  | "unsupported_platform"
  | "unsupported_arch"
  | "unsupported_macos_version"
  | "unsupported_paseo_version"
  | "unsupported_sdk_version"
  | "unsafe_daemon_home"
  | "remote_exposure_enabled"
  | "trust_boundary_unverified"
  | "helper_integrity_failed";

export type Semver = readonly [number, number, number];

export function parseSemver(raw: string): Semver | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (parts.some(n => !Number.isSafeInteger(n) || n < 0)) return undefined;
  return parts;
}

export function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function isPaseoVersionCompatible(version: string): boolean {
  const parsed = parseSemver(version);
  const min = parseSemver(safeApplyCompatibilityPolicy.minPaseoVersion)!;
  const maxEx = parseSemver(safeApplyCompatibilityPolicy.maxPaseoMinorExclusive)!;
  if (!parsed) return false;
  return compareSemver(parsed, min) >= 0 && compareSemver(parsed, maxEx) < 0;
}

export function isSdkVersionCompatible(version: string): boolean {
  const parsed = parseSemver(version);
  const min = parseSemver(safeApplyCompatibilityPolicy.minSdkVersion)!;
  const maxEx = parseSemver(safeApplyCompatibilityPolicy.maxSdkMinorExclusive)!;
  if (!parsed) return false;
  return compareSemver(parsed, min) >= 0 && compareSemver(parsed, maxEx) < 0;
}

export function isMacOsVersionCompatible(version: string): boolean {
  const normalized = /^\d+\.\d+$/.test(version.trim()) ? `${version.trim()}.0` : version.trim();
  const parsed = parseSemver(normalized);
  const min = parseSemver(safeApplyCompatibilityPolicy.minMacOsVersion)!;
  if (!parsed) return false;
  return compareSemver(parsed, min) >= 0;
}

export function resolveSafeDaemonHome(explicitHome?: string, options?: { env?: NodeJS.ProcessEnv; homeDir?: string }):
  | { ok: true; daemonHome: string; source: "explicit" | "env" | "default" }
  | { ok: false; reason: "unsafe_daemon_home" } {
  const env = options?.env ?? process.env;
  const source = explicitHome ? "explicit" : env.PASEO_HOME ? "env" : "default";
  const candidate = explicitHome ?? env.PASEO_HOME ?? join(options?.homeDir ?? homedir(), ".paseo");
  if (!candidate || !isAbsolute(candidate) || candidate.includes("\0")) {
    return { ok: false, reason: "unsafe_daemon_home" };
  }
  try {
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, reason: "unsafe_daemon_home" };
    const canonical = realpathSync(candidate);
    if (canonical !== candidate) return { ok: false, reason: "unsafe_daemon_home" };
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return { ok: false, reason: "unsafe_daemon_home" };
    }
    // Fail-closed if daemon home is group- or world-writable.
    if ((stat.mode & 0o022) !== 0) return { ok: false, reason: "unsafe_daemon_home" };
    return { ok: true, daemonHome: canonical, source };
  } catch {
    return { ok: false, reason: "unsafe_daemon_home" };
  }
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const maxConfigBytes = 64 * 1024;

function isLoopbackListen(listen: unknown): boolean {
  if (typeof listen !== "string" || !listen.trim()) return true;
  const trimmed = listen.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0) return false;
    return loopbackHosts.has(trimmed.slice(0, end + 1).toLowerCase());
  }
  const idx = trimmed.lastIndexOf(":");
  const host = idx >= 0 ? trimmed.slice(0, idx) : trimmed;
  return loopbackHosts.has(host.toLowerCase());
}

function readBoundedJsonFile(filePath: string): { status: "missing" } | { status: "ok"; data: unknown } | { status: "error" } {
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "error" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 0 || stat.size > maxConfigBytes) return { status: "error" };
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return { status: "error" };
    const buf = Buffer.alloc(stat.size + 1);
    let readBytes = 0;
    while (readBytes < buf.length) {
      const n = readSync(fd, buf, readBytes, buf.length - readBytes, readBytes);
      if (!n) break;
      readBytes += n;
    }
    if (readBytes !== stat.size) return { status: "error" };
    return { status: "ok", data: JSON.parse(buf.subarray(0, readBytes).toString("utf8")) };
  } catch {
    return { status: "error" };
  } finally {
    closeSync(fd);
  }
}

function checkConfigSectionExposure(section: Record<string, unknown>): "remote_exposure_enabled" | "trust_boundary_unverified" | undefined {
  const relay = section.relay as Record<string, unknown> | boolean | undefined;
  if (relay === true || (relay && typeof relay === "object" && !Array.isArray(relay) && relay.enabled === true)) {
    return "remote_exposure_enabled";
  }
  if (relay !== undefined && relay !== false && (!relay || typeof relay !== "object" || Array.isArray(relay) || typeof (relay as Record<string, unknown>).enabled !== "boolean")) {
    return "trust_boundary_unverified";
  }
  const remote = section.remote as Record<string, unknown> | boolean | undefined;
  if (remote === true || (remote && typeof remote === "object" && !Array.isArray(remote) && remote.enabled === true)) {
    return "remote_exposure_enabled";
  }
  if ("listen" in section && !isLoopbackListen(section.listen)) {
    return "remote_exposure_enabled";
  }
  return undefined;
}

/**
 * Verifies the Single-user Local Host trust boundary for a Paseo daemon home.
 * Inspects both top-level and Paseo 0.17.x nested `daemon.*` settings.
 * Fail-closed when Relay / remote exposure is enabled, non-loopback listen is configured,
 * or daemon configuration cannot be safely verified.
 */
export function checkDaemonTrustBoundary(
  daemonHome: string,
  options?: { env?: NodeJS.ProcessEnv },
): { ok: true } | { ok: false; reason: "remote_exposure_enabled" | "trust_boundary_unverified" } {
  const env = options?.env ?? process.env;
  const relayEnv = (env.PASEO_RELAY_ENABLED ?? env.PASEO_RELAY ?? "").trim().toLowerCase();
  if (relayEnv === "1" || relayEnv === "true" || relayEnv === "yes") {
    return { ok: false, reason: "remote_exposure_enabled" };
  }
  if (env.PASEO_LISTEN && !isLoopbackListen(env.PASEO_LISTEN)) {
    return { ok: false, reason: "remote_exposure_enabled" };
  }
  for (const name of ["config.json", "daemon.json"]) {
    const result = readBoundedJsonFile(join(daemonHome, name));
    if (result.status === "missing") continue;
    if (result.status === "error" || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
      return { ok: false, reason: "trust_boundary_unverified" };
    }
    const cfg = result.data as Record<string, unknown>;
    const topIssue = checkConfigSectionExposure(cfg);
    if (topIssue) return { ok: false, reason: topIssue };
    if ("daemon" in cfg) {
      if (!cfg.daemon || typeof cfg.daemon !== "object" || Array.isArray(cfg.daemon)) {
        return { ok: false, reason: "trust_boundary_unverified" };
      }
      const nestedIssue = checkConfigSectionExposure(cfg.daemon as Record<string, unknown>);
      if (nestedIssue) return { ok: false, reason: nestedIssue };
    }
  }
  return { ok: true };
}

export function detectDefaultPaseoCli(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PASEO_CLI && isAbsolute(env.PASEO_CLI)) return env.PASEO_CLI;
  return "/Applications/Paseo.app/Contents/Resources/bin/paseo";
}

export function readInstalledSdkVersions(pluginRoot: string): string[] {
  const versions: string[] = [];
  for (const pkg of ["client", "plugin", "protocol"]) {
    const res = readBoundedJsonFile(join(pluginRoot, "node_modules", "@getpaseo", pkg, "package.json"));
    if (res.status !== "ok" || !res.data || typeof res.data !== "object") return [];
    const version = (res.data as Record<string, unknown>).version;
    if (typeof version !== "string") return [];
    versions.push(version);
  }
  return versions;
}

export function verifyEmbeddedHelperIntegrity(testing = false): { ok: true; sha256: string } | { ok: false } {
  const artifact = writerArtifacts[testing ? "testing" : "standard"];
  if (!artifact || !artifact.base64 || artifact.version !== nativeWriterVersion || artifact.protocol !== 1 || artifact.arch !== "arm64") {
    return { ok: false };
  }
  const bytes = Buffer.from(artifact.base64, "base64");
  if (bytes.toString("base64") !== artifact.base64) return { ok: false };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== artifact.sha256) return { ok: false };
  return { ok: true, sha256 };
}

export type HostCompatibilityResult =
  | {
      compatible: true;
      policyVersion: string;
      daemonHome: string;
      daemonHomeSource: "explicit" | "env" | "default";
      macOsVersion: string;
      paseoVersion: string;
      sdkVersion: string;
      helperSha256: string;
    }
  | {
      compatible: false;
      policyVersion: string;
      reasons: CompatibilityFailureReason[];
    };

export function evaluateHostCompatibility(input: {
  daemonHome?: string;
  paseoVersion?: string;
  cliPath?: string;
  sdkVersions: readonly string[];
  macOsVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  testing?: boolean;
}): HostCompatibilityResult {
  const reasons: CompatibilityFailureReason[] = [];
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  if (platform !== safeApplyCompatibilityPolicy.platform) reasons.push("unsupported_platform");
  if (arch !== safeApplyCompatibilityPolicy.arch) reasons.push("unsupported_arch");

  let macOsVersion = input.macOsVersion;
  if (!macOsVersion && platform === "darwin") {
    try {
      macOsVersion = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { timeout: 3000, maxBuffer: 1024, encoding: "utf8" }).trim();
    } catch {
      macOsVersion = "";
    }
  }
  if (!macOsVersion || !isMacOsVersionCompatible(macOsVersion)) reasons.push("unsupported_macos_version");

  let paseoVersion = input.paseoVersion;
  if (!paseoVersion && input.cliPath) {
    try {
      paseoVersion = execFileSync(input.cliPath, ["--version"], { timeout: 3000, maxBuffer: 1024, encoding: "utf8" }).trim();
    } catch {
      paseoVersion = "";
    }
  }
  if (!paseoVersion || !isPaseoVersionCompatible(paseoVersion)) reasons.push("unsupported_paseo_version");

  if (input.sdkVersions.length === 0 || input.sdkVersions.some(v => !isSdkVersionCompatible(v)) ||
      new Set(input.sdkVersions).size !== 1) {
    reasons.push("unsupported_sdk_version");
  }

  const home = resolveSafeDaemonHome(input.daemonHome, { env: input.env, homeDir: input.homeDir });
  if (!home.ok) {
    reasons.push(home.reason);
  } else {
    const trust = checkDaemonTrustBoundary(home.daemonHome, { env: input.env });
    if (!trust.ok) reasons.push(trust.reason);
  }

  const helper = verifyEmbeddedHelperIntegrity(Boolean(input.testing));
  if (!helper.ok) reasons.push("helper_integrity_failed");

  if (reasons.length > 0 || !home.ok || !helper.ok) {
    return { compatible: false, policyVersion: safeApplyCompatibilityPolicy.policyVersion, reasons };
  }
  return {
    compatible: true,
    policyVersion: safeApplyCompatibilityPolicy.policyVersion,
    daemonHome: home.daemonHome,
    daemonHomeSource: home.source,
    macOsVersion: macOsVersion!,
    paseoVersion: paseoVersion!,
    sdkVersion: input.sdkVersions[0],
    helperSha256: helper.sha256,
  };
}
