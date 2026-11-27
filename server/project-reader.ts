import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { relativePath, type ProjectWarning } from "../shared/project-evidence";
import { checkProjectPath, rootMatches, sameNode, sameFile } from "./filesystem-guards";

export const scanLimits = {
  depth: 6, memberDepth: 10, directories: 256, entries: 8_000, boundaries: 64,
  files: 256, fileBytes: 128 * 1024, prefixBytes: 8 * 1024, totalBytes: 4 * 1024 * 1024,
  deadlineMs: 8_000, responseBytes: 256 * 1024, warnings: 64, concurrent: 2,
};

export const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const beneath = (base: string, path: string) => base === "." ? path : base + "/" + path;
const excluded = /^(?:node_modules|vendor|dist|build|out|output|coverage|target|cache|caches|__pycache__|tmp|temp)$/i;
const agentLayouts = new Set([".agents", ".agent", "_agents", "_agent"]);
const customizationRoots = new Set([...agentLayouts, ".cursor", ".kiro"]);
const allowedHidden = new Set([...customizationRoots, ".github", ".cursorrules"]);
const secret = /^(?:\.env(?:$|[._-])|\.npmrc$|\.netrc$|\.pypirc$|auth\.json$|wp-config\.php$|id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)|(?:secrets?|credentials?)(?:$|[._-]))|\.(?:pem|key|p12|pfx|jks|kdbx|crt|cer|der)$/i;

// Hidden directories are traversed only along the project-level inventory paths.
function excludedPath(path: string) {
  if (path === ".") return false;
  const parts = path.split("/");
  const customization = parts.findIndex((segment) => customizationRoots.has(segment));
  return parts.some((part, index) => {
    if (excluded.test(part) || secret.test(part) || (part.startsWith(".") && !allowedHidden.has(part))) return true;
    const parent = parts[index - 1];
    if (customization !== -1 && parts[customization + 1] === "skills" && index > customization + 3) return true;
    if (customization !== -1 && parts[customization + 1] === "skills" && index === customization + 3) return part !== "SKILL.md";
    if (agentLayouts.has(parent)) {
      return !["skills", "rules", "AGENTS.md", "AGENTS.override.md", "GEMINI.md"].includes(part);
    }
    if (parent === ".cursor") return !["skills", "rules"].includes(part);
    if (parent === ".kiro") return !["skills", "steering"].includes(part);
    return parent === ".github" && part !== "workflows";
  });
}

export type EntryKind = "file" | "directory";
export type ProjectEntry = { path: string; name: string; kind: EntryKind };
type MetadataCandidate = (path: string) => "full" | "prefix" | undefined;
type Warn = (code: ProjectWarning["code"], relativePath?: string) => void;
export type ReaderFs = Pick<typeof fs, "lstat" | "realpath" | "opendir" | "open">;
export class ScanStopped extends Error {
  constructor(readonly code: "cancelled" | "deadline" | "target_changed") { super(code); }
}

export class ProjectReader {
  private readonly listings = new Map<string, ProjectEntry[]>();
  private readonly contents = new Map<string, string | undefined>();
  private directories = 0;
  private entries = 0;
  private files = 0;
  private bytes = 0;
  private readonly expires: number;
  gitMarker: "git_directory" | "git_file" | "unknown" = "unknown";

  constructor(
    private readonly root: string, private readonly identity: Stats,
    private readonly candidate: MetadataCandidate, private readonly warn: Warn, private readonly signal: AbortSignal,
    private readonly io: ReaderFs = fs, private readonly now = () => performance.now(),
    private readonly limits: typeof scanLimits = scanLimits,
  ) { this.expires = now() + limits.deadlineMs; }

  checkpoint() {
    if (this.signal.aborted) throw new ScanStopped("cancelled");
    if (this.now() >= this.expires) throw new ScanStopped("deadline");
  }

  async assertRoot() {
    try {
      if (!await rootMatches(this.root, this.identity, this.io)) throw new ScanStopped("target_changed");
    } catch {
      throw new ScanStopped("target_changed");
    }
  }

  private async checked(path: string, kind: EntryKind) {
    this.checkpoint();
    await this.assertRoot();
    const safe = await checkProjectPath(this.root, this.identity, path, kind, this.io);
    if (!safe) this.warn("unsafe_entry", path);
    return safe;
  }

