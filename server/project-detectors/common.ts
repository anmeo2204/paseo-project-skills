import type { ProjectDetector, Role } from "./types";

const languages = new Map(Object.entries({
  go: "go", php: "php", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", css: "css",
  py: "python", rb: "ruby", rs: "rust", java: "java", kt: "kotlin", cs: "csharp",
}));
const manifests = new Set([
  "package.json", "composer.json", "go.mod", "go.work", "pnpm-workspace.yaml", "angular.json", "lerna.json",
  "pyproject.toml", "requirements.txt", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts",
]);
const generic = (name: string) => /^(?:pyproject\.toml|Cargo\.toml|Gemfile|pom\.xml|build\.gradle(?:\.kts)?|.+\.(?:csproj|fsproj|sln))$/.test(name);
const config = /^(?:next|vite|vitest|jest|playwright|webpack|cypress|karma|rollup)\.config\.(?:[cm]?[jt]s|json)$/;

export const commonDetector: ProjectDetector = {
  id: "common",
  async discover(context) {
    for (const file of context.files) {
      if (file.kind !== "file") continue;
      let role: Role | undefined;
      if (generic(file.name)) role = "package";
      if (role) context.boundary(role, context.ref(file.path));
    }
  },
  detect(context) {
    const observedLanguages = new Set<string>();
    for (const entry of context.owned) {
      const { name, path } = entry;
      if (entry.kind === "directory") {
        if (name === "migrations") context.fact({ kind: "database", key: "migration-directory",
          basis: "inferred", ruleId: "migration_directory_marker", evidenceIds: [context.ref(path)] });
        continue;
      }
      if (!/(?:^|\/)(?:\.agents|\.cursor|\.kiro|\.agent|_agents|_agent)\//.test(path)) {
        const language = languages.get(name.split(".").at(-1) ?? "");
        if (name.includes(".") && language && !observedLanguages.has(language)) {
          observedLanguages.add(language);
          context.fact({ kind: "language", key: language, basis: "inferred", ruleId: "source_extension", evidenceIds: [context.ref(path)] });
        }
      }
      if (manifests.has(name) || generic(name)) context.fact({
        kind: "manifest", key: /\.(?:csproj|fsproj|sln)$/.test(name) ? name.split(".").at(-1)! : name, basis: "direct", evidenceIds: [context.ref(path)],
      });
      if (/^(?:README|CONTRIBUTING)\.md$/.test(name)) context.ref(path);
      if (/^(?:Makefile|Taskfile\.ya?ml|tsconfig\.json|nx\.json|turbo\.json|artisan)$/.test(name) ||
          /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || config.test(name)) {
        const key = /(?:^|\/)\.github\/workflows\//.test(path) ? "github-actions" : name;
        context.fact({ kind: /^(?:vitest|jest|playwright|cypress|karma)\./.test(name) ? "test" : "build",
          key, basis: "direct", evidenceIds: [context.ref(path)] });
      }
      if (/^phpunit\.xml(?:\.dist)?$/.test(name)) context.fact({
        kind: "test", key: "phpunit-config", basis: "direct", evidenceIds: [context.ref(path)],
      });
      if (/(?:^|\/)config\/(?:queue|database)\.php$/.test(path)) context.fact({
        kind: name === "queue.php" ? "queue" : "database", key: name, basis: "direct", evidenceIds: [context.ref(path)],
      });
      if (/(?:^|\/)routes\/(?:api|web)\.php$/.test(path)) context.fact({
        kind: "router", key: "php-route-file", basis: "inferred", ruleId: "php_route_convention", evidenceIds: [context.ref(path)],
      });
    }
    context.unknown("database_runtime", "outside_policy");
    context.unknown("queue_runtime", "outside_policy");
  },
};
