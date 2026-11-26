import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import contribute from "../index.server.ts";
import { validateDirectory } from "../server/validate-directory.ts";
import { catalogSettings, catalogSource } from "../shared/catalog-settings.ts";
import { catalogLoadRpc, foundationStatusRpc, targetScanSubscription, validateDirectoryRpc } from "../shared/rpc.ts";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "project-skills-test-"));
  t.after(() => rm(directory, { recursive: true }));
  return directory;
}

test("directory validation accepts Git and non-Git directories and canonicalizes a link", async (t) => {
  const root = await fixture(t);
  const git = join(root, "git");
  const plain = join(root, "plain");
  const link = join(root, "alias");
  await mkdir(join(git, ".git"), { recursive: true });
  await mkdir(plain);
  await symlink(plain, link, "junction");
  for (const [path, expected] of [[git, git], [plain, plain], [link, plain]]) {
    assert.deepEqual(await validateDirectory({ path }), { status: "ready", directory: await realpath(expected) });
  }
});

test("directory validation rejects relative, nonexistent, file and NUL-containing paths", async (t) => {
  const root = await fixture(t);
  const file = join(root, "file.txt");
  await writeFile(file, "sentinel");
  for (const [path, code] of [
    ["relative/path", "invalid_path"], [join(root, "absent"), "missing"],
    [file, "not_directory"], [root + "\0", "invalid_path"],
  ]) assert.deepEqual(await validateDirectory({ path }), { status: "error", code });
});

test("directory validation maps real permission errors", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "Requires non-root POSIX permissions" : false,
}, async (t) => {
  const root = await fixture(t);
  const restricted = join(root, "restricted");
  await mkdir(restricted);
  await chmod(restricted, 0);
  try {
    assert.deepEqual(await validateDirectory({ path: restricted }), { status: "error", code: "permission_denied" });
  } finally {
    await chmod(restricted, 0o700);
  }
});

test("catalog settings default to unset and accept full SHAs and tag names", () => {
  const { schema } = catalogSettings;
  assert.equal(catalogSettings.scope, "host");
  assert.equal(catalogSource, "https://github.com/anmeo2204/project-skills");
  assert.deepEqual(schema.parse({}), { catalogRef: "" });
  for (const catalogRef of ["", "0123456789abcdef".repeat(2) + "01234567", "v1.2.3", "releases/v1"]) {
    assert.equal(schema.parse({ catalogRef }).catalogRef, catalogRef);
  }
});

test("catalog settings reject abbreviated SHAs, revision expressions and explicit branches", () => {
  for (const catalogRef of [
    "123abcd", "a".repeat(39), "HEAD", "refs/heads/main", "refs/remotes/origin/main",
    "v1^", "v1..2", "v1 beta", "v1@{1}", ".hidden/v1", "v1.lock", "/v1",
  ]) assert.equal(catalogSettings.schema.safeParse({ catalogRef }).success, false, catalogRef);
  // A bare name is ambiguous in Git. This settings layer only stores it as a tag candidate.
  // There is no resolver (and thus no branch fallback) in Foundation.
  assert.equal(catalogSettings.schema.parse({ catalogRef: "main" }).catalogRef, "main");
});

test("server contribution registers the expected typed contracts and host settings", async () => {
  const handlers = new Map();
  const settings = [];
  const cleanup = contribute({
    handle: (contract, handler) => handlers.set(contract, handler),
    registerSettings(definition) {
      settings.push(definition);
      return { read: async () => ({ status: "ready", revision: "host-settings", values: { catalogRef: "" } }) };
    },
  });
  assert.deepEqual([...handlers.keys()], [foundationStatusRpc, validateDirectoryRpc, catalogLoadRpc, targetScanSubscription]);
  assert.deepEqual(settings, [catalogSettings]);
  assert.deepEqual(foundationStatusRpc.output.parse(handlers.get(foundationStatusRpc)({})), { status: "ready" });
  assert.equal(foundationStatusRpc.input.safeParse({ extra: true }).success, false);
  assert.equal(validateDirectoryRpc.input.safeParse({ path: 7 }).success, false);
  assert.equal(validateDirectoryRpc.output.safeParse({ status: "ready" }).success, false);
  assert.deepEqual(await handlers.get(catalogLoadRpc)({}), {
    status: "error", code: "not_configured", settingsRevision: "host-settings", requestedRef: "",
  });
  assert.equal(typeof cleanup, "function");
  await cleanup();
});
