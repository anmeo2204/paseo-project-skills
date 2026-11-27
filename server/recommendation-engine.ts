import type { Condition } from "../shared/applicability";
import { catalogSnapshotSchema, type CatalogDescriptor } from "../shared/catalog";
import { projectEvidenceSchema, type EvidenceRef, type ProjectEvidence, type ProjectFact } from "../shared/project-evidence";
import {
  recommendationEvent, type MetadataDiagnostic, type RecommendationErrorCode, type RecommendationEvent,
  type RecommendationInput, type RecommendationItem, type RecommendationReason,
} from "../shared/recommendation";
import { hasBlobIntegrity, readApplicability } from "./applicability-reader";
import { catalogLimits } from "./catalog-limits";
import type { CatalogSnapshot } from "./catalog-loader";
import { compare, scanLimits } from "./project-reader";

const ordered = <T>(values: Iterable<T>, key: (value: T) => string) =>
  [...values].sort((a, b) => compare(key(a), key(b)));
const within = (path: string, root: string) => root === "." || path === root || path.startsWith(root + "/");
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function indexEvidence(evidence: ProjectEvidence) {
  const refs = new Map(evidence.evidence.map((ref) => [ref.id, ref]));
  const boundaries = new Map(evidence.boundaries.map((boundary) => [boundary.rootRelativePath, boundary]));
  if (refs.size !== evidence.evidence.length || boundaries.size !== evidence.boundaries.length ||
      !boundaries.get(".")?.roles.includes("root")) return;
  const roots = [...boundaries.keys()].sort((a, b) => b.length - a.length);
  const owners = new Map(evidence.evidence.map((ref) => [ref.id, roots.find((root) => within(ref.relativePath, root))]));
  for (const boundary of boundaries.values()) {
    const path = boundary.rootRelativePath;
    for (const { workspaceRoot, evidenceId } of boundary.memberships) {
      const workspace = boundaries.get(workspaceRoot);
      if (path === workspaceRoot || !within(path, workspaceRoot) || !workspace?.roles.includes("workspace") ||
          !workspace.evidenceIds.includes(evidenceId) || owners.get(evidenceId) !== workspaceRoot) return;
    }
    if (boundary.evidenceIds.some((id) => owners.get(id) !== path &&
        !boundary.memberships.some((member) => member.evidenceId === id))) return;
  }
  const facts = new Map<string, Map<ProjectFact["kind"], ProjectFact[]>>();
  for (const fact of evidence.facts) {
    const boundary = boundaries.get(fact.boundaryPath);
    if (!boundary) return;
    const allowedRoots = new Set([fact.boundaryPath, ...boundary.memberships.map((entry) => entry.workspaceRoot)]);
    if (fact.evidenceIds.some((id) => !allowedRoots.has(owners.get(id) ?? "")) ||
        (fact.declaredAt !== undefined && !allowedRoots.has(fact.declaredAt))) return;
    const byKind = facts.get(fact.boundaryPath) ?? new Map<ProjectFact["kind"], ProjectFact[]>();
    const group = byKind.get(fact.kind) ?? [];
    group.push(fact);
    byKind.set(fact.kind, group);
    facts.set(fact.boundaryPath, byKind);
  }
  if (evidence.inventory.some((entry) => !boundaries.has(entry.boundaryPath) ||
      roots.find((root) => within(entry.relativePath, root)) !== entry.boundaryPath ||
      entry.evidenceIds.some((id) => owners.get(id) !== entry.boundaryPath)) ||
      evidence.coverage.unknown.some((entry) => !boundaries.has(entry.boundaryPath))) return;
  return { refs, roots: roots.sort(compare), facts };
}

