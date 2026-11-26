import { z } from "zod";

export const relativePath = z.string().max(1024).refine((path) => path === "." ||
  path.split("/").every((part) => part && part !== "." && part !== ".." && !/[:\\\u0000-\u001f\u007f]/u.test(part)));
const label = z.string().min(1).max(160).regex(/^[a-zA-Z0-9@._/+*-]+$/);
export const evidenceRef = z.strictObject({
  id: z.string(),
  relativePath,
  kind: z.enum(["presence", "declaration", "header"]),
  selector: z.string().min(1).max(192).regex(/^[a-zA-Z0-9@._/+*-]+$/).optional(),
});
const factFields = {
  boundaryPath: relativePath,
  kind: z.enum(["language", "framework", "manifest", "package_manager", "dependency", "build", "test", "database", "queue", "router"]),
  key: label,
  evidenceIds: z.array(z.string()).min(1),
  ecosystem: label.optional(),
  scope: z.enum(["production", "dev", "peer", "optional", "indirect"]).optional(),
  version: z.string().max(80).regex(/^[0-9vVxX.*~^<>=|,+ -]+$/).optional(),
  specKind: z.enum(["constraint", "workspace", "external", "other"]).optional(),
  declaredAt: relativePath.optional(),
};
export const projectFact = z.discriminatedUnion("basis", [
  z.strictObject({ ...factFields, basis: z.literal("direct") }),
  z.strictObject({ ...factFields, basis: z.literal("inferred"), ruleId: label }),
]);
export const projectInventory = z.strictObject({
  relativePath,
  boundaryPath: relativePath,
  kind: z.enum(["skill", "rule"]),
  layout: label,
  directoryId: label.optional(),
  declaredId: label.optional(),
  metadataState: z.enum(["valid", "mismatch", "malformed", "unreadable"]).optional(),
  customization: z.enum(["unknown", "review_signal"]).optional(),
  evidenceIds: z.array(z.string()).min(1),
});
export const projectWarning = z.strictObject({
  code: z.enum([
    "malformed_manifest", "malformed_skill", "duplicate_skill_id", "permission_denied", "unreadable",
    "unsafe_entry", "entry_changed", "unsupported_workspace_pattern", "missing_member", "manager_conflict",
    "max_depth", "directory_budget", "entry_budget", "boundary_budget", "file_budget", "file_size",
    "byte_budget", "response_budget", "deadline",
  ]),
  relativePath: relativePath.optional(),
});
export const projectEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  target: z.strictObject({
    canonicalDirectory: z.string().max(4096),
    marker: z.enum(["git_directory", "git_file", "unknown"]),
  }),
  boundaries: z.array(z.strictObject({
    rootRelativePath: relativePath,
    roles: z.array(z.enum(["root", "application", "package", "workspace"])).min(1),
    memberships: z.array(z.strictObject({ workspaceRoot: relativePath, evidenceId: z.string() })),
    evidenceIds: z.array(z.string()),
  })),
  facts: z.array(projectFact),
  evidence: z.array(evidenceRef),
  inventory: z.array(projectInventory),
  warnings: z.array(projectWarning),
  coverage: z.strictObject({
    status: z.enum(["complete", "partial"]),
    limits: z.array(projectWarning.shape.code),
    unknown: z.array(z.strictObject({ boundaryPath: relativePath, key: label, reason: z.enum(["insufficient_evidence", "outside_policy"]) })),
  }),
});
export const projectScanEvent = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), requestId: z.string(), evidence: projectEvidenceSchema }),
  z.strictObject({ status: z.literal("partial"), requestId: z.string(), evidence: projectEvidenceSchema }),
  z.strictObject({
    status: z.literal("error"), requestId: z.string(),
    code: z.enum(["invalid_path", "missing", "not_directory", "permission_denied", "unreadable", "target_changed", "busy", "scan_failed"]),
  }),
]);

export type ProjectEvidence = z.infer<typeof projectEvidenceSchema>;
export type ProjectFact = z.infer<typeof projectFact>;
export type EvidenceRef = z.infer<typeof evidenceRef>;
export type ProjectWarning = z.infer<typeof projectWarning>;
export type ScanEvent = z.infer<typeof projectScanEvent>;