  async list(path: string): Promise<readonly ProjectEntry[]> {
    if (!relativePath.safeParse(path).success || excludedPath(path)) return [];
    const cached = this.listings.get(path);
    if (cached) return cached;
    this.checkpoint();
    if (this.directories >= this.limits.directories) {
      this.warn("directory_budget");
      return [];
    }
    if (this.entries >= this.limits.entries) {
      this.warn("entry_budget");
      return [];
    }
    this.directories++;
    const observed: Dirent[] = [];
    try {
      const safe = await this.checked(path, "directory");
      if (!safe) return [];
      const handle = await this.io.opendir(safe.full);
      try {
        const opened = await this.checked(path, "directory");
        if (!opened || !sameNode(safe.state, opened.state)) {
          this.warn("entry_changed", path);
          return [];
        }
        // Discard the listing before extracting any evidence if it cannot fit.
        for (let entry = await handle.read(); entry; entry = await handle.read()) {
          this.checkpoint();
          if (++this.entries > this.limits.entries) {
            this.warn("entry_budget");
            return [];
          }
          observed.push(entry);
        }
      } finally {
        await handle.close();
      }
      const after = await this.checked(path, "directory");
      if (!after || !sameFile(safe.state, after.state)) {
        this.warn("entry_changed", path);
        return [];
      }
    } catch (error) {
      this.report(error, path);
      return [];
    }
    const entries: ProjectEntry[] = [];
    observed.sort((a, b) => compare(a.name, b.name));
    for (const entry of observed) {
      if (path === "." && entry.name === ".git") {
        this.gitMarker = entry.isDirectory() ? "git_directory" : entry.isFile() ? "git_file" : "unknown";
      }
      const child = beneath(path, entry.name);
      if (excludedPath(child)) continue;
      if (!relativePath.safeParse(child).success) {
        this.warn("unsafe_entry");
        continue;
      }
      if (!entry.isDirectory() && !entry.isFile()) {
        this.warn("unsafe_entry", child);
        continue;
      }
      entries.push({ path: child, name: entry.name, kind: entry.isDirectory() ? "directory" : "file" });
    }
    this.listings.set(path, entries);
    return entries;
  }

  async read(path: string): Promise<string | undefined> {
    if (!relativePath.safeParse(path).success || excludedPath(path)) return;
    const mode = this.candidate(path);
    if (!mode) return;
    const segments = path.split("/");
    if (segments.includes(".github") ||
        (segments.some((segment) => customizationRoots.has(segment)) && segments.at(-1) !== "SKILL.md")) return;
    if (this.contents.has(path)) return this.contents.get(path);
    const content = await this.readCandidate(path, mode);
    this.contents.set(path, content);
    return content;
  }

  private async readCandidate(path: string, mode: "full" | "prefix") {
    this.checkpoint();
    if (this.files >= this.limits.files) {
      this.warn("file_budget");
      return;
    }
    this.files++;
    try {
      const safe = await this.checked(path, "file");
      if (!safe) return;
      if (mode === "full" && safe.state.size > this.limits.fileBytes) {
        this.warn("file_size", path);
        return;
      }
      const size = mode === "prefix" ? Math.min(safe.state.size, this.limits.prefixBytes) : safe.state.size;
      if (size + this.bytes > this.limits.totalBytes) {
        this.warn("byte_budget");
        return;
      }
      const handle = await this.io.open(safe.full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await handle.stat();
        const current = await this.checked(path, "file");
        if (!current || !opened.isFile() || opened.nlink !== 1 ||
            !sameFile(safe.state, opened) || !sameFile(current.state, opened)) {
          this.warn("entry_changed", path);
          return;
        }
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          this.checkpoint();
          const { bytesRead } = await handle.read(buffer, offset, Math.min(size - offset, 8192), offset);
          if (!bytesRead) break;
          offset += bytesRead;
          this.bytes += bytesRead;
        }
        const after = await this.checked(path, "file");
        if (offset !== size || !after || !sameFile(opened, after.state) || !sameFile(opened, await handle.stat())) {
          this.warn("entry_changed", path);
          return;
        }
        // A truncated prefix may end in a partial UTF-8 sequence.
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream: mode === "prefix" && size < opened.size });
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.report(error, path);
    }
  }

  private report(error: unknown, path: string) {
    if (error instanceof ScanStopped) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    this.warn(code === "EACCES" || code === "EPERM" ? "permission_denied" :
      code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" ? "entry_changed" : "unreadable", path);
  }
}
