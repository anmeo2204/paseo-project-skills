import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { CatalogGit, parseLsRemoteTags } from "../server/catalog-git.ts";
import { CatalogLoader } from "../server/catalog-loader.ts";
import {
  CatalogReleaseCache,
  classifyCatalogUpdates,
  compareStableSemver,
  extractStableReleases,
  parseStableSemver,
} from "../server/catalog-releases.ts";
import {
  listCatalogReleasesForHost,
  loadCatalogForHost,
  resolveCatalogForHost,
} from "../server/catalog-rpc.ts";
import { catalogSettingsSchema } from "../shared/catalog-settings.ts";

const exec = promisify(execFile);
const skill = (slug, description = "A valid skill.") =>
  `---\nname: ${slug}\ndescription: ${description}\n---\n\n# Workflow\n`;

async function gitFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "project-skills-releases-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "catalog");
  const tempRoot = join(root, "staging");
  await Promise.all([mkdir(repo), mkdir(tempRoot)]);
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
  const transport = new CatalogGit({ fixtureRemote: repo, tempRoot });
  const loader = new CatalogLoader(transport);
  const releases = new CatalogReleaseCache(transport);
  t.after(async () => {
    releases.dispose();
    await loader.dispose();
  });
  await put("skills/fixture-skill/SKILL.md", skill("fixture-skill"));
  const first = await commit("first");
  return { repo, tempRoot, git, put, commit, transport, loader, releases, first };
}

const settingsHandle = (values, revision = "rev-1", status = "ready") => ({
  read: async () => (status === "ready"
    ? { status: "ready", revision, values: catalogSettingsSchema.parse(values) }
    : { status: "invalid", revision, error: "invalid" }),
});

test("catalogSettingsSchema preserves v1 compatibility and validates managed modes", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(catalogSettingsSchema.parse({}), { catalogRef: "" });
  assert.deepEqual(catalogSettingsSchema.parse({ catalogRef: sha }), { catalogRef: sha });
  assert.deepEqual(catalogSettingsSchema.parse({ catalogRef: "v0.1.0" }), { catalogRef: "v0.1.0" });
  assert.deepEqual(
    catalogSettingsSchema.parse({ catalogRef: sha, selectionMode: "latest_stable", selectedTag: "v0.1.0" }),
    { catalogRef: sha, selectionMode: "latest_stable", selectedTag: "v0.1.0" },
  );
  // Managed modes must pin a 40-char SHA and stable SemVer tag.
  assert.equal(catalogSettingsSchema.safeParse({ catalogRef: "v0.1.0", selectionMode: "latest_stable", selectedTag: "v0.1.0" }).success, false);
  assert.equal(catalogSettingsSchema.safeParse({ catalogRef: sha, selectionMode: "specific_version", selectedTag: "v0.1.0-rc.1" }).success, false);
  assert.equal(catalogSettingsSchema.safeParse({ catalogRef: "", selectionMode: "latest_stable" }).success, false);
});

test("parseLsRemoteTags peels annotated tags and SemVer sorting excludes pre-releases and non-SemVer tags (D3)", () => {
  const sha1 = "1".repeat(40);
  const sha2 = "2".repeat(40);
  const sha3 = "3".repeat(40);
  const tagObj = "9".repeat(40);
  const stdout = [
    `${sha1}\trefs/tags/v0.2.0`,
    `${tagObj}\trefs/tags/v0.10.0`,
    `${sha2}\trefs/tags/v0.10.0^{}`,
    `${sha3}\trefs/tags/v0.11.0-rc.1`,
    `${sha3}\trefs/tags/latest`,
    `${sha3}\trefs/tags/main`,
    `${sha3}\trefs/heads/main`,
  ].join("\n");
  const tags = parseLsRemoteTags(stdout);
  assert.equal(tags.get("v0.10.0"), sha2);
  assert.equal(tags.get("v0.2.0"), sha1);
  assert.equal(tags.get("v0.11.0-rc.1"), sha3);
  assert.equal(tags.has("refs/heads/main"), false);

  assert.deepEqual(parseStableSemver("v0.10.0"), [0, 10, 0]);
  assert.equal(parseStableSemver("v0.11.0-rc.1"), null);
  assert.equal(parseStableSemver("v01.0.0"), null);
  assert.ok(compareStableSemver("v0.10.0", "v0.2.0") > 0);

  const stable = extractStableReleases(tags);
  assert.deepEqual(stable, [
    { tag: "v0.10.0", commitSha: sha2 },
    { tag: "v0.2.0", commitSha: sha1 },
  ]);
});

