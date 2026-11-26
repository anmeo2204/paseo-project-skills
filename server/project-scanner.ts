import { lstat } from "node:fs/promises";
import { relativePath, type EvidenceRef, type ProjectEvidence, type ProjectFact, type ProjectWarning, type ScanEvent } from "../shared/project-evidence";
import { projectDetectors } from "./project-detectors/index";
import type { DetectionContext, ProjectDetector, Role, WorkspaceDeclaration } from "./project-detectors/types";
import { beneath, compare, ProjectReader, ScanStopped, scanLimits, type ProjectEntry, type ReaderFs } from "./project-reader";
import { validateDirectory } from "./validate-directory";

type Boundary = ProjectEvidence["boundaries"][number];
type Options = { detectors?: readonly ProjectDetector[]; io?: ReaderFs; now?: () => number; limits?: typeof scanLimits };
type Input = { requestId: string; canonicalDirectory: string };
const budgetCodes = new Set<ProjectWarning["code"]>([
  "max_depth", "directory_budget", "entry_budget", "boundary_budget", "file_budget", "file_size", "byte_budget", "response_budget", "deadline",
]);
const depth = (path: string) => path === "." ? 0 : path.split("/").length;
const parent = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
const encoded = (value: unknown) => JSON.stringify(value);
const sorted = <T>(values: Iterable<T>, key: (value: T) => string) => [...values].sort((a, b) => compare(key(a), key(b)));

function segmentMatches(name: string, segment: string) {
  if (!segment.includes("*")) return name === segment;
  const [prefix, suffix] = segment.split("*");
  return name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix);
}

async function resolveMembers(root: string, declaration: WorkspaceDeclaration, reader: ProjectReader, warn: DetectionContext["warn"], limits: typeof scanLimits) {
  const source = decodeURIComponent(declaration.evidenceId.split("#")[0]);
  const accepted = new Set<string>();
  const excluded = new Set<string>();
  for (const raw of declaration.patterns) {
    reader.checkpoint();
    const negative = raw.startsWith("!");
    const value = (negative ? raw.slice(1) : raw).replace(/^\.\//, "").replace(/\/$/, "");
    if ((!relativePath.safeParse(value).success && raw !== "./") || /[{}\[\]?!()]/.test(value) ||
        value.split("/").some((part) => part.split("*").length > 2 && part !== "**")) {
      warn("unsupported_workspace_pattern", source);
      continue;
    }
    if (value === "." || raw === "./") {
      (negative ? excluded : accepted).add(root);
      continue;
    }
    const segments = value.split("/");
    const matches = new Set<string>();
    const visited = new Set<string>();
    async function expand(path: string, index: number): Promise<void> {
      reader.checkpoint();
      const state = path + "\0" + index;
      if (visited.has(state)) return;
      visited.add(state);
      if (depth(path) > limits.memberDepth) {
        warn("max_depth", source);
        return;
      }
      if (index === segments.length) { matches.add(path); return; }
      const segment = segments[index];
      if (segment === "**") await expand(path, index + 1);
      for (const entry of await reader.list(path)) {
        if (entry.kind !== "directory") continue;
        if (segment === "**") await expand(entry.path, index);
        else if (segmentMatches(entry.name, segment)) await expand(entry.path, index + 1);
      }
    }
    await expand(root, 0);
    if (!negative && !matches.size && !value.includes("*")) warn("missing_member", source);
    const packageWorkspace = /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|lerna\.json)$/.test(source);
    for (const match of matches) {
      if (packageWorkspace && !negative && value.includes("*") &&
          !(await reader.list(match)).some(({ name, kind }) => name === "package.json" && kind === "file")) continue;
      (negative ? excluded : accepted).add(match);
    }
  }
  return sorted([...accepted].filter((path) => !excluded.has(path)), (path) => path);
}

