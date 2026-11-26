import { beneath } from "../project-reader";
import { hasFile, objectFile, pathFor, record, safeLabel, versionSpec, workspaceList } from "./metadata";
import type { DetectionContext, ProjectDetector } from "./types";

const sections = {
  dependencies: "production", devDependencies: "dev", peerDependencies: "peer", optionalDependencies: "optional",
} as const;
const managers = new Map([
  ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"], ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"], ["pnpm-workspace.yaml", "pnpm"], ["bun.lock", "bun"], ["bun.lockb", "bun"],
]);
const testTools = new Set(["vitest", "jest", "@playwright/test", "cypress", "mocha", "@angular/build", "karma"]);
const buildTools = new Set(["vite", "webpack", "esbuild", "typescript", "turbo", "nx", "rollup", "@angular/build", "@angular-devkit/build-angular"]);

function dependencies(context: DetectionContext, manifest: Record<string, unknown>, owner: string, shared = false) {
  const byName = new Map<string, string[]>();
  const pkgPath = beneath(owner, "package.json");
  for (const [section, scope] of Object.entries(sections)) {
    const values = record(manifest[section]);
    if (!values && manifest[section] !== undefined) context.warn("malformed_manifest", pkgPath);
    for (const [name, value] of Object.entries(values ?? {})) {
      if (!safeLabel(name) || typeof value !== "string") {
        context.warn("malformed_manifest", pkgPath);
        continue;
      }
      if (shared && !name.startsWith("@angular/")) continue;
      const origin = context.ref(pkgPath, "declaration", section + "/" + name);
      byName.set(name, [...byName.get(name) ?? [], origin]);
      context.fact({ kind: "dependency", key: name, ecosystem: "npm", scope, declaredAt: owner,
        ...versionSpec(value), basis: "direct", evidenceIds: [origin] });
      if (testTools.has(name)) context.fact({ kind: "test", key: name, basis: "direct", evidenceIds: [origin] });
      if (buildTools.has(name)) context.fact({ kind: "build", key: name, basis: "direct", evidenceIds: [origin] });
      if (/^(?:pg|mysql2?|redis|ioredis|mongodb|mongoose|sqlite3|better-sqlite3|prisma|@prisma\/client|typeorm|sequelize|knex|drizzle-orm)$/.test(name)) {
        context.fact({ kind: "database", key: name, basis: "direct", evidenceIds: [origin] });
      }
      if (/^(?:bull|bullmq|amqplib|bee-queue)$/.test(name)) {
        context.fact({ kind: "queue", key: name, basis: "direct", evidenceIds: [origin] });
      }
    }
  }
  return byName;
}