test("zero-tag repository fails closed with no_stable_releases and never falls back to main HEAD (D2)", async (t) => {
  const f = await gitFixture(t);
  // main has a valid skill commit, but zero tags exist.
  const listed = await listCatalogReleasesForHost(settingsHandle({ catalogRef: "" }), f.releases, {});
  assert.equal(listed.status, "ready");
  assert.equal(listed.latestStable, null);
  assert.deepEqual(listed.releases, []);
  assert.equal(listed.updateStatus, "no_stable_releases");
  assert.equal(listed.updateAvailable, false);

  const resolved = await resolveCatalogForHost(f.loader, f.releases, { mode: "latest_stable" });
  assert.deepEqual(resolved, { status: "error", code: "no_stable_releases" });

  // Advanced custom revision with explicit 40-char SHA still works.
  const custom = await resolveCatalogForHost(f.loader, f.releases, { mode: "custom", ref: f.first });
  assert.equal(custom.status, "ready");
  assert.equal(custom.commitSha, f.first);
  assert.equal(custom.resolvedTag, undefined);
});

test("P1 update detection distinguishes newer, older, up-to-date, moved/deleted tag, custom, legacy, unconfigured and missing releases", () => {
  const sha1 = "1".repeat(40);
  const sha2 = "2".repeat(40);
  const sha3 = "3".repeat(40);
  const tags = new Map([
    ["v0.1.0", sha1],
    ["v0.2.0", sha2],
  ]);
  const stable = extractStableReleases(tags);

  // 1. Unconfigured
  const unconfigured = classifyCatalogUpdates(tags, stable, { catalogRef: "" });
  assert.equal(unconfigured.updateStatus, "unconfigured");
  assert.equal(unconfigured.updateAvailable, false);

  // 2. Up to date
  const upToDate = classifyCatalogUpdates(tags, stable, {
    catalogRef: sha2, selectionMode: "latest_stable", selectedTag: "v0.2.0",
  });
  assert.equal(upToDate.updateStatus, "up_to_date");
  assert.equal(upToDate.updateAvailable, false);
  assert.deepEqual(upToDate.releases.map((r) => [r.tag, r.relation]), [
    ["v0.2.0", "active"],
    ["v0.1.0", "older"],
  ]);

  // 3. Strictly newer SemVer available
  const updateAvail = classifyCatalogUpdates(tags, stable, {
    catalogRef: sha1, selectionMode: "specific_version", selectedTag: "v0.1.0",
  });
  assert.equal(updateAvail.updateStatus, "update_available");
  assert.equal(updateAvail.updateAvailable, true);
  assert.deepEqual(updateAvail.releases.map((r) => [r.tag, r.relation]), [
    ["v0.2.0", "newer"],
    ["v0.1.0", "active"],
  ]);

  // 4. Moved tag (retargeted on remote) — MUST NOT be treated as a normal update!
  const movedTags = new Map([
    ["v0.1.0", sha3],
    ["v0.2.0", sha2],
  ]);
  const moved = classifyCatalogUpdates(movedTags, extractStableReleases(movedTags), {
    catalogRef: sha1, selectionMode: "specific_version", selectedTag: "v0.1.0",
  });
  assert.equal(moved.updateStatus, "moved_tag");
  assert.equal(moved.updateAvailable, false);
  assert.deepEqual(moved.movedTag, { tag: "v0.1.0", pinnedCommitSha: sha1, remoteCommitSha: sha3 });

  // 5. Deleted tag on remote — also moved_tag, NOT a normal update!
  const deletedTags = new Map([["v0.2.0", sha2]]);
  const deleted = classifyCatalogUpdates(deletedTags, extractStableReleases(deletedTags), {
    catalogRef: sha1, selectionMode: "specific_version", selectedTag: "v0.1.0",
  });
  assert.equal(deleted.updateStatus, "moved_tag");
  assert.equal(deleted.updateAvailable, false);
  assert.deepEqual(deleted.movedTag, { tag: "v0.1.0", pinnedCommitSha: sha1, remoteCommitSha: null });

  // 6. Custom revision (even with unequal SHA) — MUST NOT infer a normal update!
  const custom = classifyCatalogUpdates(tags, stable, { catalogRef: sha3, selectionMode: "custom" });
  assert.equal(custom.updateStatus, "custom_revision");
  assert.equal(custom.updateAvailable, false);
  assert.deepEqual(custom.releases.map((r) => r.relation), ["uncompared", "uncompared"]);

  // Custom SHA matching a release commit marks same_commit without falsely treating as managed update
  const customSame = classifyCatalogUpdates(tags, stable, { catalogRef: sha1 });
  assert.equal(customSame.updateStatus, "custom_revision");
  assert.equal(customSame.updateAvailable, false);
  assert.deepEqual(customSame.releases.map((r) => [r.tag, r.relation]), [
    ["v0.2.0", "uncompared"],
    ["v0.1.0", "same_commit"],
  ]);

  // 7. Legacy unpinned tag
  const legacy = classifyCatalogUpdates(tags, stable, { catalogRef: "v0.1.0" });
  assert.equal(legacy.updateStatus, "legacy_unpinned");
  assert.equal(legacy.updateAvailable, false);

  // 8. Missing stable releases
  const missing = classifyCatalogUpdates(new Map(), [], { catalogRef: "" });
  assert.equal(missing.updateStatus, "no_stable_releases");
  assert.equal(missing.updateAvailable, false);
});

