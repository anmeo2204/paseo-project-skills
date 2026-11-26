import { hasFile, pathFor, safeLabel } from "./metadata";
import type { DiscoveryContext, ProjectDetector } from "./types";

interface GoMetadata {
  module?: string;
  version?: string;
  requires: { name: string; indirect: boolean }[];
  members: string[];
}

async function readGo(context: DiscoveryContext, name: "go.mod" | "go.work") {
  if (!hasFile(context, name)) return;
  const path = pathFor(context, name);
  const text = await context.read(path);
  if (text === undefined) return;
  const data: GoMetadata = { requires: [], members: [] };
  let block: string | undefined;
  let malformed = false;
  for (const raw of text.split(/\r?\n/)) {
    const comment = raw.indexOf("//");
    const line = (comment >= 0 ? raw.slice(0, comment) : raw).trim();
    if (!line) continue;
    if (line === ")" && block) { block = undefined; continue; }
    const opening = /^(\w+)\s+\($/.exec(line);
    if (opening && !block) { block = opening[1]; continue; }
    const match = /^(\w+)\s+(.+)$/.exec(line);
    const directive = block ?? match?.[1];
    const value = block ? line : match?.[2];
    if (!directive || !value) { malformed = true; continue; }
    if (directive === "module") {
      if (safeLabel(value)) data.module = value;
      else malformed = true;
    } else if (directive === "go") {
      if (/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(value)) data.version = value;
      else malformed = true;
    } else if (directive === "require") {
      const [module, version, extra] = value.split(/\s+/);
      if (!safeLabel(module) || !version || !/^v[0-9][a-zA-Z0-9.+-]*$/.test(version) || extra) malformed = true;
      else data.requires.push({ name: module, indirect: /\/\/\s*indirect\s*$/.test(raw) });
    } else if (directive === "use") {
      const quoted = /^"([^"\\]+)"$/.exec(value);
      if (quoted) data.members.push(quoted[1]);
      else if (!/["\s]/.test(value)) data.members.push(value);
      else malformed = true;
    }
  }
  if (block || malformed || (name === "go.mod" && !data.module)) context.warn("malformed_manifest", path);
  return data;
}

export const goDetector: ProjectDetector = {
  id: "go",
  candidate: (path) => /(?:^|\/)go\.(?:mod|work)$/.test(path) ? "full" : undefined,
  async discover(context) {
    const module = await readGo(context, "go.mod");
    if (module?.module) context.boundary("package", context.ref(pathFor(context, "go.mod"), "declaration", "module"));
    const work = await readGo(context, "go.work");
    if (work?.members.length) context.workspace({
      patterns: work.members.map((member) => member.replace(/^\.\//, "")),
      evidenceId: context.ref(pathFor(context, "go.work"), "declaration", "use"),
    });
  },
  async detect(context) {
    const module = await readGo(context, "go.mod");
    if (!module?.module) return;
    const path = pathFor(context, "go.mod");
    const origin = context.ref(path, "declaration", "module");
    context.fact({ kind: "language", key: "go", basis: "direct", evidenceIds: [origin], ...(module.version ? { version: module.version } : {}) });
    context.fact({ kind: "package_manager", key: "go-modules", basis: "direct", evidenceIds: [origin] });
    for (const { name, indirect } of module.requires) {
      const requirement = context.ref(path, "declaration", "require/" + name);
      context.fact({ kind: "dependency", key: name, ecosystem: "go", scope: indirect ? "indirect" : "production",
        basis: "direct", evidenceIds: [requirement] });
      for (const [kind, pattern] of [
        ["database", /(?:^|\/)(?:pgx|pq|go-sql-driver|mysql|sqlite|go-sqlite3|gorm|sqlx|sqlc|goose|migrate|mongo-driver|go-redis)(?:\/|$)/],
        ["queue", /(?:^|\/)(?:asynq|amqp091-go|rabbitmq|watermill|river|kafka-go)(?:\/|$)/],
        ["router", /(?:^|\/)(?:gin|echo|chi|fiber|gorilla\/mux)(?:\/|$)/],
      ] as const) {
        if (pattern.test(name)) context.fact({ kind, key: name, basis: "direct", evidenceIds: [requirement] });
      }
    }
    const test = context.owned.find((entry) => entry.kind === "file" && entry.name.endsWith("_test.go"));
    if (test) context.fact({ kind: "test", key: "go-test", basis: "inferred", ruleId: "go_test_filename", evidenceIds: [context.ref(test.path)] });
  },
};
