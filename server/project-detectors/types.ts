import type { EvidenceRef, ProjectEvidence, ProjectFact, ProjectWarning } from "../../shared/project-evidence";
import type { ProjectEntry } from "../project-reader";

export type Role = ProjectEvidence["boundaries"][number]["roles"][number];
export type Inventory = ProjectEvidence["inventory"][number];
type DirectFact = Extract<ProjectFact, { basis: "direct" }>;
type InferredFact = Extract<ProjectFact, { basis: "inferred" }>;
export type Fact = Omit<DirectFact, "boundaryPath"> | Omit<InferredFact, "boundaryPath">;
export interface WorkspaceDeclaration { patterns: string[]; evidenceId: string }

export interface DiscoveryContext {
  root: string;
  files: readonly ProjectEntry[];
  read(path: string): Promise<string | undefined>;
  ref(path: string, kind?: EvidenceRef["kind"], selector?: string): string;
  warn(code: ProjectWarning["code"], path?: string): void;
  boundary(role: Role, evidenceId: string): void;
  workspace(declaration: WorkspaceDeclaration): void;
}

export interface DetectionContext extends DiscoveryContext {
  owned: readonly ProjectEntry[];
  shared: readonly string[];
  fact(fact: Fact): void;
  inventory(entry: Omit<Inventory, "boundaryPath">): void;
  unknown(key: string, reason?: "insufficient_evidence" | "outside_policy"): void;
}

export interface ProjectDetector {
  id: string;
  candidate?(path: string): "full" | "prefix" | undefined;
  discover?(context: DiscoveryContext): Promise<void>;
  detect?(context: DetectionContext): Promise<void> | void;
}
