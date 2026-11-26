import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import contribute from "../index.server.ts";
import { ProjectScanner } from "../server/project-scanner.ts";
import { projectDetectors } from "../server/project-detectors/index.ts";
import { scanLimits } from "../server/project-reader.ts";
import { targetScanSubscription } from "../shared/rpc.ts";

async function fixture(t) {
  const temporary = await fs.mkdtemp(join(tmpdir(), "project-scanner-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = await fs.realpath(temporary);
  const put = async (path, value = "") => {
    await fs.mkdir(dirname(join(root, path)), { recursive: true });
    await fs.writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  return { root, put };
}

const input = (root, requestId = "scan") => ({ requestId, canonicalDirectory: root });
async function scan(root, options) {
  const scanner = new ProjectScanner(options);
  const result = await scanner.scan(input(root), new AbortController().signal);
  return targetScanSubscription.event.parse(result);
}
const keys = (result, kind, root = ".") => result.evidence.facts.filter((fact) =>
  fact.kind === kind && fact.boundaryPath === root).map(({ key }) => key);
const includes = (result, kind, expected, root) => {
  const found = keys(result, kind, root);
  for (const item of expected) assert.ok(found.includes(item), `${kind} ${item} missing from ${found.join(", ")}`);
};
const warning = (result, code) => assert.ok(result.evidence.warnings.some((entry) => entry.code === code), JSON.stringify(result.evidence.warnings));

test("mixed technology evidence covers Go, React, Next.js, Laravel and generic files without cross-boundary leakage", async (t) => {
  const f = await fixture(t);
  await f.put("package.json", { workspaces: ["apps/*"], packageManager: "pnpm@10.2.5", dependencies: { redis: "^5.0.0" } });
  await f.put("package-lock.json", "{}");
  await f.put("apps/web/package.json", { dependencies: { next: "^15.2.1", react: "^19.0.0", "react-hook-form": "^7", "@tanstack/react-query": "^5" },
    devDependencies: { vitest: "^4" }, scripts: { test: "private script" } });
  await f.put("apps/web/src/app/page.tsx");
  await f.put("apps/web/pages/legacy.tsx");
  await f.put("apps/web/next.config.ts");
  await f.put("apps/web/embedded/package.json", { dependencies: { react: "^19" } });
  await f.put("apps/api/go.mod", "module example.test/api\ngo 1.24.1\nrequire (\n github.com/go-chi/chi/v5 v5.0.0\n github.com/jackc/pgx/v5 v5.0.0\n github.com/hibiken/asynq v0.1.0\n)\n");
  await f.put("apps/api/api_test.go");
  await f.put("apps/api/migrations/new.sql");
  await f.put("apps/worker/composer.json", { require: { "laravel/framework": "^12", "illuminate/queue": "^12", "ext-pdo": "*" },
    "require-dev": { "pestphp/pest": "^3" } });
  for (const file of ["artisan", "routes/api.php", "config/queue.php", "config/database.php", "database/migrations/test.php"]) {
    await f.put("apps/worker/" + file);
  }
  await f.put("another/pyproject.toml", "[project]");
  await f.put("another/run.py");
  await f.put("README.md", "Never emit this prose");
  await f.put("AGENTS.md", "Project instructions");
  await f.put(".github/workflows/test.yml", "private pipeline");
  const result = await scan(f.root);
  assert.equal(result.status, "partial");
  warning(result, "manager_conflict");
  includes(result, "build", ["github-actions"]);
  includes(result, "package_manager", ["npm", "pnpm"]);
  includes(result, "framework", ["nextjs", "react"], "apps/web");
  includes(result, "router", ["nextjs-app", "nextjs-pages"], "apps/web");
  includes(result, "test", ["vitest", "test-script"], "apps/web");
  includes(result, "dependency", ["react-hook-form", "@tanstack/react-query"], "apps/web");
  assert.ok(!keys(result, "dependency", "apps/web").includes("redis"));
  includes(result, "framework", ["react"], "apps/web/embedded");
  assert.deepEqual(keys(result, "router", "apps/web/embedded"), []);
  includes(result, "language", ["go"], "apps/api");
  includes(result, "router", ["github.com/go-chi/chi/v5"], "apps/api");
  includes(result, "database", ["github.com/jackc/pgx/v5", "migration-directory"], "apps/api");
  includes(result, "queue", ["github.com/hibiken/asynq"], "apps/api");
  includes(result, "test", ["go-test"], "apps/api");
  includes(result, "framework", ["laravel"], "apps/worker");
  includes(result, "queue", ["illuminate/queue", "queue.php"], "apps/worker");
  includes(result, "database", ["ext-pdo", "database.php"], "apps/worker");
  includes(result, "test", ["pestphp/pest"], "apps/worker");
  includes(result, "language", ["python"], "another");
  assert.equal(result.evidence.boundaries.find((boundary) => boundary.rootRelativePath === "apps/web").memberships[0].workspaceRoot, ".");
  assert.ok(result.evidence.coverage.unknown.some(({ key }) => key === "database_runtime"));
  const serialized = JSON.stringify(result);
  for (const prohibited of ["private script", "Never emit this prose", "private pipeline", "Project instructions"]) assert.ok(!serialized.includes(prohibited));
  assert.deepEqual(await scan(f.root), result);
});

test("Angular projects inherit only Angular declarations from the identified workspace and expose builder tooling", async (t) => {
  const f = await fixture(t);
  await f.put("package.json", { dependencies: { "@angular/core": "^20", "@angular/forms": "^20", "@angular/router": "^20", pg: "^8" } });
  await f.put("angular.json", { projects: { portal: { root: "apps/portal", architect: {
    build: { builder: "@angular/build:application" }, test: { builder: "@angular/build:unit-test" },
  } }, panel: { root: "./apps/panel/" } } });
  await f.put("apps/portal/src/main.ts");
  await f.put("apps/panel/src/main.ts");
  await f.put("apps/sibling/src/main.ts");
  const result = await scan(f.root);
  for (const member of ["apps/portal", "apps/panel"]) {
    includes(result, "framework", ["angular"], member);
    includes(result, "dependency", ["@angular/forms", "@angular/router"], member);
    assert.ok(result.evidence.facts.some((fact) => fact.boundaryPath === member && fact.declaredAt === "."));
    assert.ok(!keys(result, "dependency", member).includes("pg"));
  }
  includes(result, "build", ["@angular/build/application"], "apps/portal");
  includes(result, "test", ["@angular/build/unit-test"], "apps/portal");
  assert.ok(!result.evidence.boundaries.some(({ rootRelativePath }) => rootRelativePath === "apps/sibling"));
});

test("pnpm exclusions, Go workspaces and unsupported patterns obey separate membership evidence", async (t) => {
  const f = await fixture(t);
  await f.put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n  - "!packages/skip"\n  - "{apps,libs}/*"\n');
  await f.put("packages/keep/package.json", {});
  await f.put("packages/skip/package.json", {});
  await f.put("packages/nopkg/README.md");
  await f.put("go.work", 'go 1.23\nuse (\n ./modules/core\n "./modules/worker"\n ../outside\n)\n');
  await f.put("modules/core/go.mod", "module example.test/core\ngo 1.23\n");
  await f.put("modules/worker/go.mod", "module example.test/worker\ngo 1.23\n");
  const result = await scan(f.root);
  const byPath = new Map(result.evidence.boundaries.map((entry) => [entry.rootRelativePath, entry]));
  for (const member of ["packages/keep", "modules/core", "modules/worker"]) {
    assert.equal(byPath.get(member).memberships.length, 1);
  }
  assert.equal(byPath.get("packages/skip").memberships.length, 0);
  assert.equal(byPath.has("packages/nopkg"), false);
  warning(result, "unsupported_workspace_pattern");
});

test("WordPress site components and standalone classic theme use headers, not folder-only cues", async (t) => {
  const f = await fixture(t);
  await f.put("wp-content/plugins/good/bootstrap.php", "<?php\n/*\nPlugin Name: Example Plugin\n*/\n");
  await f.put("wp-content/plugins/plain/plain.php", "<?php\nfunction ordinary() {}\n");
  await f.put("wp-content/themes/block/style.css", "/*\nTheme Name: Block Child\nTemplate: example-parent\n*/");
  await f.put("wp-content/themes/block/theme.json", "{}");
  await f.put("wp-content/themes/block/templates/index.html");
  await f.put("wp-config.php", "<?php private config");
  await f.put("app/page.tsx");
  await f.put("angular.json", { projects: {} });
  await f.put("artisan");
  const result = await scan(f.root);
  includes(result, "framework", ["wordpress-plugin"], "wp-content/plugins/good");
  includes(result, "framework", ["wordpress-theme", "wordpress-block-theme", "wordpress-child-theme"], "wp-content/themes/block");
  assert.deepEqual(keys(result, "framework"), []);
  assert.deepEqual(keys(result, "router"), []);
  const classic = await fixture(t);
  await classic.put("style.css", "/*\nTheme Name: Example Classic\n*/");
  await classic.put("index.php", "<?php");
  const standalone = await scan(classic.root);
  includes(standalone, "framework", ["wordpress-theme"]);
  assert.ok(!keys(standalone, "framework").includes("wordpress-block-theme"));
});

test("non-Git unknown technology and a new detector run through the same core", async (t) => {
  const f = await fixture(t);
  await f.put("sample.weird", "never send contents");
  await f.put("example.special", "header");
  const result = await scan(f.root);
  assert.equal(result.status, "ready");
  assert.equal(result.evidence.target.marker, "unknown");
  assert.deepEqual(keys(result, "framework"), []);
  assert.ok(result.evidence.coverage.unknown.some(({ key }) => key === "language"));
  const extension = {
    id: "example",
    candidate: (path) => path === "example.special" ? "full" : undefined,
    async detect(context) {
      if (await context.read("example.special") === "header") context.fact({
        kind: "manifest", key: "special", basis: "direct", evidenceIds: [context.ref("example.special")],
      });
    },
  };
  includes(await scan(f.root, { detectors: [...projectDetectors, extension] }), "manifest", ["special"]);
});

test("inventory preserves duplicate skill occurrences across documented layouts and scoped rules", async (t) => {
  const f = await fixture(t);
  const skill = (name) => `---\nname: ${name}\ndescription: Example\n---\nsecret skill body`;
  for (const source of [".agents", ".agent", ".cursor", ".kiro"]) await f.put(source + "/skills/review/SKILL.md", skill("review"));
  await f.put(".agents/skills/custom/SKILL.md", skill("different"));
  await f.put(".agents/skills/broken/SKILL.md", "---\nx: [");
  await f.put("docs/skill-sources.md", "| review | skills/review/ | v1.2.3 |");
  for (const path of ["AGENTS.md", "AGENTS.override.md", ".agents/rules/a.md", "nested/GEMINI.md",
    ".cursor/rules/a.mdc", ".cursorrules", ".kiro/steering/base.md", ".agent/rules/old.md"]) await f.put(path, "secret rules");
  await f.put("nested/package.json", {});
  await f.put("nested/.agents/skills/review/SKILL.md", skill("review"));
  await f.put(".codex/skills/unconfirmed/SKILL.md", skill("unconfirmed"));
  const result = await scan(f.root);
  const entries = result.evidence.inventory;
  assert.equal(entries.filter(({ declaredId }) => declaredId === "review").length, 5);
  const canonical = entries.find(({ relativePath }) => relativePath === ".agents/skills/review/SKILL.md");
  assert.equal(canonical.layout, ".agents/skills");
  assert.equal(canonical.customization, "unknown");
  assert.ok(result.evidence.evidence.some(({ selector }) => selector === "skill_provenance"));
  assert.ok(entries.some(({ customization }) => customization === "review_signal"));
  assert.ok(entries.some(({ boundaryPath, relativePath }) => boundaryPath === "nested" && relativePath === "nested/GEMINI.md"));
  warning(result, "duplicate_skill_id");
  warning(result, "malformed_skill");
  assert.ok(!JSON.stringify(result).includes("secret skill body"));
  assert.ok(!JSON.stringify(result).includes("secret rules"));
  assert.ok(!JSON.stringify(result).includes("unconfirmed"));
});

test("Git root and worktree are marker-only and remain unchanged", async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", f.root, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  await f.put("package.json", { dependencies: { react: "^19" } });
  git("add", "package.json");
  git("commit", "-m", "fixture");
  const worktree = join(other.root, "worktree");
  git("worktree", "add", "--detach", worktree);
  const head = git("rev-parse", "HEAD");
  let opened = 0;
  const io = { ...fs, open: async (path, flags) => {
    assert.notEqual(basename(path), ".git");
    opened++;
    return fs.open(path, flags);
  } };
  assert.equal((await scan(f.root, { io })).evidence.target.marker, "git_directory");
  const result = await scan(worktree, { io });
  assert.equal(result.evidence.target.marker, "git_file");
  includes(result, "framework", ["react"]);
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(opened, 2);
  assert.deepEqual((await fs.readdir(worktree)).sort(), [".git", "package.json"]);
});

test("malformed and inaccessible manifests yield partial evidence and credential files are never opened", async (t) => {
  const f = await fixture(t);
  const payload = "SENTINEL_CREDENTIAL";
  await f.put("package.json", { dependencies: { demo: "https://user:" + payload + "@example.invalid/path" },
    scripts: { test: "touch SCANNER_RAN " + payload }, secret: payload });
  await f.put("bad/composer.json", "{invalid");
  await f.put("bad/go.mod", "require (\n malformed\n");
  await f.put("bad/pnpm-workspace.yaml", "packages: [");
  await f.put("bad/angular.json", "{}");
  const forbidden = [".env", "nested/.env.test", ".npmrc", "auth.json", "id_rsa", "test.pem", "wp-config.php",
    "node_modules/a/package.json", "vendor/site/composer.json", "dist/app/package.json", ".cache/go.mod",
    ".kiro/settings/mcp.json", ".agents/skills/test/assets/package.json"];
  for (const file of forbidden) await f.put(file, payload);
  const opened = [];
  const list = new Map();
  const io = { ...fs,
    opendir: async (path) => { list.set(path, true); return fs.opendir(path); },
    open: async (path, flags) => {
      opened.push(path.slice(f.root.length + 1));
      if (path.endsWith("angular.json")) throw Object.assign(new Error("private detail"), { code: "EACCES" });
      return fs.open(path, flags);
    },
  };
  const before = await fs.readdir(f.root, { recursive: true });
  const result = await scan(f.root, { io });
  assert.equal(result.status, "partial");
  warning(result, "malformed_manifest");
  warning(result, "permission_denied");
  assert.ok(opened.includes("package.json"));
  for (const file of forbidden) assert.ok(!opened.includes(file), file);
  for (const directory of ["node_modules", "vendor", "dist", ".cache", ".kiro/settings"]) assert.ok(!list.has(join(f.root, directory)));
  assert.ok(!JSON.stringify(result).includes(payload));
  assert.ok(!JSON.stringify(result).includes("example.invalid"));
  assert.deepEqual(await fs.readdir(f.root, { recursive: true }), before);
  assert.equal(JSON.parse(await fs.readFile(join(f.root, "package.json"), "utf8")).secret, payload);
});

test("reader rejects symlink, hardlink and FIFO and discards a controlled file replacement", async (t) => {
  const f = await fixture(t);
  const outside = await fixture(t);
  await outside.put("package.json", JSON.stringify({ dependencies: { next: "*" } }));
  await f.put("package.json", { dependencies: { react: "*" } });
  await f.put("raced/package.json", { dependencies: { react: "*" } });
  await fs.mkdir(join(f.root, "linked"));
  await fs.symlink(join(outside.root, "package.json"), join(f.root, "linked/package.json"));
  await fs.mkdir(join(f.root, "hard"));
  await fs.link(join(outside.root, "package.json"), join(f.root, "hard/package.json"));
  await fs.mkdir(join(f.root, "fifo"));
  execFileSync("mkfifo", [join(f.root, "fifo/package.json")]);
  const opened = [];
  const read = [];
  const io = { ...fs, open: async (path, flags) => {
    opened.push(path);
    if (path.endsWith("/raced/package.json")) {
      await fs.rename(path, path + ".old");
      await fs.writeFile(path, JSON.stringify({ dependencies: { next: "*" } }));
    }
    const handle = await fs.open(path, flags);
    const originalRead = handle.read.bind(handle);
    handle.read = (...args) => { read.push(path); return originalRead(...args); };
    return handle;
  } };
  const result = await scan(f.root, { io });
  warning(result, "unsafe_entry");
  warning(result, "entry_changed");
  assert.deepEqual(opened.sort(), [join(f.root, "package.json"), join(f.root, "raced/package.json")].sort());
  assert.deepEqual(read, [join(f.root, "package.json")]);
  includes(result, "framework", ["react"]);
  assert.ok(!JSON.stringify(result).includes("nextjs"));
});

test("root replacement invalidates the scan and initial symlink is rejected as a noncanonical target", async (t) => {
  const f = await fixture(t);
  const outside = await fixture(t);
  await f.put("project/package.json", {});
  await outside.put("package.json", {});
  const root = join(f.root, "project");
  let opened = false;
  const io = { ...fs, opendir: async (path) => {
    await fs.rename(root, root + "-original");
    await fs.symlink(outside.root, root);
    return fs.opendir(path);
  }, open: async () => { opened = true; assert.fail("file open during root change"); } };
  const result = await scan(root, { io });
  assert.deepEqual(result, { status: "error", code: "target_changed", requestId: "scan" });
  assert.equal(opened, false);
  assert.equal((await scan(root)).code, "target_changed");
  assert.equal((await scan("relative")).code, "invalid_path");
});

test("filesystem and response budgets produce structured partial results", async (t) => {
  const f = await fixture(t);
  await f.put("package.json", { dependencies: { react: "*" } });
  await f.put("member/composer.json", { require: { "laravel/framework": "^12" } });
  await f.put("moredir/deep/deeper/test.go");
  for (const [overrides, code] of [
    [{ depth: 1 }, "max_depth"], [{ directories: 1 }, "directory_budget"], [{ entries: 2 }, "entry_budget"],
    [{ boundaries: 1 }, "boundary_budget"], [{ files: 1 }, "file_budget"], [{ fileBytes: 10 }, "file_size"],
    [{ totalBytes: 10 }, "byte_budget"], [{ responseBytes: 480 }, "response_budget"],
  ]) {
    const result = await scan(f.root, { limits: { ...scanLimits, ...overrides } });
    assert.equal(result.status, "partial", code);
    assert.ok(result.evidence.coverage.limits.includes(code), JSON.stringify(result.evidence.coverage));
  }
  const deadline = await scan(f.root, { now: (() => { let time = 0; return () => time += 3000; })() });
  assert.equal(deadline.status, "partial");
  warning(deadline, "deadline");
});

test("cancellation suppresses terminal results, releases slots and isolates an A to B to A request sequence", async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  await a.put("package.json", { dependencies: { react: "*" } });
  await b.put("composer.json", { require: { "laravel/framework": "^12" } });
  let unblock;
  let reportFirstOpen;
  const firstOpen = new Promise((resolve) => { reportFirstOpen = resolve; });
  let count = 0;
  const io = { ...fs, open: async (path, flags) => {
    if (++count === 1) {
      reportFirstOpen();
      await new Promise((resolve) => { unblock = resolve; });
    }
    return fs.open(path, flags);
  } };
  const scanner = new ProjectScanner({ io });
  const first = new AbortController();
  const pending = scanner.scan(input(a.root, "a1"), first.signal);
  await firstOpen;
  first.abort();
  const mid = await scanner.scan(input(b.root, "b"), new AbortController().signal);
  assert.equal(mid.requestId, "b");
  includes(mid, "framework", ["laravel"]);
  const latest = await scanner.scan(input(a.root, "a2"), new AbortController().signal);
  assert.equal(latest.requestId, "a2");
  includes(latest, "framework", ["react"]);
  unblock();
  assert.equal(await pending, undefined);
  await scanner.dispose();
  assert.equal(await scanner.scan(input(a.root), new AbortController().signal), undefined);
});

test("subscription contract sends one validated terminal event and cleanup aborts pending work", async (t) => {
  const f = await fixture(t);
  await f.put("package.json", {});
  assert.equal(targetScanSubscription.input.safeParse({ ...input(f.root), catalogRef: "other" }).success, false);
  assert.equal(targetScanSubscription.event.safeParse({ status: "error", requestId: "scan", code: "busy", raw: "private" }).success, false);
  const handlers = new Map();
  const cleanup = contribute({ handle: (contract, handle) => handlers.set(contract, handle), registerSettings: () => ({}) });
  const handle = handlers.get(targetScanSubscription);
  const events = [];
  await handle(input(f.root), { signal: new AbortController().signal, push: (event) => events.push(event) });
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "ready");
  const pending = handle(input(f.root, "disposed"), { signal: new AbortController().signal, push: (event) => events.push(event) });
  await cleanup();
  await pending;
  assert.equal(events.length, 1);
});