function matchCondition(
  condition: Condition, facts: Map<ProjectFact["kind"], ProjectFact[]> | undefined, refs: Map<string, EvidenceRef>,
) {
  const matched = new Set<string>();
  for (const group of condition) {
    const selectors = group.map((selector) => (facts?.get(selector.kind) ?? []).flatMap((fact) => {
      if (fact.basis !== selector.basis ||
          (selector.key !== undefined && fact.key !== selector.key) ||
          (selector.ecosystem !== undefined && fact.ecosystem !== selector.ecosystem) ||
          (selector.scope !== undefined && fact.scope !== selector.scope)) return [];
      return selector.sourceFile === undefined ? fact.evidenceIds :
        fact.evidenceIds.filter((id) => basename(refs.get(id)!.relativePath) === selector.sourceFile);
    }));
    if (selectors.every((ids) => ids.length > 0)) {
      for (const ids of selectors) for (const id of ids) matched.add(id);
    }
  }
  return matched;
}

type Occurrence = RecommendationItem["inventory"]["occurrences"][number];

function indexInventory(evidence: ProjectEvidence) {
  const inventory = new Map<string, Occurrence[]>();
  for (const entry of evidence.inventory) {
    if (entry.kind !== "skill") continue;
    const mismatch = entry.metadataState === "mismatch" ||
      (entry.declaredId !== undefined && entry.declaredId !== entry.directoryId);
    const flags: Occurrence["flags"] = [];
    if (mismatch) flags.push("metadata_mismatch");
    if (entry.metadataState === "malformed" || entry.metadataState === "unreadable") flags.push(entry.metadataState);
    if (entry.customization === "review_signal") flags.push("possible_customization");
    for (const id of new Set([entry.directoryId, entry.declaredId])) {
      if (!id) continue;
      const occurrences = inventory.get(id) ?? [];
      occurrences.push({
        ...entry, evidenceIds: [...new Set(entry.evidenceIds)].sort(compare),
        match: !mismatch && entry.metadataState === "valid" && entry.declaredId === id ? "confirmed" : "candidate",
        flags: flags.sort(compare),
      });
      inventory.set(id, occurrences);
    }
  }
  return inventory;
}

