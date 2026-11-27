import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createCanonicalPreviewHandler } from "../server/canonical-preview.ts";
import { CatalogGit } from "../server/catalog-git.ts";
import { CatalogLoader } from "../server/catalog-loader.ts";
import { CatalogError } from "../server/catalog-error.ts";
import { previewDiff } from "../server/preview-diff.ts";
import { previewLimits } from "../server/preview-limits.ts";
import { ProjectScanner } from "../server/project-scanner.ts";
import { catalogSource } from "../shared/catalog-settings.ts";
import { canonicalPreviewRpc } from "../shared/rpc.ts";
import { selectionIntentV1Schema } from "../shared/selection-intent.ts";

const exec = promisify(execFile);
const sha = "a".repeat(40);
const file = (path, value, mode = "100644") => {
  const bytes = Buffer.from(value);
  return { path, bytes, mode, sizeBytes: bytes.length,
    blobSha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") };
};
const skill = (id = "demo", supportingFiles = []) => ({
  id, directory: "skills/" + id, metadata: { name: id, description: "Fixture skill." },
  entrypoint: file("SKILL.md", `---\nname: ${id}\ndescription: Fixture skill.\n---\n\nBody.\n`), supportingFiles,
});
const snapshot = (skills = [skill()]) => ({ schemaVersion: 1, source: catalogSource, commitSha: sha, skills });
const intent = (root, extra = {}) => ({ schemaVersion: 1, hostId: "fixture-host", canonicalDirectory: root,
  catalogSource, catalogCommitSha: sha, settingsRevision: "revision", selectedSkillIds: ["demo"],
  targetProviderIds: [], recommendationRequestId: "scan-fixture", ...extra });
const context = { paseo: new Proxy({ hosts: { list: async () => ({ self: { serverId: "fixture-host" }, hosts: [] }) } }, {
  get(target, property) { assert.equal(property, "hosts", "Preview must never access agent/model/provider/workspace APIs"); return target[property]; },
}) };
const state = (ref = sha, revision = "revision") => ({ status: "ready", revision, values: { catalogRef: ref } });
const error = (code) => ({ status: "error", code });
const dest = (name = "SKILL.md", id = "demo") => `.agents/skills/${id}/${name}`;
const at = (result, name = "SKILL.md", id = "demo") => result.entries.find((e) => e.destination === dest(name, id));

async function fixture(t) {
  const temp = await fs.mkdtemp(join(tmpdir(), "canonical-preview-"));
  const base = await fs.realpath(temp);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, "target"); await fs.mkdir(root);
  const put = async (path, content, mode = 0o644) => {
    await fs.mkdir(dirname(join(root, path)), { recursive: true });
    await fs.writeFile(join(root, path), content); await fs.chmod(join(root, path), mode);
  };
  const handler = (data = snapshot(), options = {}, settings = { read: async () => state() }, loader = { load: async () => data }) => {
    const h = createCanonicalPreviewHandler(settings, loader, options);
    t.after(() => h.dispose());
    return (value = intent(root)) => h.handle(value, context);
  };
  return { base, root, put, handler };
}
async function tree(root) {
  const output = [];
  async function visit(path, relative = ".") {
    const stat = await fs.lstat(path);
    output.push({ path: relative, mode: stat.mode & 0o7777, type: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file",
      ...(stat.isSymbolicLink() ? { link: await fs.readlink(path) } : stat.isFile() ? {
        size: stat.size, hash: createHash("sha256").update(await fs.readFile(path)).digest("hex"),
      } : {}) });
    if (stat.isDirectory()) for (const name of (await fs.readdir(path)).sort()) await visit(join(path, name), relative === "." ? name : relative + "/" + name);
  }
  await visit(root); return output;
}

test("SelectionIntentV1 runtime contract is strict and preserves the existing wire shape", () => {
  assert.deepEqual(selectionIntentV1Schema.parse(intent("/fixture")), intent("/fixture"));
  for (const bad of [
    { schemaVersion: 2 }, { hostId: "" }, { canonicalDirectory: "/bad\0path" }, { catalogCommitSha: "short" },
    { catalogSource: "https://invalid.test" }, { selectedSkillIds: ["demo", "demo"] },
    { selectedSkillIds: ["../escape"] }, { targetProviderIds: ["codex", "codex"] },
    { targetProviderIds: ["unrecognized"] }, { recommendationRequestId: "bad id" }, { arbitrary: true },
  ]) assert.equal(canonicalPreviewRpc.input.safeParse(intent("/fixture", bad)).success, false, JSON.stringify(bad));
});

