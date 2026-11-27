import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { applicabilitySchema, type ApplicabilityRule } from "../shared/applicability";
import type { MetadataDiagnostic } from "../shared/recommendation";
import type { CatalogSnapshot } from "./catalog-loader";

type Skill = CatalogSnapshot["skills"][number];
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function hasBlobIntegrity(file: Skill["entrypoint"]) {
  return Buffer.isBuffer(file.bytes) && file.sizeBytes === file.bytes.length &&
    createHash("sha1").update("blob " + file.sizeBytes + "\0").update(file.bytes).digest("hex") === file.blobSha;
}

// JSON.parse checks grammar first. Walk only structural tokens and property names
// to detect duplicates without recursive descent or accepting YAML syntax.
function hasDuplicateKeys(text: string) {
  const objects: Set<string>[] = [];
  for (const [token, property] of text.matchAll(/("(?:[^"\\]|\\[\s\S])*")[ \t\r\n]*:|"(?:[^"\\]|\\[\s\S])*"|[{}]/g)) {
    if (token === "{") objects.push(new Set());
    else if (token === "}") objects.pop();
    else if (property !== undefined) {
      const key = JSON.parse(property) as string;
      const keys = objects.at(-1)!;
      if (keys.has(key)) return true;
      keys.add(key);
    }
  }
  return false;
}

export function readApplicability(bytes: Buffer): { rule: ApplicabilityRule } | { code: MetadataDiagnostic } {
  const invalid = { code: "invalid_applicability" } as const;
  if (bytes.length > 8192) return invalid;
  try {
    const text = decoder.decode(bytes);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) || hasDuplicateKeys(text)) return invalid;
    if ("schemaVersion" in value && Number.isInteger(value.schemaVersion) && value.schemaVersion !== 1) {
      return { code: "unsupported_rule_version" };
    }
    const parsed = applicabilitySchema.safeParse(value);
    return parsed.success ? { rule: parsed.data } : invalid;
  } catch {
    return invalid;
  }
}
