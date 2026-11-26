import { TextDecoder } from "node:util";
import { isMap, isScalar, parseDocument, visit } from "yaml";
import {
  catalogSnapshotSchema, commitShaSchema, skillMetadataSchema, skillSlugSchema,
  type CatalogDescriptor, type CatalogDiagnostic, type CatalogSnapshotDescriptor,
} from "../shared/catalog";
import { catalogRefSchema, catalogSource } from "../shared/catalog-settings";
import { CatalogError } from "./catalog-error";
import { CatalogGit, type GitStaging } from "./catalog-git";
import { catalogLimits } from "./catalog-limits";

type CatalogFile = CatalogDescriptor & { bytes: Buffer };
type SkillDescriptor = CatalogSnapshotDescriptor["skills"][number];
type CatalogSkill = Omit<SkillDescriptor, "entrypoint" | "supportingFiles"> & {
  entrypoint: CatalogFile;
  supportingFiles: CatalogFile[];
};
type Snapshot = Omit<CatalogSnapshotDescriptor, "skills"> & { skills: CatalogSkill[] };

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const treeHeader = /^([0-7]{6}) (tree|blob|commit) ([0-9a-f]{40}) +(-|[0-9]+)$/;

function invalid(code: CatalogDiagnostic["code"], path?: string) {
  return new CatalogError("invalid_catalog", [path === undefined ? { code } : { code, path }]);
}

function safePath(path: string) {
  return path.split("/").every((segment) =>
    segment && segment !== "." && segment !== ".." &&
    !/^[a-z]:|[\\\u0000-\u001f\u007f]/i.test(segment) &&
    !/^\.git[. ]*$/i.test(segment),
  );
}

function listSkills(tree: Buffer) {
  const directories = new Map<string, CatalogDescriptor[]>();
  const paths = new Map<string, boolean>();
  let total = 0;
  for (let offset = 0; offset < tree.length;) {
    const end = tree.indexOf(0, offset);
    const tab = tree.indexOf(9, offset);
    if (end === -1 || tab === -1 || tab >= end) throw invalid("invalid_tree");
    const header = treeHeader.exec(tree.toString("latin1", offset, tab));
    if (!header) throw invalid("invalid_tree");
    if (end - tab - 1 > catalogLimits.pathBytes) throw new CatalogError("limit_exceeded");
    let path: string;
    try {
      path = decoder.decode(tree.subarray(tab + 1, end));
    } catch {
      throw invalid("unsafe_entry");
    }
    offset = end + 1;
    if (!safePath(path) || (path !== "skills" && !path.startsWith("skills/"))) throw invalid("unsafe_entry");
    if (paths.has(path)) throw invalid("duplicate_skill_id", path);
    const [, mode, objectType, blobSha, rawSize] = header;
    const isTree = mode === "040000" && objectType === "tree" && rawSize === "-";
    const isBlob = (mode === "100644" || mode === "100755") && objectType === "blob" && rawSize !== "-";
    if (!isTree && !isBlob) throw invalid("unsafe_entry", path);
    if (path === "skills" ? !isTree : paths.get(path.slice(0, path.lastIndexOf("/"))) !== true) {
      throw invalid("invalid_tree", path);
    }
    paths.set(path, isTree);
    if (paths.size > catalogLimits.entries + 1) throw new CatalogError("limit_exceeded");
    if (path === "skills") continue;
    const [, id, ...relative] = path.split("/");
    if (relative.length === 0) {
      if (isTree) {
        if (!skillSlugSchema.safeParse(id).success) throw invalid("malformed_metadata", path);
        directories.set(id, []);
        if (directories.size > catalogLimits.skills) throw new CatalogError("limit_exceeded");
      }
      continue;
    }
    if (!isBlob) continue;
    const filePath = relative.join("/");
    const sizeBytes = Number(rawSize);
    total += sizeBytes;
    if (sizeBytes > catalogLimits.blobBytes || total > catalogLimits.snapshotBytes ||
        (filePath === "SKILL.md" && sizeBytes > catalogLimits.entrypointBytes)) {
      throw new CatalogError("limit_exceeded");
    }
    const files = directories.get(id);
    if (!files) throw invalid("invalid_tree", path);
    files.push({ path: filePath, blobSha, sizeBytes, mode });
  }
  if (directories.size === 0) throw invalid("invalid_tree", "skills");
  return directories;
}