test("production CatalogLoader previews every legacy package file, binary and executable, read-only without providers", async (t) => {
  const f = await fixture(t); const catalog = join(f.base, "catalog"); await fs.mkdir(catalog);
  const git = async (...args) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", catalog, ...args])).stdout.trim();
  const s = skill("demo", [file("LICENSE", "License\n"), file("nested/raw.bin", [0, 255, 10]),
    file("scripts/check.sh", "#!/bin/sh\necho fixture\n", "100755"), file("empty.txt", "")]);
  for (const v of [s.entrypoint, ...s.supportingFiles]) {
    const path = join(catalog, "skills/demo", v.path); await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, v.bytes); await fs.chmod(path, v.mode === "100755" ? 0o755 : 0o644);
  }
  await git("init", "-b", "main"); await git("add", "--", "skills"); await git("commit", "-m", "legacy fixture");
  const legacy = await git("rev-parse", "HEAD");
  const loader = new CatalogLoader(new CatalogGit({ fixtureRemote: catalog })); t.after(() => loader.dispose());
  const run = f.handler(undefined, {}, { read: async () => state(legacy) }, loader);
  await f.put("sentinel", "keep", 0o600); const before = await tree(f.root);
  const result = await run(intent(f.root, { catalogCommitSha: legacy }));
  assert.equal(result.status, "ready", JSON.stringify(result));
  assert.equal(result.entries.length, 5); assert.ok(result.entries.every((e) => e.status === "create"));
  assert.equal(at(result, "nested/raw.bin").change.kind, "binary");
  assert.equal(at(result, "scripts/check.sh").proposed.mode, 0o755);
  assert.match(at(result).change.unifiedDiff, /new file mode 100644/);
  assert.equal(canonicalPreviewRpc.output.safeParse(result).success, true);
  assert.deepEqual(await tree(f.root), before);
});

test("fresh destinations report unchanged, byte/mode conflicts and binary summaries without changing tree/hashes/modes", async (t) => {
  const f = await fixture(t);
  const s = skill("demo", [file("same.txt", "same\n"), file("different.txt", "new\n"), file("mode.sh", "same", "100755"),
    file("binary.dat", [0, 1, 255]), file("new.txt", "new file\n"), file("empty.txt", "")]);
  await f.put(dest(), s.entrypoint.bytes); await f.put(dest("same.txt"), "same\n");
  await f.put(dest("different.txt"), "old\n"); await f.put(dest("mode.sh"), "same", 0o644);
  await f.put(dest("binary.dat"), Buffer.from([0, 2, 255])); await f.put(dest("empty.txt"), "");
  await f.put(dest("user-custom.txt"), "preserve");
  const before = await tree(f.root); const result = await f.handler(snapshot([s]))();
  assert.equal(result.status, "ready"); assert.equal(at(result).status, "unchanged");
  assert.equal(at(result, "empty.txt").status, "unchanged");
  assert.equal(at(result, "different.txt").status, "conflict");
  assert.match(at(result, "different.txt").change.unifiedDiff, /-old\n\+new\n/);
  assert.equal(at(result, "mode.sh").status, "conflict");
  assert.match(at(result, "mode.sh").change.unifiedDiff, /old mode 100644\nnew mode 100755/);
  assert.equal(at(result, "binary.dat").change.kind, "binary");
  assert.notEqual(at(result, "binary.dat").existing.sha256, at(result, "binary.dat").proposed.sha256);
  assert.equal(at(result, "new.txt").status, "create"); assert.equal(at(result, "user-custom.txt"), undefined);
  assert.deepEqual(await tree(f.root), before);
  await fs.chmod(join(f.root, dest("same.txt")), 0o600);
  assert.equal(at(await f.handler(snapshot([s]))(), "same.txt").status, "conflict");
});

test("text patches are deterministic unified diffs, preserve CRLF and missing final newline, and pass git apply --check", async (t) => {
  const f = await fixture(t); await exec("git", ["init", "-b", "main", f.root]);
  const cases = [["old\n", "new\n"], ["same\nlast", "same\nother"], ["a\r\nb\r\n", "a\r\nc\r\n"],
    ["", "added\n"], ["deleted\n", ""], ["a\nb\nc\nd\ne\nf\ng\nh\ni\n", "a\nb\nc\nd\nX\ne\nf\ng\nh\ni\n"]];
  for (const [index, [old, next]] of cases.entries()) {
    const path = `example-${index}.txt`; await f.put(path, old);
    const diff = previewDiff(path, Buffer.from(old), Buffer.from(next), 0o644, 0o644);
    assert.equal(diff.kind, "text");
    const patch = join(f.base, "change.patch"); await fs.writeFile(patch, diff.unifiedDiff);
    const before = await tree(f.root); await exec("git", ["-C", f.root, "apply", "--check", patch]);
    assert.deepEqual(await tree(f.root), before);
    assert.equal(diff.unifiedDiff, previewDiff(path, Buffer.from(old), Buffer.from(next), 0o644, 0o644).unifiedDiff);
  }
  assert.equal(previewDiff("binary", undefined, Buffer.from([0xff]), undefined, 0o644).kind, "binary");
});