test("controlled ancestor replacement closes the directory before reading external entries", async (t) => {
  const f = await fixture(t);
  const outside = await fixture(t);
  await f.put("nested/package.json", {});
  await outside.put("package.json", { dependencies: { next: "*" } });
  const nested = join(f.root, "nested");
  let externalDirectoryReads = 0;
  const io = { ...fs, opendir: async (path) => {
    if (path !== nested) return fs.opendir(path);
    await fs.rename(nested, join(f.root, "renamed"));
    await fs.symlink(outside.root, nested);
    const directory = await fs.opendir(path);
    return { read: () => { externalDirectoryReads++; return directory.read(); }, close: () => directory.close() };
  } };
  const result = await scan(f.root, { io });
  assert.equal(result.status, "partial");
  assert.equal(externalDirectoryReads, 0);
  assert.ok(!JSON.stringify(result).includes("nextjs"));
  warning(result, "unsafe_entry");
});

test("deterministic evidence ignores file creation order and unknown project metadata fields", async (t) => {
  const f = await fixture(t);
  const second = await fixture(t);
  const files = [
    ["apps/app/package.json", { dependencies: { react: "*", next: "^15" } }],
    ["apps/app/app/page.tsx", ""],
    ["package.json", { workspaces: ["apps/**"] }],
    ["AGENTS.md", "policy"],
    ["tool.py", ""],
  ];
  for (const [path, value] of files) await f.put(path, value);
  for (const [path, value] of files.reverse()) await second.put(path, value);
  const first = await scan(f.root);
  const other = await scan(second.root);
  other.evidence.target.canonicalDirectory = f.root;
  assert.deepEqual(first, other);
});