function parseMetadata(bytes: Buffer) {
  try {
    const text = decoder.decode(bytes);
    const frontmatter = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
    if (frontmatter?.index !== 0) return undefined;
    const doc = parseDocument(frontmatter[1], { uniqueKeys: true, merge: false, strict: true });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) return undefined;
    let unsupported = false;
    visit(doc, {
      Alias() { unsupported = true; return visit.BREAK; },
      Node(_key, node) {
        if ("tag" in node && node.tag !== undefined) {
          unsupported = true;
          return visit.BREAK;
        }
      },
      Pair(_key, pair) {
        if (isScalar(pair.key) && pair.key.value === "<<") {
          unsupported = true;
          return visit.BREAK;
        }
      },
    });
    if (unsupported) return undefined;
    return skillMetadataSchema.safeParse(doc.toJS({ maxAliasCount: 0 })).data;
  } catch {
    return undefined;
  }
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

async function discover(commitSha: string, git: GitStaging): Promise<Snapshot> {
  const directories = listSkills(await git.listSkills(commitSha));
  const skills: CatalogSkill[] = [];
  const diagnostics: CatalogDiagnostic[] = [];
  const names = new Set<string>();
  const read = async (file: CatalogDescriptor): Promise<CatalogFile> => ({
    ...file,
    bytes: await git.readBlob(file.blobSha, file.sizeBytes),
  });
  for (const id of [...directories.keys()].sort(compare)) {
    const directory = "skills/" + id;
    const path = directory + "/SKILL.md";
    const files = directories.get(id)!;
    const descriptor = files.find((file) => file.path === "SKILL.md");
    if (!descriptor) {
      diagnostics.push({ code: "missing_entrypoint", path });
    } else {
      const entrypoint = await read(descriptor);
      const metadata = parseMetadata(entrypoint.bytes);
      if (metadata && names.has(metadata.name)) diagnostics.push({ code: "duplicate_skill_id", path });
      if (metadata) names.add(metadata.name);
      if (!metadata || metadata.name !== id) {
        diagnostics.push({ code: "malformed_metadata", path });
      } else if (diagnostics.length === 0) {
        const supportingFiles = [];
        for (const file of files.sort((a, b) => compare(a.path, b.path))) {
          if (file !== descriptor) supportingFiles.push(await read(file));
        }
        skills.push({ id, directory, metadata, entrypoint, supportingFiles });
      }
    }
    if (diagnostics.length >= catalogLimits.diagnostics) break;
  }
  if (diagnostics.length) throw new CatalogError("invalid_catalog", diagnostics.slice(0, catalogLimits.diagnostics));
  return { schemaVersion: 1, source: catalogSource, commitSha, skills };
}

export function describeCatalog(snapshot: Snapshot): CatalogSnapshotDescriptor {
  const descriptor = catalogSnapshotSchema.parse(snapshot);
  if (Buffer.byteLength(JSON.stringify(descriptor)) > catalogLimits.rpcBytes) {
    throw new CatalogError("limit_exceeded");
  }
  return descriptor;
}

export class CatalogLoader {
  // The source is fixed for the lifetime of this cache, so the key is the resolved SHA.
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pendingShas = new Map<string, Promise<Snapshot>>();
  private disposed = false;

  constructor(private readonly git = new CatalogGit()) {}

  async dispose() {
    this.disposed = true;
    this.snapshots.clear();
    await this.git.dispose();
  }

  async load(ref: string) {
    if (this.disposed) throw new CatalogError("git_error");
    if (!ref) throw new CatalogError("not_configured");
    if (Buffer.byteLength(ref) > catalogLimits.refBytes || !catalogRefSchema.safeParse(ref).success) {
      throw new CatalogError("invalid_revision");
    }
    const normalized = ref.toLowerCase();
    if (!commitShaSchema.safeParse(normalized).success) return this.loadRevision(ref);
    const cached = this.touch(normalized);
    if (cached) return cached;
    const pending = this.pendingShas.get(normalized);
    if (pending) return pending;
    const operation = this.loadRevision(normalized);
    this.pendingShas.set(normalized, operation);
    try {
      return await operation;
    } finally {
      this.pendingShas.delete(normalized);
    }
  }

  private touch(sha: string) {
    const snapshot = this.snapshots.get(sha);
    if (snapshot) {
      this.snapshots.delete(sha);
      this.snapshots.set(sha, snapshot);
    }
    return snapshot;
  }

  private async loadRevision(ref: string) {
    const snapshot = await this.git.withRevision(ref, async (sha, git) => {
      const cached = this.touch(sha);
      if (cached) return cached;
      const validated = await discover(sha, git);
      describeCatalog(validated);
      return validated;
    });
    if (this.disposed) throw new CatalogError("git_error");
    const cached = this.touch(snapshot.commitSha);
    if (cached) return cached;
    this.snapshots.set(snapshot.commitSha, snapshot);
    if (this.snapshots.size > catalogLimits.cachedSnapshots) {
      this.snapshots.delete(this.snapshots.keys().next().value!);
    }
    return snapshot;
  }
}
