import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CatalogGit } from "../server/catalog-git.ts";
import { catalogLimits } from "../server/catalog-limits.ts";
import { CatalogLoader, describeCatalog } from "../server/catalog-loader.ts";
import { loadCatalogForHost } from "../server/catalog-rpc.ts";
import { catalogLoadRpc } from "../shared/rpc.ts";

const exec = promisify(execFile);
const skill = (slug, description = "A valid skill.") => `---\nname: ${slug}\ndescription: ${description}\n---\n\n# Workflow\n`;
const unknownSha = "0000000000000000000000000000000000000001";
const failure = (code, diagnostic) => (error) => {
  assert.equal(error.code, code);
  if (diagnostic) assert.ok(error.diagnostics?.some((item) => item.code === diagnostic));
  return true;
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "project-skills-catalog-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "catalog");
  const tempRoot = join(root, "staging");
  const target = join(root, "target");
  await Promise.all([repo, tempRoot, target].map((path) => mkdir(path)));
  const git = async (...args) => (await exec("git", [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null",
    "-C", repo, ...args,
  ])).stdout.trim();
  await git("init", "-b", "main");
  const put = async (relative, content) => {
    const path = join(repo, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  };
  const commit = async (message) => {
    await git("add", "-A");
    await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const transport = new CatalogGit({ fixtureRemote: repo, tempRoot, ...options });
  const loader = new CatalogLoader(transport);
  t.after(() => loader.dispose());
  await put("skills/fixture-skill/SKILL.md", skill("fixture-skill"));
  await writeFile(join(target, "sentinel"), "target");
  const first = await commit("first");
  return { repo, tempRoot, target, git, put, commit, transport, loader, first };
}

test("full SHA, lightweight and nested annotated tags resolve without branch fallback", async (t) => {
  const f = await fixture(t);
  await f.git("tag", "main", f.first);
  await f.git("tag", "-a", "v/annotated", "-m", "annotated", f.first);
  await f.git("branch", "branch-only", f.first);
  await f.put("README.md", "new branch HEAD");
  const second = await f.commit("second");
  assert.equal((await f.loader.load(second.toUpperCase())).commitSha, second);
  for (const ref of [f.first, "main", "v/annotated"]) {
    assert.equal((await f.loader.load(ref)).commitSha, f.first);
  }
  for (const ref of ["branch-only", "missing", unknownSha]) {
    await assert.rejects(f.loader.load(ref), failure("revision_unavailable"));
  }
  for (const ref of [f.first.slice(0, 7), "HEAD", "refs/heads/main", "v/annotated^", "x".repeat(257)]) {
    await assert.rejects(f.loader.load(ref), failure("invalid_revision"));
  }
  const blob = await f.git("rev-parse", f.first + ":skills/fixture-skill/SKILL.md");
  await f.git("tag", "blob-target", blob);
  await assert.rejects(f.loader.load("blob-target"), failure("revision_unavailable"));
  await assert.rejects(f.loader.load(await f.git("rev-parse", "refs/tags/v/annotated")), failure("revision_unavailable"));
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("mutable tags re-resolve and deleted tags never serve old cached snapshots", async (t) => {
  const f = await fixture(t);
  await f.git("tag", "release", f.first);
  assert.equal((await f.loader.load("release")).commitSha, f.first);
  await f.put("skills/fixture-skill/SKILL.md", skill("fixture-skill", "Changed."));
  const second = await f.commit("second");
  await f.git("tag", "-f", "release", second);
  assert.equal((await f.loader.load("release")).commitSha, second);
  await f.git("tag", "-d", "release");
  await assert.rejects(f.loader.load("release"), failure("revision_unavailable"));
  assert.equal((await f.loader.load(second)).commitSha, second);
});

test("discovery is dynamic and retains raw nested binaries, source notices and modes", async (t) => {
  const f = await fixture(t);
  const original = Buffer.from(skill("arbitrary-new-skill").replaceAll("\n", "\r\n"));
  const binary = Buffer.from([0, 255, 13, 10, 128]);
  await f.put("skills/arbitrary-new-skill/SKILL.md", original);
  await f.put("skills/arbitrary-new-skill/references/fixture.bin", binary);
  await f.put("skills/arbitrary-new-skill/LICENSE", "fixture notice");
  await f.put("skills/arbitrary-new-skill/SOURCES.md", "[upstream](https://example.invalid/)");
  await f.put("skills/arbitrary-new-skill/scripts/helper", "#!/bin/sh\nexit 99\n");
  await chmod(join(f.repo, "skills/arbitrary-new-skill/scripts/helper"), 0o755);
  await f.put("skills/index.txt", "ignored");
  await f.put("README.md", "placeholder skills/missing/SKILL.md");
  const sha = await f.commit("add skill outside known groups");
  const snapshot = await f.loader.load(sha);
  assert.deepEqual(snapshot.skills.map(({ id }) => id), ["arbitrary-new-skill", "fixture-skill"]);
  const item = snapshot.skills[0];
  assert.deepEqual(item.entrypoint.bytes, original);
  assert.deepEqual(item.supportingFiles.map(({ path }) => path), ["LICENSE", "SOURCES.md", "references/fixture.bin", "scripts/helper"]);
  assert.deepEqual(item.supportingFiles[2].bytes, binary);
  assert.equal(item.supportingFiles[3].mode, "100755");
  assert.ok(!JSON.stringify(describeCatalog(snapshot)).includes('"bytes"'));
  assert.equal(await f.git("rev-parse", "HEAD"), sha);
  assert.equal(await f.git("status", "--porcelain"), "");
  assert.deepEqual(await readdir(f.target), ["sentinel"]);
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("one malformed skill rejects the snapshot and reports bounded diagnostics", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["duplicate keys", "---\nname: example-skill\nname: example-skill\ndescription: Test\n---\n"],
    ["malformed YAML", "---\nname: [\n---\n"],
    ["typed metadata", "---\nname: example-skill\ndescription: true\n---\n"],
    ["aliases", "---\nname: example-skill\na: &anchor Test\ndescription: *anchor\n---\n"],
    ["merge", "---\nname: example-skill\ndescription: Test\n<<: {}\n---\n"],
    ["custom tag", "---\nname: example-skill\ndescription: !custom Test\n---\n"],
    ["too long", skill("example-skill", "a".repeat(1025))],
    ["bad UTF-8", Buffer.from([255])],
    ["mismatched name", skill("another-skill")],
  ];
  for (const [label, value] of cases) {
    await f.put("skills/example-skill/SKILL.md", value);
    const sha = await f.commit(label);
    await assert.rejects(f.loader.load(sha), failure("invalid_catalog", "malformed_metadata"));
  }
  await f.put("skills/example-skill/SKILL.md", skill("fixture-skill"));
  const duplicate = await f.commit("duplicate metadata name");
  await assert.rejects(f.loader.load(duplicate), failure("invalid_catalog", "duplicate_skill_id"));
  await rm(join(f.repo, "skills/example-skill/SKILL.md"));
  await f.put("skills/example-skill/LICENSE", "notice");
  const incomplete = await f.commit("missing SKILL.md");
  await assert.rejects(f.loader.load(incomplete), failure("invalid_catalog", "missing_entrypoint"));
  assert.equal((await f.loader.load(f.first)).skills.length, 1);
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("symlinks, gitlinks and unsafe repository paths reject the full snapshot", async (t) => {
  const f = await fixture(t);
  const link = "skills/fixture-skill/escape";
  await symlink(join(f.target, "sentinel"), join(f.repo, link));
  await assert.rejects(f.loader.load(await f.commit("symlink")), failure("invalid_catalog", "unsafe_entry"));
  await rm(join(f.repo, link));
  await f.git("add", "-A");
  await f.git("update-index", "--add", "--cacheinfo", "160000," + f.first + ",skills/fixture-skill/submodule");
  await f.git("commit", "-m", "gitlink");
  await assert.rejects(f.loader.load(await f.git("rev-parse", "HEAD")), failure("invalid_catalog", "unsafe_entry"));
  await f.git("update-index", "--force-remove", "skills/fixture-skill/submodule");
  await f.put("skills/fixture-skill/..\\escape", "unsafe");
  await assert.rejects(f.loader.load(await f.commit("unsafe path")), failure("invalid_catalog", "unsafe_entry"));

  const synthetic = new CatalogLoader({
    withRevision: async (sha, read) => read(sha, {
      listSkills: async () => Buffer.from(
        `040000 tree ${sha} -\tskills\0` +
        `040000 tree ${sha} -\tskills/fixture-skill\0` +
        `100644 blob ${sha} 8\tskills/fixture-skill/../outside\0`),
    }),
  });
  await assert.rejects(synthetic.load(f.first), failure("invalid_catalog", "unsafe_entry"));
});

test("same-SHA concurrent requests share work, snapshots stay isolated, and LRU evicts", async (t) => {
  const f = await fixture(t);
  let resolutions = 0;
  const original = f.transport.withRevision.bind(f.transport);
  f.transport.withRevision = (...args) => {
    resolutions++;
    return original(...args);
  };
  const [a, repeated] = await Promise.all([f.loader.load(f.first), f.loader.load(f.first)]);
  assert.strictEqual(a, repeated);
  assert.equal(resolutions, 1);
  await f.put("skills/fixture-skill/SKILL.md", skill("fixture-skill", "B."));
  const b = await f.commit("B");
  await f.put("skills/fixture-skill/SKILL.md", skill("fixture-skill", "C."));
  const c = await f.commit("C");
  const [snapshotB, snapshotC] = await Promise.all([f.loader.load(b), f.loader.load(c)]);
  assert.equal(snapshotB.skills[0].metadata.description, "B.");
  assert.equal(snapshotC.skills[0].metadata.description, "C.");
  await f.loader.load(c);
  assert.equal(resolutions, 3);
  assert.deepEqual(await f.loader.load(f.first), a);
  assert.equal(resolutions, 4);
  await f.loader.load(c);
  assert.equal(resolutions, 4);
  await f.loader.load(b);
  assert.equal(resolutions, 5);
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("failed loads are retried and staging is removed after timeout, limit or disposal", async (t) => {
  const f = await fixture(t, { timeoutMs: 0 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.loader.load(f.first), failure("timeout"));
    assert.deepEqual(await readdir(f.tempRoot), []);
  }

  const small = new CatalogLoader(new CatalogGit({ fixtureRemote: f.repo, tempRoot: f.tempRoot, stagingBytes: 1 }));
  t.after(() => small.dispose());
  await assert.rejects(small.load(f.first), failure("limit_exceeded"));
  assert.deepEqual(await readdir(f.tempRoot), []);

  const normal = new CatalogLoader(new CatalogGit({ fixtureRemote: f.repo, tempRoot: f.tempRoot }));
  t.after(() => normal.dispose());
  await f.put("skills/fixture-skill/oversize.bin", Buffer.alloc(catalogLimits.blobBytes + 1));
  await assert.rejects(normal.load(await f.commit("oversize")), failure("limit_exceeded"));
  const inFlight = normal.load(f.first);
  const rejected = assert.rejects(inFlight, failure("git_error"));
  await normal.dispose();
  await rejected;
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("catalog RPC reads each host setting once and sends only the descriptor projection", async (t) => {
  const f = await fixture(t);
  assert.equal(catalogLoadRpc.input.safeParse({ catalogRef: f.first }).success, false);
  assert.equal(catalogLoadRpc.input.safeParse({ source: f.repo, target: f.target }).success, false);
  let reads = 0;
  const firstHost = {
    read: async () => {
      reads++;
      return { status: "ready", revision: "a", values: { catalogRef: f.first } };
    },
  };
  const secondHost = {
    read: async () => {
      reads++;
      return { status: "ready", revision: "b", values: { catalogRef: unknownSha } };
    },
  };
  const ready = catalogLoadRpc.output.parse(await loadCatalogForHost(firstHost, f.loader));
  const rejected = catalogLoadRpc.output.parse(await loadCatalogForHost(secondHost, f.loader));
  assert.equal(reads, 2);
  assert.equal(ready.status, "ready");
  assert.equal(ready.settingsRevision, "a");
  assert.equal(ready.requestedRef, f.first);
  assert.equal(ready.snapshot.commitSha, f.first);
  assert.ok(!JSON.stringify(ready).includes('"bytes"'));
  assert.equal(rejected.code, "revision_unavailable");
  assert.equal(rejected.settingsRevision, "b");
  assert.equal(rejected.requestedRef, unknownSha);
  const invalid = await loadCatalogForHost({
    read: async () => ({ status: "invalid", revision: "c", error: "internal details" }),
  }, f.loader);
  assert.deepEqual(invalid, { status: "error", code: "invalid_settings", settingsRevision: "c" });
});

test("catalog limits and truncated tree records fail before reading blobs", async () => {
  const oid = "a".repeat(40);
  const root = `040000 tree ${oid} -\tskills\0`;
  const skillDir = `040000 tree ${oid} -\tskills/fixture-skill\0`;
  const record = (path, size) => `100644 blob ${oid} ${size}\tskills/fixture-skill/${path}\0`;
  const cases = [
    [root.slice(0, -1), "invalid_catalog"],
    [root + skillDir + skillDir, "invalid_catalog"],
    [root + skillDir + record("x".repeat(catalogLimits.pathBytes), 1), "limit_exceeded"],
    [root + skillDir + record("SKILL.md", catalogLimits.entrypointBytes + 1), "limit_exceeded"],
    [root + skillDir + Array.from({ length: 9 }, (_, index) => record("file" + index, catalogLimits.blobBytes)).join(""),
      "limit_exceeded"],
    [root + skillDir + Array.from({ length: catalogLimits.entries }, (_, index) => record("file" + index, 0)).join(""),
      "limit_exceeded"],
  ];
  for (const [tree, code] of cases) {
    const loader = new CatalogLoader({
      withRevision: async (sha, read) => read(sha, {
        listSkills: async () => Buffer.from(tree),
        readBlob: () => assert.fail("invalid tree reached blob reader"),
      }),
    });
    await assert.rejects(loader.load(oid), failure(code));
  }
});

test("Git missing, auth failure and network failure are sanitized and tag failure cannot use a cached SHA", async (t) => {
  const f = await fixture(t);
  await f.git("tag", "release", f.first);
  assert.equal((await f.loader.load("release")).commitSha, f.first);
  const bin = join(f.tempRoot, "mock-bin");
  await mkdir(bin);
  const originalPath = process.env.PATH;
  t.after(() => { process.env.PATH = originalPath; });
  process.env.PATH = bin;
  await assert.rejects(f.loader.load("release"), failure("git_unavailable"));
  for (const [message, code] of [
    ["Host key verification failed.", "auth_failed"],
    ["Permission denied (publickey).", "auth_failed"],
    ["Connection timed out", "network_error"],
  ]) {
    await writeFile(join(bin, "git"), `#!/bin/sh
case "$*" in
  *" fetch "*) echo '${message} private details' >&2; exit 1;;
esac
exit 0
`, { mode: 0o700 });
    await assert.rejects(f.loader.load("release"), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      return true;
    });
  }
  assert.equal((await f.loader.load(f.first)).commitSha, f.first);
  assert.deepEqual(await readdir(f.tempRoot), ["mock-bin"]);
});

test("timeout kills a running Git process group and bounds simultaneous staging", async (t) => {
  const f = await fixture(t);
  const bin = join(f.repo, "mock-bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh
case "$*" in
  *" fetch "*) /bin/sleep 30;;
esac
`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  t.after(() => { process.env.PATH = originalPath; });
  process.env.PATH = bin;
  const loader = new CatalogLoader(new CatalogGit({ fixtureRemote: f.repo, tempRoot: f.tempRoot, timeoutMs: 500 }));
  const first = assert.rejects(loader.load(f.first), failure("timeout"));
  const second = assert.rejects(loader.load("slow-tag"), failure("timeout"));
  await assert.rejects(loader.load("third-tag"), failure("limit_exceeded"));
  await Promise.all([first, second]);
  await loader.dispose();
  assert.deepEqual(await readdir(f.tempRoot), []);
});