test("P2 displayed revision consistency rejects stale_selection when remote tag moves between listing and resolve", async (t) => {
  const f = await gitFixture(t);
  await f.git("tag", "-a", "v0.1.0", "-m", "v0.1.0", f.first);

  const listed = await listCatalogReleasesForHost(settingsHandle({ catalogRef: "" }), f.releases, {});
  assert.equal(listed.status, "ready");
  assert.deepEqual(listed.latestStable, { tag: "v0.1.0", commitSha: f.first });

  // Remote publishes a new commit and moves v0.1.0 + adds v0.2.0 before the user confirms!
  await f.put("skills/fixture-skill/SKILL.md", skill("fixture-skill", "Updated."));
  const second = await f.commit("second");
  await f.git("tag", "-f", "v0.1.0", second);
  await f.git("tag", "-a", "v0.2.0", "-m", "v0.2.0", second);

  // Latest Stable bound to previously displayed v0.1.0 / first SHA must fail closed with stale_selection
  const staleLatest = await resolveCatalogForHost(f.loader, f.releases, {
    mode: "latest_stable",
    expectedTag: "v0.1.0",
    expectedCommitSha: f.first,
  });
  assert.deepEqual(staleLatest, { status: "error", code: "stale_selection" });

  // Specific Version bound to previously displayed v0.1.0 / first SHA must also fail closed
  const staleSpecific = await resolveCatalogForHost(f.loader, f.releases, {
    mode: "specific_version",
    tag: "v0.1.0",
    expectedCommitSha: f.first,
  });
  assert.deepEqual(staleSpecific, { status: "error", code: "stale_selection" });

  // After refreshing, resolving with the new displayed SHA succeeds and warms CatalogLoader SHA cache
  const refreshed = await listCatalogReleasesForHost(settingsHandle({ catalogRef: "" }), f.releases, { refresh: true });
  assert.equal(refreshed.status, "ready");
  assert.deepEqual(refreshed.latestStable, { tag: "v0.2.0", commitSha: second });

  const ok = await resolveCatalogForHost(f.loader, f.releases, {
    mode: "latest_stable",
    expectedTag: "v0.2.0",
    expectedCommitSha: second,
  });
  assert.equal(ok.status, "ready");
  assert.equal(ok.commitSha, second);
  assert.equal(ok.resolvedTag, "v0.2.0");
  assert.equal(ok.skillCount, 1);

  // Subsequent catalog.load hits CatalogLoader's SHA cache without needing remote tags
  await f.git("tag", "-d", "v0.2.0");
  const loaded = await loadCatalogForHost(
    settingsHandle({ catalogRef: second, selectionMode: "latest_stable", selectedTag: "v0.2.0" }),
    f.loader,
  );
  assert.equal(loaded.status, "ready");
  assert.equal(loaded.snapshot.commitSha, second);
});

test("CatalogReleaseCache enforces TTL, refresh cooldown, bypassCooldown and single-flight coalescing", async () => {
  let mono = 1_000;
  let wall = 1_700_000_000_000;
  let calls = 0;
  let deferred = null;
  const sha = "a".repeat(40);
  const git = {
    listTags: () => {
      calls++;
      if (deferred) return deferred.promise;
      return Promise.resolve(new Map([["v0.1.0", sha]]));
    },
  };
  const cache = new CatalogReleaseCache(git, {
    now: () => mono,
    wallNow: () => wall,
    ttlMs: 60_000,
    refreshCooldownMs: 5_000,
  });

  // Single-flight deduplication
  deferred = Promise.withResolvers();
  const p1 = cache.get();
  const p2 = cache.get();
  assert.equal(calls, 1);
  deferred.resolve(new Map([["v0.1.0", sha]]));
  deferred = null;
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.cached, false);
  assert.equal(r2.cached, false);

  // Within TTL -> cached
  mono += 2_000;
  const r3 = await cache.get();
  assert.equal(r3.cached, true);
  assert.equal(calls, 1);

  // Refresh within 5s cooldown -> still cached
  const r4 = await cache.get({ refresh: true });
  assert.equal(r4.cached, true);
  assert.equal(calls, 1);

  // Refresh with bypassCooldown (used by catalog.resolve) -> fetches fresh
  const r5 = await cache.get({ refresh: true, bypassCooldown: true });
  assert.equal(r5.cached, false);
  assert.equal(calls, 2);

  // After cooldown passes, refresh: true fetches fresh
  mono += 6_000;
  const r6 = await cache.get({ refresh: true });
  assert.equal(r6.cached, false);
  assert.equal(calls, 3);

  // After TTL passes, normal get fetches fresh
  mono += 61_000;
  const r7 = await cache.get();
  assert.equal(r7.cached, false);
  assert.equal(calls, 4);

  cache.dispose();
  await assert.rejects(cache.get(), { code: "git_error" });
});
