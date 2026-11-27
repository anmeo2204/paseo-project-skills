import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { checkProjectPath, rootMatches, sameFile, sameNode } from "./filesystem-guards";
import type { PreviewEntry, PreviewErrorCode } from "../shared/preview";
import { previewLimits } from "./preview-limits";

export class PreviewError extends Error {
  constructor(readonly code: PreviewErrorCode) { super(code); }
}
export type PreviewFs = Pick<typeof fs, "lstat" | "realpath" | "open">;
type Reason = NonNullable<PreviewEntry["reason"]>;
class Blocked extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}

export class PreviewReader {
  private readonly observations = new Map<string, { kind: "file" | "directory"; state?: Stats }>();
  private bytes = 0;
  private checks = 0;
  private readonly expires: number;
  private readonly guardedIo: PreviewFs;

  constructor(private readonly root: string, private readonly identity: Stats, private readonly signal: AbortSignal,
    private readonly io: PreviewFs = fs, private readonly limits: typeof previewLimits = previewLimits,
    private readonly now = () => performance.now(), private readonly directoryIdentityOnly = false) {
    this.expires = now() + limits.deadlineMs;
    this.guardedIo = { ...io, lstat: async (path, ...args) => {
      this.checkpoint();
      if (++this.checks > limits.filesystemChecks) throw new PreviewError("limit_exceeded");
      return io.lstat(path, ...args);
    } } as PreviewFs;
  }

  checkpoint() {
    if (this.signal.aborted) throw new PreviewError("cancelled");
    if (this.now() >= this.expires) throw new PreviewError("limit_exceeded");
  }

  async assertRoot() {
    this.checkpoint();
    try {
      if (!await rootMatches(this.root, this.identity, this.guardedIo)) throw new PreviewError("target_changed");
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      throw new PreviewError("target_changed");
    }
  }

  private async check(path: string, kind: "file" | "directory") {
    await this.assertRoot();
    return checkProjectPath(this.root, this.identity, path, kind, this.guardedIo);
  }

  private sameObservation(kind: "file" | "directory", a: Stats, b: Stats) {
    return kind === "directory" && this.directoryIdentityOnly
      ? sameNode(a, b) && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
      : sameFile(a, b);
  }

  private async locate(path: string, leafKind: "file" | "directory") {
    const parts = path.split("/");
    let leaf: Awaited<ReturnType<typeof checkProjectPath>>;
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const kind = i === parts.length ? leafKind : "directory";
      try { leaf = await this.check(prefix, kind); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const known = this.observations.get(prefix);
        if (known?.state) throw new Blocked("entry_changed");
        this.observations.set(prefix, { kind });
        return;
      }
      if (!leaf) throw new Blocked("unsafe_entry");
      const known = this.observations.get(prefix);
      if (known && (!known.state || !this.sameObservation(kind, known.state, leaf.state))) throw new Blocked("entry_changed");
      this.observations.set(prefix, { kind, state: leaf.state });
    }
    if (!leaf) throw new Blocked("unsafe_entry");
    return leaf;
  }

  // Bounded direct metadata inspection; does not enumerate directories or read bodies.
  async inspect(path: string, kind: "file" | "directory" = "file"): Promise<"present" | "missing" | "blocked"> {
    try { return await this.locate(path, kind) ? "present" : "missing"; }
    catch (error) {
      if (error instanceof PreviewError) throw error;
      return "blocked";
    }
  }

  async read(path: string): Promise<{ bytes?: Buffer; state?: Stats; reason?: Reason }> {
    try {
      const leaf = await this.locate(path, "file");
      if (!leaf) return {};
      if (leaf.state.size > this.limits.fileBytes || this.bytes + leaf.state.size > this.limits.readBytes) {
        throw new Blocked("read_limit");
      }
      const handle = await this.io.open(leaf.full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await handle.stat();
        const current = await this.check(path, "file");
        if (!opened.isFile() || opened.nlink !== 1 || !current ||
            !sameFile(leaf.state, opened) || !sameFile(opened, current.state)) throw new Blocked("entry_changed");
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          this.checkpoint();
          const { bytesRead } = await handle.read(bytes, offset, Math.min(8192, bytes.length - offset), offset);
          if (!bytesRead) break;
          offset += bytesRead;
          this.bytes += bytesRead;
        }
        const after = await this.check(path, "file");
        if (offset !== bytes.length || !after || !sameFile(opened, after.state) ||
            !sameFile(opened, await handle.stat())) throw new Blocked("entry_changed");
        return { bytes, state: opened };
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      return { reason: error instanceof Blocked ? error.reason :
        ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "") ? "entry_changed" : "unreadable" };
    }
  }

  async changedPaths() {
    const changed: string[] = [];
    for (const [path, { state, kind }] of this.observations) {
      try {
        const current = await this.check(path, kind);
        if (!current || !state || !this.sameObservation(kind, state, current.state)) changed.push(path);
      } catch (error) {
        if (error instanceof PreviewError) throw error;
        if (state || (error as NodeJS.ErrnoException).code !== "ENOENT") changed.push(path);
      }
    }
    await this.assertRoot();
    return changed;
  }
}