async function collect(input: Input, signal: AbortSignal, options: Options): Promise<ScanEvent | undefined> {
  const error = (code: Extract<ScanEvent, { status: "error" }>["code"]): ScanEvent => ({ status: "error", requestId: input.requestId, code });
  if (signal.aborted) return;
  const target = await validateDirectory({ path: input.canonicalDirectory });
  if (signal.aborted) return;
  if (target.status === "error") return error(target.code);
  if (target.directory !== input.canonicalDirectory) return error("target_changed");
  const identity = await (options.io?.lstat ?? lstat)(target.directory);
  if (!identity.isDirectory()) return error("target_changed");

  const detectors = options.detectors ?? projectDetectors;
  const limits = options.limits ?? scanLimits;
  const entries = new Map<string, ProjectEntry>();
  const files = new Map<string, readonly ProjectEntry[]>();
  const boundaries = new Map<string, Boundary>();
  const evidence = new Map<string, EvidenceRef>();
  const facts = new Map<string, ProjectFact>();
  const inventory: ProjectEvidence["inventory"] = [];
  const warnings = new Map<string, ProjectWarning>();
  const unknown = new Map<string, ProjectEvidence["coverage"]["unknown"][number]>();
  const appliedLimits = new Set<ProjectWarning["code"]>();
  let partial = false;
  const warn: DetectionContext["warn"] = (code, path) => {
    partial = true;
    if (budgetCodes.has(code)) appliedLimits.add(code);
    const warning = { code, ...(path ? { relativePath: path } : {}) };
    if (warnings.size < limits.warnings) warnings.set(encoded(warning), warning);
  };
  const reader = new ProjectReader(target.directory, identity, (path) => {
    for (const detector of detectors) {
      const mode = detector.candidate?.(path);
      if (mode) return mode;
    }
  }, warn, signal, options.io, options.now, limits);
  const addBoundary = (path: string, role: Role, id?: string) => {
    let boundary = boundaries.get(path);
    if (!boundary) {
      if (boundaries.size >= limits.boundaries) { warn("boundary_budget"); return; }
      boundary = { rootRelativePath: path, roles: [], memberships: [], evidenceIds: [] };
      boundaries.set(path, boundary);
    }
    if (!boundary.roles.includes(role)) boundary.roles.push(role);
    if (id && !boundary.evidenceIds.includes(id)) boundary.evidenceIds.push(id);
    return boundary;
  };
  addBoundary(".", "root");
  const ref: DetectionContext["ref"] = (path, kind = "presence", selector) => {
    const id = encodeURIComponent(path) + "#" + kind + (selector ? "#" + selector : "");
    evidence.set(id, { id, relativePath: path, kind, ...(selector ? { selector } : {}) });
    return id;
  };
  const contextFor = (root: string, declarations: WorkspaceDeclaration[]) => ({
    root, files: files.get(root) ?? [],
    read: async (path: string) => entries.get(path)?.kind === "file" ? reader.read(path) : undefined,
    ref, warn,
    boundary: (role: Role, evidenceId: string) => { addBoundary(root, role, evidenceId); },
    workspace: (declaration: WorkspaceDeclaration) => { declarations.push(declaration); },
  });
  try {
    const pending = ["."];
    const members: string[] = [];
    const visited = new Set<string>();
    while (members.length || pending.length) {
      reader.checkpoint();
      const root = members.shift() ?? pending.shift()!;
      if (visited.has(root)) continue;
      visited.add(root);
      const listing = await reader.list(root);
      files.set(root, listing);
      for (const entry of listing) entries.set(entry.path, entry);
      const declarations: WorkspaceDeclaration[] = [];
      const context = contextFor(root, declarations);
      for (const detector of detectors) {
        reader.checkpoint();
        await detector.discover?.(context);
      }
      for (const declaration of declarations) {
        addBoundary(root, "workspace", declaration.evidenceId);
        for (const member of await resolveMembers(root, declaration, reader, warn, limits)) {
          if (member === root) {
            addBoundary(root, "application", declaration.evidenceId);
            continue;
          }
          const boundary = addBoundary(member, "package", declaration.evidenceId);
          if (boundary && !boundary.memberships.some(({ workspaceRoot, evidenceId }) =>
            workspaceRoot === root && evidenceId === declaration.evidenceId)) {
            boundary.memberships.push({ workspaceRoot: root, evidenceId: declaration.evidenceId });
          }
          if (boundary && !visited.has(member)) members.push(member);
        }
      }
      for (const entry of listing) {
        if (entry.kind !== "directory") continue;
        if (depth(entry.path) <= limits.depth) pending.push(entry.path);
        else if (!boundaries.has(entry.path)) warn("max_depth", entry.path);
      }
    }
    const owned = new Map<string, ProjectEntry[]>();
    for (const entry of sorted(entries.values(), (value) => value.path)) {
      let owner = entry.kind === "directory" && boundaries.has(entry.path) ? entry.path : parent(entry.path);
      while (!boundaries.has(owner)) owner = parent(owner);
      const list = owned.get(owner);
      if (list) list.push(entry);
      else owned.set(owner, [entry]);
    }
    for (const boundary of sorted(boundaries.values(), (value) => value.rootRelativePath)) {
      const root = boundary.rootRelativePath;
      const context: DetectionContext = {
        ...contextFor(root, []),
        owned: owned.get(root) ?? [],
        shared: sorted(new Set(boundary.memberships.map((entry) => entry.workspaceRoot)), (value) => value),
        fact(fact) {
          const { evidenceIds, ...fields } = fact;
          const key = encoded(fields);
          const mapKey = root + "\0" + key;
          const known = facts.get(mapKey);
          if (known) known.evidenceIds = sorted(new Set([...known.evidenceIds, ...evidenceIds]), (id) => id);
          else facts.set(mapKey, { ...fact, evidenceIds: sorted(new Set(evidenceIds), (id) => id), boundaryPath: root });
        },
        inventory(entry) { inventory.push({ ...entry, boundaryPath: root }); },
        unknown(key, reason = "insufficient_evidence") { unknown.set(root + "\0" + key, { boundaryPath: root, key, reason }); },
      };
      for (const detector of detectors) {
        reader.checkpoint();
        await detector.detect?.(context);
      }
      if (![...facts.values()].some((fact) => fact.boundaryPath === root && fact.kind === "language")) context.unknown("language");
      if (![...facts.values()].some((fact) => fact.boundaryPath === root && fact.kind === "framework")) context.unknown("framework");
    }
    reader.checkpoint();
  } catch (stopped) {
    if (!(stopped instanceof ScanStopped)) throw stopped;
    if (stopped.code === "cancelled" || signal.aborted) return;
    if (stopped.code === "target_changed") return error(stopped.code);
    warn("deadline");
  }
  if (signal.aborted) return;
  await reader.assertRoot();
  if (signal.aborted) return;

  const output: ProjectEvidence = {
    schemaVersion: 1, target: { canonicalDirectory: target.directory, marker: reader.gitMarker },
    boundaries: sorted(boundaries.values(), (value) => value.rootRelativePath),
    facts: sorted(facts.values(), encoded), evidence: sorted(evidence.values(), (value) => value.id),
    inventory: sorted(inventory, (value) => value.relativePath), warnings: [],
    coverage: { status: "complete", limits: [], unknown: sorted(unknown.values(), encoded) },
  };
  for (const boundary of output.boundaries) {
    boundary.roles.sort(compare);
    boundary.evidenceIds.sort(compare);
    boundary.memberships.sort((a, b) => compare(encoded(a), encoded(b)));
  }
  const result = (): ScanEvent => {
    output.coverage.status = partial ? "partial" : "complete";
    output.coverage.limits = sorted(appliedLimits, (value) => value);
    output.warnings = sorted(warnings.values(), encoded);
    return { status: partial ? "partial" : "ready", requestId: input.requestId, evidence: output };
  };
  let event = result();
  if (Buffer.byteLength(encoded(event)) <= limits.responseBytes) return event;
  warn("response_budget");
  // Preserve the already established project boundaries, but omit detail as one unit
  // if the response cannot fit. Keep IDs for the references on retained boundaries.
  output.facts = [];
  output.inventory = [];
  output.coverage.unknown = [];
  const retained = new Set(output.boundaries.flatMap((boundary) => [...boundary.evidenceIds, ...boundary.memberships.map((entry) => entry.evidenceId)]));
  output.evidence = output.evidence.filter((entry) => retained.has(entry.id));
  event = result();
  if (Buffer.byteLength(encoded(event)) <= limits.responseBytes) return event;
  output.boundaries = [{ rootRelativePath: ".", roles: ["root"], memberships: [], evidenceIds: [] }];
  output.evidence = [];
  warnings.clear();
  warn("response_budget");
  event = result();
  return Buffer.byteLength(encoded(event)) <= limits.responseBytes ? event : error("scan_failed");
}

export class ProjectScanner {
  private disposed = false;
  private readonly active = new Map<AbortController, Promise<ScanEvent | undefined>>();

  constructor(private readonly options: Options = {}) {}

  async scan(input: Input, signal: AbortSignal): Promise<ScanEvent | undefined> {
    if (this.disposed || signal.aborted) return;
    if (this.active.size >= (this.options.limits ?? scanLimits).concurrent) {
      return { status: "error", requestId: input.requestId, code: "busy" };
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const work = collect(input, controller.signal, this.options);
    this.active.set(controller, work);
    try {
      return await work;
    } catch (error) {
      if (controller.signal.aborted) return;
      return { status: "error", requestId: input.requestId,
        code: error instanceof ScanStopped && error.code === "target_changed" ? "target_changed" : "scan_failed" };
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(controller);
    }
  }

  async dispose() {
    this.disposed = true;
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled(this.active.values());
  }
}