test("stable ordering ignores catalog/selection/provider order and includes applicability sidecars as ordinary data", async (t) => {
  const f = await fixture(t);
  const a = skill("alpha", [file("applicability.json", '{"schemaVersion":999}\n'), file("z.txt", "z"), file("a.txt", "a")]);
  const b = skill("beta");
  const first = await f.handler(snapshot([b, a]))(intent(f.root, { selectedSkillIds: ["beta", "alpha"], targetProviderIds: ["kiro", "codex"] }));
  const second = await f.handler(snapshot([{ ...a, supportingFiles: [...a.supportingFiles].reverse() }, b]))(
    intent(f.root, { selectedSkillIds: ["alpha", "beta"], targetProviderIds: ["codex", "kiro"] }));
  assert.deepEqual(first, second); assert.equal(first.status, "ready");
  assert.equal(first.entries.length, 5); assert.equal(at(first, "applicability.json", "alpha").status, "create");
  const empty = await f.handler()(intent(f.root, { selectedSkillIds: [] })); assert.deepEqual(empty.entries, []);
});

test("host, settings, catalog provenance and all selected IDs are revalidated before destination reads", async (t) => {
  const f = await fixture(t); let opens = 0; const io = { ...fs, open: async (...args) => { opens++; return fs.open(...args); } };
  const run = f.handler(snapshot(), { io });
  assert.deepEqual(await run(intent(f.root, { hostId: "other-host" })), error("host_mismatch"));
  assert.deepEqual(await run(intent(f.root, { settingsRevision: "stale" })), error("settings_changed"));
  assert.deepEqual(await run(intent(f.root, { catalogCommitSha: "b".repeat(40) })), error("catalog_mismatch"));
  assert.deepEqual(await run(intent(f.root, { catalogSource: "untrusted" })), error("invalid_selection"));
  assert.deepEqual(await run(intent(f.root, { selectedSkillIds: ["demo", "missing"] })), error("invalid_selection"));
  assert.equal(opens, 0);
  let ref;
  await f.handler(snapshot(), {}, { read: async () => state("moving-tag") }, { load: async (value) => { ref = value; return snapshot(); } })();
  assert.equal(ref, "moving-tag");
  assert.deepEqual(await f.handler(snapshot(), {}, { read: async () => ({ status: "invalid", revision: "revision" }) })(), error("settings_changed"));
});

test("malicious catalog descriptors, aliases, duplicates and blob corruption never reach filesystem reads", async (t) => {
  const f = await fixture(t); let opens = 0; const io = { ...fs, open: async () => { opens++; throw Error("must not open"); } };
  for (const path of ["../outside", "/outside", "a\\b", "a:b", "a/./b", ".git/config", "name.", "NUL.txt", "a//b"]) {
    assert.deepEqual(await f.handler(snapshot([skill("demo", [file(path, "bad")])]), { io })(), error("invalid_catalog"), path);
  }
  for (const extra of [[file("SKILL.md", "duplicate")], [file("a", "file"), file("a/b", "nested")],
    [file("A.txt", "a"), file("a.txt", "b")], [file("A/one", "a"), file("a/two", "b")],
    [{ ...file("body", "bad"), blobSha: "0".repeat(40) }]]) {
    assert.deepEqual(await f.handler(snapshot([skill("demo", extra)]), { io })(), error("invalid_catalog"));
  }
  assert.equal(opens, 0);
});