export function evaluateRecommendation(
  input: RecommendationInput, snapshot: CatalogSnapshot, rawEvidence: unknown, settingsRevision: string,
): RecommendationEvent {
  const error = (code: RecommendationErrorCode): RecommendationEvent =>
    ({ status: "error", requestId: input.requestId, code });
  if (snapshot.skills.length > catalogLimits.skills) return error("limit_exceeded");
  if (!catalogSnapshotSchema.safeParse(snapshot).success ||
      new Set(snapshot.skills.map((skill) => skill.id)).size !== snapshot.skills.length) return error("catalog_unavailable");
  const parsed = projectEvidenceSchema.safeParse(rawEvidence);
  if (!parsed.success) return error("invalid_evidence");
  const evidence = parsed.data;
  if (evidence.target.canonicalDirectory !== input.canonicalDirectory) return error("target_changed");
  if (evidence.coverage.limits.includes("response_budget") ||
      evidence.boundaries.length > scanLimits.boundaries ||
      Buffer.byteLength(JSON.stringify(evidence)) > scanLimits.responseBytes) return error("limit_exceeded");
  const indexed = indexEvidence(evidence);
  if (!indexed) return error("invalid_evidence");
  const partial = evidence.coverage.status === "partial";
  const inventory = indexInventory(evidence);
  const metadataCoverage = { valid: 0, missing: 0, invalid: 0 };
  const diagnostics: { skillId: string; code: MetadataDiagnostic }[] = [];
  const items: RecommendationItem[] = [];
  const usedEvidence = new Set<string>();
  let itemBytes = 0;

  for (const skill of ordered(snapshot.skills, (value) => value.id)) {
    const skillId = skill.id;
    const sidecars = skill.supportingFiles.filter((file) => file.path === "applicability.json");
    const sidecar = sidecars[0];
    if (skill.directory !== "skills/" + skillId || skill.metadata.name !== skillId ||
        skill.entrypoint.path !== "SKILL.md" || sidecars.length > 1 ||
        !hasBlobIntegrity(skill.entrypoint) || (sidecar && !hasBlobIntegrity(sidecar))) return error("catalog_unavailable");
    const catalogRef = (file: CatalogDescriptor) => ({
      kind: "catalog_file" as const, path: skill.directory + "/" + file.path, blobSha: file.blobSha,
    });
    const catalog = catalogRef(sidecar ?? skill.entrypoint);
    const coverage = { kind: "scan_coverage" } as const;
    const matches: RecommendationItem["matches"] = [];
    const reasons: RecommendationReason[] = [];
    const parsedRule = sidecar ? readApplicability(sidecar.bytes) : { code: "missing_applicability" as const };
    if ("code" in parsedRule) {
      metadataCoverage[sidecar ? "invalid" : "missing"]++;
      diagnostics.push({ skillId, code: parsedRule.code });
      reasons.push({ code: parsedRule.code, refs: [catalog] });
    } else {
      metadataCoverage.valid++;
      const { rule } = parsedRule;
      if (rule.scope === "project") {
        matches.push({ boundaryPath: ".", verdict: rule.level, reasons: [{ code: "reusable_workflow", refs: [catalog] }] });
      } else {
        for (const boundaryPath of indexed.roots) {
          const facts = indexed.facts.get(boundaryPath);
          const base = matchCondition(rule.appliesWhen, facts, indexed.refs);
          if (base.size === 0) continue;
          const promotion = Array.isArray(rule.recommendWhen) ?
            matchCondition(rule.recommendWhen, facts, indexed.refs) : new Set<string>();
          const recommended = rule.recommendWhen === "on_match" || promotion.size > 0;
          const refs: RecommendationReason["refs"] = [catalog];
          for (const evidenceId of [...new Set([...base, ...promotion])].sort(compare)) {
            usedEvidence.add(evidenceId);
            refs.push({ kind: "project_evidence", evidenceId });
          }
          if (partial) refs.push(coverage);
          matches.push({
            boundaryPath, verdict: recommended ? "recommended" : "optional",
            reasons: [{ code: recommended ? "strong_project_match" :
              rule.recommendWhen ? "additional_evidence_unobserved" : "project_match", refs }],
          });
        }
        if (!matches.length) reasons.push({ code: partial ? "partial_evidence" : "no_supported_evidence", refs: [catalog, coverage] });
      }
    }
    const occurrences = ordered(inventory.get(skillId) ?? [],
      (entry) => [entry.relativePath, entry.layout, JSON.stringify(entry)].join("\0"));
    for (const entry of occurrences) for (const id of entry.evidenceIds) usedEvidence.add(id);
    const item: RecommendationItem = {
      skillId, applicability: matches.some((match) => match.verdict === "recommended") ? "recommended" :
        matches.length ? "optional" : "unknown",
      taskApplicability: "not_assessed", matches, reasons,
      inventory: { occurrences, state: occurrences.length > 1 ? "multiple_occurrences" :
        occurrences[0]?.match === "confirmed" ? "present" : occurrences.length || partial ? "unknown" : "not_observed" },
    };
    itemBytes += Buffer.byteLength(JSON.stringify(item));
    if (itemBytes > catalogLimits.rpcBytes) return error("limit_exceeded");
    items.push(item);
  }

  const event: RecommendationEvent = {
    status: partial || metadataCoverage.invalid > 0 ? "partial" : "ready",
    result: {
      schemaVersion: 1, requestId: input.requestId, target: { canonicalDirectory: input.canonicalDirectory },
      catalog: { source: snapshot.source, commitSha: snapshot.commitSha, settingsRevision },
      scanCoverage: {
        status: evidence.coverage.status,
        limits: [...new Set(evidence.coverage.limits)].sort(compare),
        unknown: ordered(evidence.coverage.unknown, (value) => JSON.stringify(value)),
      },
      warnings: ordered(evidence.warnings, (value) => JSON.stringify(value)),
      metadataCoverage, diagnostics, items,
      evidence: [...usedEvidence].sort(compare).map((id) => indexed.refs.get(id)!),
    },
  };
  if (Buffer.byteLength(JSON.stringify(event)) > catalogLimits.rpcBytes) return error("limit_exceeded");
  return recommendationEvent.parse(event);
}
