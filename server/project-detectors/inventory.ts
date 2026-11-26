import { basename } from "node:path/posix";
import { skillSlugSchema } from "../../shared/catalog";
import { pathFor, yamlRecord } from "./metadata";
import type { ProjectDetector } from "./types";

const skillPath = /(?:^|\/)(\.agents|\.agent|_agents|_agent|\.cursor|\.kiro)\/skills\/([^/]+)\/SKILL\.md$/;
function layout(path: string) {
  if (/^(?:\.agents|\.agent|_agents|_agent)\/rules\/[^/]+\.md$/.test(path)) return path.split("/")[0] + "/rules";
  if (/^\.cursor\/rules\/(?:[^/]+\/)*[^/]+\.mdc$/.test(path)) return ".cursor/rules";
  if (/^\.kiro\/steering\/(?:[^/]+\/)*[^/]+\.md$/.test(path)) return ".kiro/steering";
  if (/^(?:\.cursorrules|AGENTS\.md|AGENTS\.override\.md|GEMINI\.md)$/.test(path)) return path;
  if (/^(?:\.agents|\.agent|_agents|_agent)\/(?:AGENTS|GEMINI)\.md$/.test(path)) return path;
}

export const inventoryDetector: ProjectDetector = {
  id: "inventory",
  candidate: (path) => skillPath.test(path) ? "prefix" : /(?:^|\/)docs\/skill-sources\.md$/.test(path) ? "full" : undefined,
  async detect(context) {
    const seen = new Set<string>();
    const sourcesPath = pathFor(context, "docs/skill-sources.md");
    const sources = context.owned.some((file) => file.path === sourcesPath && file.kind === "file")
      ? await context.read(sourcesPath) : undefined;
    for (const entry of context.owned) {
      if (entry.kind !== "file") continue;
      const matching = skillPath.exec(entry.path);
      if (!matching) {
        // Rules can be scoped to a subdirectory even without an application manifest.
        const local = context.root === "." ? entry.path : entry.path.slice(context.root.length + 1);
        const providerPath = /(?:^|\/)((?:\.agents|\.agent|_agents|_agent|\.cursor|\.kiro)\/.*)$/.exec(local)?.[1];
        const ruleLayout = layout(providerPath ?? basename(local));
        if (ruleLayout) context.inventory({
          kind: "rule", layout: ruleLayout, relativePath: entry.path, evidenceIds: [context.ref(entry.path)],
        });
        continue;
      }
      const [, source, folder] = matching;
      const directoryId = skillSlugSchema.safeParse(folder).data;
      const raw = await context.read(entry.path);
      let declaredId: string | undefined;
      let valid = false;
      try {
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw ?? "");
        const metadata = frontmatter ? yamlRecord(frontmatter[1]) : undefined;
        declaredId = skillSlugSchema.safeParse(metadata?.name).data;
        valid = Boolean(declaredId && typeof metadata?.description === "string" && metadata.description.trim() && metadata.description.length <= 1024);
      } catch { /* Invalid YAML remains a metadata warning. */ }
      const metadataState = raw === undefined ? "unreadable" : !valid || !directoryId ? "malformed" :
        declaredId === directoryId ? "valid" : "mismatch";
      if (metadataState === "malformed" || metadataState === "mismatch") context.warn("malformed_skill", entry.path);
      const identity = declaredId ?? directoryId;
      if (identity && seen.has(identity)) context.warn("duplicate_skill_id", entry.path);
      if (identity) seen.add(identity);
      const evidenceIds = [context.ref(entry.path)];
      if (declaredId) evidenceIds.push(context.ref(entry.path, "declaration", "name"));
      const provenance = source === ".agents" && directoryId && entry.path === pathFor(context, ".agents/skills/" + directoryId + "/SKILL.md") &&
        sources?.split(/\r?\n/).some((line) => {
          const cells = line.split("|").map((cell) => cell.trim().replace(/^`|`$/g, ""));
          return cells[0] === "" && cells[1] === directoryId && cells[2] === "skills/" + directoryId + "/" && Boolean(cells[3]);
        });
      if (provenance) evidenceIds.push(context.ref(sourcesPath, "declaration", "skill_provenance"));
      context.inventory({
        kind: "skill", layout: source + "/skills", relativePath: entry.path,
        ...(directoryId ? { directoryId } : {}), ...(declaredId ? { declaredId } : {}),
        metadataState, customization: metadataState === "mismatch" ? "review_signal" : "unknown", evidenceIds,
      });
    }
  },
};