test("symlink ancestors/leaves, wrong file types, hardlinks and FIFO destinations are blocked without reading outside", async (t) => {
  const f = await fixture(t); const outside = join(f.base, "outside"); await fs.mkdir(outside);
  await fs.writeFile(join(outside, "sentinel"), "private bytes"); let opens = [];
  const io = { ...fs, open: async (path, ...args) => { opens.push(path); return fs.open(path, ...args); } };
  const run = f.handler(snapshot(), { io });
  await fs.symlink(outside, join(f.root, ".agents")); const before = await tree(f.root);
  assert.equal(at(await run()).status, "blocked"); assert.deepEqual(await tree(f.root), before);
  await fs.unlink(join(f.root, ".agents")); await f.put(".agents", "not a directory");
  assert.equal(at(await run()).status, "blocked"); await fs.unlink(join(f.root, ".agents"));
  await fs.mkdir(join(f.root, dest()), { recursive: true }); assert.equal(at(await run()).status, "blocked");
  await fs.rmdir(join(f.root, dest())); await fs.symlink(join(outside, "sentinel"), join(f.root, dest()));
  assert.equal(at(await run()).status, "blocked"); await fs.unlink(join(f.root, dest()));
  await fs.link(join(outside, "sentinel"), join(f.root, dest())); assert.equal(at(await run()).status, "blocked");
  await fs.unlink(join(f.root, dest()));
  if (process.platform !== "win32") { await exec("mkfifo", [join(f.root, dest())]); assert.equal(at(await run()).status, "blocked"); }
  assert.deepEqual(opens, []); assert.equal(await fs.readFile(join(outside, "sentinel"), "utf8"), "private bytes");
});

test("supporting-file symlinks are blocked individually and never borrowed from scanner inventory", async (t) => {
  const f = await fixture(t); const s = skill("demo", [file("refs/note.md", "new"), file("safe.txt", "safe")]);
  const outside = join(f.base, "outside"); await fs.mkdir(outside); await fs.writeFile(join(outside, "note.md"), "private");
  await f.put(dest(), s.entrypoint.bytes); await fs.symlink(outside, join(f.root, ".agents/skills/demo/refs"));
  const before = await tree(f.root); const result = await f.handler(snapshot([s]))();
  assert.equal(at(result).status, "unchanged"); assert.equal(at(result, "refs/note.md").status, "blocked");
  assert.equal(at(result, "safe.txt").status, "create"); assert.deepEqual(await tree(f.root), before);
});

test("Preview re-reads post-scan changes and rejects missing, aliased and non-directory targets", async (t) => {
  const f = await fixture(t); const s = skill(); await f.put(dest(), s.entrypoint.bytes);
  const scanner = new ProjectScanner(); t.after(() => scanner.dispose());
  assert.notEqual((await scanner.scan({ canonicalDirectory: f.root, requestId: "scan-fixture" }, new AbortController().signal)).status, "error");
  await f.put(dest(), "changed after scan\n"); const before = await tree(f.root);
  assert.equal(at(await f.handler(snapshot([s]))()).status, "conflict"); assert.deepEqual(await tree(f.root), before);
  const alias = join(f.base, "alias"); await fs.symlink(f.root, alias);
  assert.deepEqual(await f.handler()(intent(alias)), error("target_changed"));
  for (const path of [join(f.base, "missing"), join(f.root, dest()), "relative"]) assert.deepEqual(await f.handler()(intent(path)), error("invalid_target"));
});

test("root replacement during catalog loading fails and file changes during final settings read invalidate the entry", async (t) => {
  const f = await fixture(t);
  const run = f.handler(snapshot(), {}, undefined, { load: async () => {
    await fs.rename(f.root, f.root + "-old"); await fs.mkdir(f.root); return snapshot();
  } });
  assert.deepEqual(await run(), error("target_changed"));
  const s = skill(); await f.put(dest(), s.entrypoint.bytes); let reads = 0;
  const result = await f.handler(snapshot([s]), {}, { read: async () => {
    if (++reads === 2) await f.put(dest(), "changed during preview"); return state();
  } })();
  assert.equal(at(result).status, "blocked"); assert.equal(at(result).reason, "entry_changed");
});

test("controlled ancestor replacement is detected before external file bytes can be read", async (t) => {
  const f = await fixture(t); const s = skill(); await f.put(dest(), s.entrypoint.bytes);
  const outside = join(f.base, "outside"); await fs.mkdir(join(outside, "skills/demo"), { recursive: true });
  await fs.writeFile(join(outside, "skills/demo/SKILL.md"), "private"); let replaced = false; let reads = 0;
  const io = { ...fs, open: async (path, ...args) => {
    if (!replaced) { replaced = true; await fs.rename(join(f.root, ".agents"), join(f.root, "original")); await fs.symlink(outside, join(f.root, ".agents")); }
    const handle = await fs.open(path, ...args);
    return { stat: () => handle.stat(), close: () => handle.close(), read: (...args) => { reads++; return handle.read(...args); } };
  } };
  const result = await f.handler(snapshot([s]), { io })();
  assert.equal(at(result).status, "blocked"); assert.equal(reads, 0);
});

