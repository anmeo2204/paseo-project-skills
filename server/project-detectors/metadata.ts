import { isMap, parseDocument, visit } from "yaml";
import { z } from "zod";
import { beneath } from "../project-reader";
import type { DiscoveryContext } from "./types";

const recordSchema = z.record(z.string(), z.unknown());
export const record = (value: unknown) => recordSchema.safeParse(value).data;
export const safeLabel = (value: unknown): value is string => typeof value === "string" &&
  value.length <= 160 && /^[a-zA-Z0-9@._/+*-]+$/.test(value) && !value.includes("//");
export const pathFor = (context: DiscoveryContext, name: string) => beneath(context.root, name);
export const hasFile = (context: DiscoveryContext, name: string) =>
  context.files.some((entry) => entry.name === name && entry.kind === "file");

export function yamlRecord(content: string) {
  const doc = parseDocument(content, { strict: true, uniqueKeys: true, merge: false });
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) return;
  let unsupported = false;
  visit(doc, {
    Alias() { unsupported = true; return visit.BREAK; },
    Node(_key, node) {
      if ("tag" in node && node.tag) {
        unsupported = true;
        return visit.BREAK;
      }
    },
  });
  if (!unsupported) return record(doc.toJS({ maxAliasCount: 0 }));
}

export async function objectFile(context: DiscoveryContext, name: string, yaml = false) {
  if (!hasFile(context, name)) return;
  const path = pathFor(context, name);
  const content = await context.read(path);
  if (content === undefined) return;
  try {
    const parsed = yaml ? yamlRecord(content) : record(JSON.parse(content));
    if (parsed) return parsed;
  } catch {
    // Warnings omit parser text and input.
  }
  context.warn("malformed_manifest", path);
}

export function workspaceList(context: DiscoveryContext, name: string, selector: string, items: unknown) {
  if (items === undefined) return;
  if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
    context.warn("malformed_manifest", pathFor(context, name));
    return;
  }
  if (items.length) context.workspace({
    patterns: items,
    evidenceId: context.ref(pathFor(context, name), "declaration", selector),
  });
}

export function versionSpec(value: string) {
  if (value.startsWith("workspace:")) return { specKind: "workspace" as const };
  if (value.length <= 80 && /^[0-9vVxX.*~^<>=|,+ -]+$/.test(value)) {
    return { specKind: "constraint" as const, version: value };
  }
  return { specKind: /^\w+:|^[./]|@/.test(value) ? "external" as const : "other" as const };
}