test("real permission denial retains evidence from readable siblings", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
  const f = await fixture(t);
  await f.put("package.json", { dependencies: { react: "*" } });
  await f.put("nested/package.json", { dependencies: { next: "*" } });
  const file = join(f.root, "nested/package.json");
  await fs.chmod(file, 0o000);
  let result;
  try {
    result = await scan(f.root);
  } finally {
    await fs.chmod(file, 0o600);
  }
  assert.equal(result.status, "partial");
  warning(result, "permission_denied");
  includes(result, "framework", ["react"]);
  assert.ok(!JSON.stringify(result).includes("nextjs"));
});

test("Next Pages Router needs a matching package declaration in its own application", async (t) => {
  const f = await fixture(t);
  await f.put("app/package.json", { dependencies: { next: "^15", react: "^19" } });
  await f.put("app/pages/index.tsx");
  await f.put("other/package.json", {});
  await f.put("other/app/page.tsx");
  await f.put("other/next.config.js", "throw new Error('do not import')");
  const result = await scan(f.root);
  assert.deepEqual(keys(result, "router", "app"), ["nextjs-pages"]);
  assert.deepEqual(keys(result, "framework", "other"), []);
  assert.deepEqual(keys(result, "router", "other"), []);
  assert.ok(result.evidence.boundaries.some(({ rootRelativePath, roles }) =>
    rootRelativePath === "app" && roles.includes("application")));
});

test("a scan slot is local to its installation and recovers when a request is cancelled", async (t) => {
  const f = await fixture(t);
  await f.put("package.json", {});
  let release;
  let waiting;
  const started = new Promise((resolve) => { waiting = resolve; });
  const io = { ...fs, open: async (path, flags) => {
    if (!release) {
      await new Promise((resolve) => { release = resolve; waiting(); });
    }
    return fs.open(path, flags);
  } };
  const installation = new ProjectScanner({ limits: { ...scanLimits, concurrent: 1 }, io });
  const otherInstallation = new ProjectScanner();
  const stop = new AbortController();
  const first = installation.scan(input(f.root, "same-id"), stop.signal);
  await started;
  try {
    const rejected = await installation.scan(input(f.root, "busy"), new AbortController().signal);
    assert.equal(rejected.code, "busy");
    assert.equal((await otherInstallation.scan(input(f.root, "same-id"), new AbortController().signal)).status, "ready");
    stop.abort();
  } finally {
    release();
  }
  assert.equal(await first, undefined);
  assert.equal((await installation.scan(input(f.root, "recovered"), new AbortController().signal)).status, "ready");
  await Promise.all([installation.dispose(), otherInstallation.dispose()]);
});
