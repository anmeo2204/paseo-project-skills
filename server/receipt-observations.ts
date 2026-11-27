import type { BigIntStats, Stats } from "node:fs";
import { join, parse, relative, sep } from "node:path";
import type { ReceiptObservation, PreviewManifest } from "../shared/preview-receipt";
import { PreviewError, type PreviewFs } from "./preview-reader";
import { previewLimits } from "./preview-limits";
import { canonicalSerialize } from "./preview-receipts";

function observation(state: BigIntStats): ReceiptObservation["observation"] {
  return { state: "present", kind: state.isDirectory() ? "directory" : state.isFile() ? "file" : "unsafe",
    dev: String(state.dev), ino: String(state.ino), mode: String(state.mode), uid: String(state.uid), gid: String(state.gid),
    ...(!state.isDirectory() ? { fileVersion: { sizeBytes: String(state.size), nlink: String(state.nlink),
      mtimeNs: String(state.mtimeNs), ctimeNs: String(state.ctimeNs) } } : {}) };
}
// The M3 planner still takes Stats; exact bigint observations are retained separately.
// Bind type predicates to the original BigIntStats, never coerce its internal mode.
function numericStats(state: BigIntStats): Stats {
  for (const key of ["dev", "ino", "mode", "uid", "gid", "nlink", "size"] as const) {
    if (!Number.isSafeInteger(Number(state[key]))) throw new PreviewError("host_io_error");
  }
  return new Proxy(state, { get(target, key) {
    if (typeof key === "string" && /^(a|m|c|birth)timeMs$/.test(key)) {
      const ns = (target as unknown as Record<string, bigint>)[key.replace(/Ms$/, "Ns")];
      return Number(ns / 1000000000n) * 1000 + Number(ns % 1000000000n) / 1000000;
    }
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : typeof value === "bigint" ? Number(value) : value;
  } }) as unknown as Stats;
}

export class ReceiptObservations {
  private readonly observed = new Map<string, ReceiptObservation>();
  private checks = 0;
  private readonly expires: number;
  readonly io: PreviewFs;
  constructor(private readonly root: string, private readonly raw: PreviewFs, private readonly signal: AbortSignal,
    private readonly limits: typeof previewLimits = previewLimits, private readonly now = () => performance.now()) {
    this.expires = now() + limits.deadlineMs;
    this.io = { ...raw, lstat: (async (path: string) => this.capture(path, "target")) as PreviewFs["lstat"] };
  }
  private checkpoint() {
    if (this.signal.aborted) throw new PreviewError("cancelled");
    if (this.now() >= this.expires || ++this.checks > this.limits.filesystemChecks) throw new PreviewError("limit_exceeded");
  }
  private scope(path: string, requested: ReceiptObservation["scope"]) {
    const local = relative(this.root, path);
    return local === "" || local !== ".." && !local.startsWith(".." + sep) && !parse(local).root ? "target" as const : requested;
  }
  private remember(item: ReceiptObservation) {
    const old = this.observed.get(item.path);
    if (old && canonicalSerialize(old.observation) !== canonicalSerialize(item.observation)) throw new PreviewError("target_changed");
    this.observed.set(item.path, item);
  }
  async capture(path: string, requested: ReceiptObservation["scope"]) {
    this.checkpoint();
    const scope = this.scope(path, requested);
    try {
      const state = await this.raw.lstat(path, { bigint: true });
      if (typeof state.ino !== "bigint") throw new PreviewError("host_io_error");
      this.remember({ scope, path, observation: observation(state) });
      return numericStats(state);
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      this.remember({ scope, path, observation: code === "ENOENT" ? { state: "absent" } :
        { state: "unverified", reason: ["ELOOP", "ENOTDIR"].includes(code ?? "") ? "unsafe_entry" : "unreadable" } });
      throw error;
    }
  }
  async initialize() {
    const anchor = parse(this.root).root;
    let current = anchor;
    for (const part of ["", ...relative(anchor, this.root).split(sep)]) {
      if (part) current = join(current, part);
      const state = await this.capture(current, "anchor");
      if (!state.isDirectory() || await this.raw.realpath(current) !== current) throw new PreviewError("target_changed");
    }
  }
  snapshot(): ReceiptObservation[] { return [...this.observed.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))); }
  async verify() {
    for (const item of this.snapshot()) {
      try { await this.capture(item.path, item.scope); }
      catch (error) { if (error instanceof PreviewError) throw error; }
    }
    if (await this.raw.realpath(this.root) !== this.root) throw new PreviewError("target_changed");
  }
  directoryEffects(destinations: string[]): PreviewManifest["directoryEffects"] {
    const missing = new Map<string, string>();
    for (const destination of destinations) {
      const parts = destination.split("/");
      let absentAncestor: string | undefined;
      for (let depth = 1; depth < parts.length; depth++) {
        const path = parts.slice(0, depth).join("/");
        const state = this.observed.get(join(this.root, path))?.observation;
        if (state?.state === "absent") absentAncestor ??= path;
        if (absentAncestor) missing.set(path, absentAncestor);
      }
    }
    return [...missing].sort(([a], [b]) => a.split("/").length - b.split("/").length || Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([destination, absentAncestor]) => ({ destination, status: "create", mode: 0o755, absentAncestor }));
  }
}
