import type { SelectionIntentV1 } from "../shared/selection-intent";
import type { DerivedPreviewEntry, PreviewDiagnostic, PreviewEntry, PreviewResult, ProviderPreviewStatus } from "../shared/preview";
import type { CanonicalPlan } from "./canonical-preview";
import { compare } from "./project-reader";
import { verifyPreviewGitRoot, type PreviewGitRoot } from "./preview-git-root";

const verified = (binaryVersion: string, transport: string, loadMode: string,
  cwdScope: "root_and_nested" | "git_root", note: string): ProviderPreviewStatus["verification"] => ({
  basis: "historical_m3_1", report: "M3.1-completion-report.md", paseoVersion: "0.17.5",
  binaryVersion, transport, loadMode, cwdScope, note,
});
const verification = {
  codex: verified("0.167.0", "app-server", "auto; read-only; approval never; web search disabled", "root_and_nested",
    "M3.1 model gpt-6.1-sol. Historical discovery/load evidence; not a live runtime attestation."),
  cursor: verified("2026.10.22-27dcf5f", "cursor-agent acp", "ask", "root_and_nested",
    "M3.1 model grok-4.7; discovery also observed in agent mode. ACP verification, not standalone print mode."),
  antigravity: verified("1.5.18", "agy acp --disable-telemetry", "plan", "root_and_nested",
    "M3.1 model gemini-4-neon. Nested CWD retains the permission flow to read the canonical skill at an ancestor; no permission/config change is proposed."),
  kiro: verified("2.34.2", "kiro-cli acp", "kiro_default", "git_root",
    "M3.1 model reported auto. Derived .kiro/skills discovery/load verified only with session CWD at root; custom agents and nested sessions are not covered."),
};
const under = (destination: string, changed: string[]) => changed.some((path) => destination === path || destination.startsWith(path + "/"));
const deferReason = (entries: PreviewEntry[], skillId: string) => {
  const relevant = entries.filter((entry) => entry.skillId === skillId);
  return relevant.some((entry) => entry.status === "blocked") ? "canonical_blocked" as const :
    relevant.some((entry) => entry.status === "conflict") ? "canonical_conflict" as const : undefined;
};

export async function prepareProviderPreview(intent: SelectionIntentV1, plan: CanonicalPlan, signal: AbortSignal) {
  const ids = [...intent.selectedSkillIds].sort(compare);
  const selected = [...intent.targetProviderIds].sort(compare);
  const hasKiro = selected.includes("kiro");
  let rootStatus: PreviewGitRoot = hasKiro ? await verifyPreviewGitRoot(intent.canonicalDirectory, plan.reader, signal) : "unconfirmed";
  const derived: DerivedPreviewEntry[] = [];
  if (hasKiro && rootStatus !== "unconfirmed") {
    for (const file of plan.files) {
      if (deferReason(plan.entries, file.skillId)) continue;
      const destination = file.destination.replace(/^\.agents\//, ".kiro/");
      const entry = await plan.compareFile(file, destination);
      derived.push({ ...entry, providerId: "kiro", canonicalDestination: file.destination });
    }
  }
  // Targeted inventory only: selected directory IDs, at the target's root layouts.
  // Do not read unrelated skill bodies or claim global/provider-home inventory.
  const inventory = new Map<string, { path: string; state: "present" | "missing" | "blocked" }[]>();
  if (selected.length) for (const id of ids) {
    const occurrences = [];
    for (const layout of [".agents/skills", ".cursor/skills", ".kiro/skills"]) {
      const path = layout + "/" + id + "/SKILL.md";
      occurrences.push({ path, state: await plan.reader.inspect(path) });
    }
    inventory.set(id, occurrences);
  }
  return {
    async revalidateRoot() {
      if (hasKiro && rootStatus !== "unconfirmed" &&
          await verifyPreviewGitRoot(intent.canonicalDirectory, plan.reader, signal) !== rootStatus) rootStatus = "unconfirmed";
    },
    finish(canonical: Extract<PreviewResult, { status: "ready" }>, changed: string[]) {
      const diagnostics: PreviewDiagnostic[] = [];
      const providers: ProviderPreviewStatus[] = selected.map((providerId) => {
        if (providerId !== "kiro") return { providerId, strategy: "canonical_only", status: "canonical_only",
          verification: verification[providerId], skills: [] };
        if (under(".git", changed)) rootStatus = "unconfirmed";
        const skills: ProviderPreviewStatus["skills"] = ids.map((skillId) => {
          const reason = rootStatus === "unconfirmed" ? "kiro_root_unconfirmed" : deferReason(canonical.entries, skillId);
          if (reason) {
            diagnostics.push({ code: reason, providerId, skillId,
              paths: canonical.entries.filter((e) => e.skillId === skillId && ["conflict", "blocked"].includes(e.status)).map((e) => e.destination) });
            return { skillId, status: "deferred", reason };
          }
          return { skillId, status: "planned" };
        });
        if (rootStatus === "unconfirmed" && !ids.length) diagnostics.push({ code: "kiro_root_unconfirmed", providerId, paths: [] });
        const deferred = skills.filter((skill) => skill.status === "deferred").length;
        const needsReview = derived.some((e) => e.status === "conflict" || e.status === "blocked" || under(e.destination, changed));
        return { providerId, strategy: "kiro_derived", rootStatus, verification: verification.kiro, skills,
          status: rootStatus === "unconfirmed" ? "limited" : deferred === ids.length && deferred > 0 ? "deferred" :
            deferred || needsReview ? "partial" : "ready" };
      });
      const allowed = new Set(providers.find((p) => p.providerId === "kiro")?.skills.filter((s) => s.status === "planned").map((s) => s.skillId));
      const derivedEntries = derived.filter((entry) => allowed.has(entry.skillId)).map((entry): DerivedPreviewEntry =>
        under(entry.destination, changed) ? { skillId: entry.skillId, destination: entry.destination,
          proposed: entry.proposed, status: "blocked", reason: "entry_changed", providerId: "kiro",
          canonicalDestination: entry.canonicalDestination } : entry).sort((a, b) => compare(a.destination, b.destination));
      for (const [skillId, occurrences] of inventory) {
        const paths = occurrences.filter((o) => o.state === "present" && !under(o.path, changed)).map((o) => o.path).sort(compare);
        if (paths.length > 1) diagnostics.push({ code: "duplicate_skill_id", skillId, basis: "directory_id", paths });
        const uncertain = occurrences.filter((o) => o.state === "blocked" || under(o.path, changed)).map((o) => o.path).sort(compare);
        if (uncertain.length) diagnostics.push({ code: "inventory_unverified", skillId, paths: uncertain });
      }
      diagnostics.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
      return { ...canonical, providers, derivedEntries, diagnostics };
    },
  };
}