test("missing destination created while settings yield becomes blocked instead of stale create", async (t) => {
  const f = await fixture(t); let reads = 0;
  const result = await f.handler(snapshot(), {}, { read: async () => {
    if (++reads === 2) await f.put(dest(), "appeared"); return state();
  } })();
  assert.equal(at(result).status, "blocked"); assert.equal(at(result).reason, "entry_changed");
});

test("resource budgets block oversized reads/diffs and return bounded typed errors without truncated plans", async (t) => {
  const f = await fixture(t); await f.put(dest(), "x".repeat(100));
  const before = await tree(f.root);
  assert.equal(at(await f.handler(snapshot(), { limits: { ...previewLimits, fileBytes: 10 } })()).reason, "read_limit");
  assert.equal(at(await f.handler(snapshot(), { limits: { ...previewLimits, readBytes: 10 } })()).reason, "read_limit");
  assert.equal(at(await f.handler(snapshot(), { limits: { ...previewLimits, diffBytes: 10 } })()).reason, "diff_limit");
  for (const limits of [{ responseBytes: 20 }, { files: 0 }, { filesystemChecks: 0 }, { deadlineMs: 0 }]) {
    assert.deepEqual(await f.handler(snapshot(), { limits: { ...previewLimits, ...limits } })(), error("limit_exceeded"));
  }
  assert.deepEqual(await tree(f.root), before);
});

test("settings changes, catalog errors, busy slots and dispose fail closed without agent/model calls", async (t) => {
  const f = await fixture(t); let reads = 0;
  assert.deepEqual(await f.handler(snapshot(), {}, { read: async () => state(sha, ++reads === 1 ? "revision" : "new") })(), error("settings_changed"));
  assert.deepEqual(await f.handler(snapshot(), {}, undefined, { load: async () => { throw Error("raw private stderr"); } })(), error("host_io_error"));
  assert.deepEqual(await f.handler(snapshot(), {}, undefined, { load: async () => { throw new CatalogError("network_error"); } })(), error("catalog_unavailable"));
  const deferred = Promise.withResolvers(); const started = Promise.withResolvers();
  const h = createCanonicalPreviewHandler({ read: async () => state() }, { load: async () => { started.resolve(); return deferred.promise; } });
  const first = h.handle(intent(f.root), context); await started.promise;
  assert.deepEqual(await h.handle(intent(f.root), context), error("busy"));
  const dispose = h.dispose(); deferred.resolve(snapshot());
  assert.deepEqual(await first, error("cancelled")); await dispose;
  assert.deepEqual(await h.handle(intent(f.root), context), error("cancelled"));
});

test("permission denied and cross-device destinations are blocked without leaking raw errors", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "Requires non-root POSIX permissions" : false,
}, async (t) => {
  const f = await fixture(t); await f.put(dest(), "private", 0);
  try { const result = await f.handler()(); assert.equal(at(result).status, "blocked"); assert.equal(at(result).reason, "unreadable"); }
  finally { await fs.chmod(join(f.root, dest()), 0o644); }
  const io = { ...fs, lstat: async (path, ...args) => {
    const stat = await fs.lstat(path, ...args);
    if (path === join(f.root, ".agents")) Object.defineProperty(stat, "dev", { value: stat.dev + 1 });
    return stat;
  } };
  assert.equal(at(await f.handler(snapshot(), { io })()).status, "blocked");
});

test("a nested selected target plans inside that exact directory and never uses ancestor installations", async (t) => {
  const f = await fixture(t); const nested = join(f.root, "nested"); await fs.mkdir(nested);
  await f.put(dest(), "ancestor custom skill");
  const before = await tree(f.root); const result = await f.handler()(intent(nested));
  assert.equal(result.status, "ready"); assert.equal(result.intent.canonicalDirectory, nested);
  assert.equal(at(result).status, "create"); assert.deepEqual(await tree(f.root), before);
});

test("a file mutated while its handle is read is blocked and its bytes are discarded", async (t) => {
  const f = await fixture(t); await f.put(dest(), skill().entrypoint.bytes);
  let mutated = false;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return { stat: () => handle.stat(), close: () => handle.close(), read: async (...readArgs) => {
      const chunk = await handle.read(...readArgs);
      if (!mutated) { mutated = true; await f.put(dest(), "changed during read"); }
      return chunk;
    } };
  } };
  const result = await f.handler(snapshot(), { io })();
  assert.equal(at(result).status, "blocked"); assert.equal(at(result).reason, "entry_changed");
  assert.equal(at(result).existing, undefined); assert.equal(at(result).change, undefined);
});