export const javascriptDetector: ProjectDetector = {
  id: "javascript",
  candidate(path) {
    return /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|angular\.json|lerna\.json)$/.test(path) ? "full" : undefined;
  },
  async discover(context) {
    const pkg = await objectFile(context, "package.json");
    if (pkg) {
      context.boundary("package", context.ref(pathFor(context, "package.json")));
      workspaceList(context, "package.json", "workspaces", record(pkg.workspaces)?.packages ?? pkg.workspaces);
    }
    const pnpm = await objectFile(context, "pnpm-workspace.yaml", true);
    if (pnpm) workspaceList(context, "pnpm-workspace.yaml", "packages", pnpm.packages);
    const lerna = await objectFile(context, "lerna.json");
    if (lerna) workspaceList(context, "lerna.json", "packages", lerna.packages);
    const angular = await objectFile(context, "angular.json");
    if (angular) {
      const projects = record(angular.projects);
      if (projects) workspaceList(context, "angular.json", "projects", Object.values(projects).map((value) => record(value)?.root === "" ? "." : record(value)?.root));
      else if (angular.projects !== undefined) context.warn("malformed_manifest", pathFor(context, "angular.json"));
    }
  },
  async detect(context) {
    const pkg = await objectFile(context, "package.json");
    const declared = typeof pkg?.packageManager === "string" &&
      /^(npm|pnpm|yarn|bun)@([0-9]+(?:\.[0-9]+){0,2})(?:[-+][a-zA-Z0-9.-]+)?$/.exec(pkg.packageManager);
    const inferred = new Set<string>();
    for (const [file, manager] of managers) {
      if (hasFile(context, file)) {
        inferred.add(manager);
        context.fact({ kind: "package_manager", key: manager, basis: "inferred", ruleId: "manager_marker",
          evidenceIds: [context.ref(pathFor(context, file))] });
      }
    }
    if (declared) context.fact({ kind: "package_manager", key: declared[1], basis: "direct", version: declared[2],
      evidenceIds: [context.ref(pathFor(context, "package.json"), "declaration", "packageManager")] });
    if (inferred.size > 1 || (declared && [...inferred].some((value) => value !== declared[1]))) {
      context.warn("manager_conflict", context.root);
    }
    const deps = dependencies(context, pkg ?? {}, context.root);
    for (const [framework, packages] of [["react", ["react", "react-dom"]], ["nextjs", ["next"]], ["angular", ["@angular/core"]]] as const) {
      const origins = packages.flatMap((name) => deps.get(name) ?? []);
      if (origins.length) context.fact({ kind: "framework", key: framework, basis: "inferred",
        ruleId: "direct_framework_dependency", evidenceIds: origins });
    }
    for (const [router, matcher] of [
      ["app", /^(?:src\/)?app\/(?:[^/]+\/)*(?:page|layout|route)\.(?:[jt]sx?|mdx)$/],
      ["pages", /^(?:src\/)?pages\/(?:[^/]+\/)*[^/]+\.(?:[jt]sx?|mdx)$/],
    ] as const) {
      const route = context.owned.find((entry) => entry.kind === "file" &&
        matcher.test(context.root === "." ? entry.path : entry.path.slice(context.root.length + 1)));
      if (route && deps.has("next")) {
        const routeRef = context.ref(route.path);
        context.boundary("application", routeRef);
        context.fact({ kind: "router", key: "nextjs-" + router, basis: "inferred",
          ruleId: "next_dependency_and_route_file", evidenceIds: [...deps.get("next")!, routeRef] });
      }
    }
    for (const owner of new Set([context.root, ...context.shared])) {
      const path = beneath(owner, "angular.json");
      const content = await context.read(path);
      if (content === undefined) continue;
      let projects: Record<string, unknown> | undefined;
      try {
        projects = record(record(JSON.parse(content))?.projects);
      } catch {
        continue; // Discovery reports malformed local manifests.
      }
      for (const project of Object.values(projects ?? {})) {
        const entry = record(project);
        if (!entry || typeof entry.root !== "string") continue;
        const relative = entry.root.replace(/^\.\//, "").replace(/\/$/, "");
        const projectRoot = !relative || relative === "." ? owner : beneath(owner, relative);
        if (projectRoot !== context.root) continue;
        const origin = context.ref(path, "declaration", "projects");
        if (entry.projectType === "application") context.boundary("application", origin);
        const pkgContent = owner !== context.root ? await context.read(beneath(owner, "package.json")) : undefined;
        let ownerPkg: Record<string, unknown> | undefined;
        if (pkgContent !== undefined) {
          try { ownerPkg = record(JSON.parse(pkgContent)); } catch { /* Already reported in discovery. */ }
        }
        const inherited = ownerPkg ? dependencies(context, ownerPkg, owner, true) : undefined;
        const core = deps.get("@angular/core") ?? inherited?.get("@angular/core");
        if (core) context.fact({ kind: "framework", key: "angular", basis: "inferred",
          ruleId: "angular_project_and_dependency", evidenceIds: [origin, ...core] });
        const targets = record(entry.targets) ?? record(entry.architect);
        for (const target of ["build", "test"] as const) {
          const builder = record(targets?.[target])?.builder;
          const key = typeof builder === "string" ? builder.replace(":", "/") : undefined;
          if (safeLabel(key)) context.fact({ kind: target, key, basis: "direct", evidenceIds: [origin] });
        }
      }
    }
    const scripts = record(pkg?.scripts);
    for (const task of ["build", "test", "lint"] as const) {
      if (typeof scripts?.[task] === "string") context.fact({
        kind: task === "test" ? "test" : "build", key: task + "-script", basis: "direct",
        evidenceIds: [context.ref(pathFor(context, "package.json"), "declaration", "scripts." + task)],
      });
    }
  },
};
