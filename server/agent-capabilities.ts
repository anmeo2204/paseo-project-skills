import type { PaseoAgentConfig, PaseoProviderSnapshotResult } from "@getpaseo/client";
import type { AgentProvider, AgentPurpose, AgentSelection } from "../shared/agent-capability";

export const agentCapabilities = {
  codex: { transport: "app-server", output: "native-schema" },
  cursor: { transport: "acp", output: "json-text" },
  kiro: { transport: "acp", output: "json-text" },
  antigravity: { transport: "acp-plugin", output: "json-text" },
} as const satisfies Record<AgentProvider, { transport: string; output: "native-schema" | "json-text" }>;

// This binding must come from a trusted daemon-side caller, never an RPC request.
export interface AgentHost {
  serverId: string;
  paseoVersion: string;
  providerVersions: Readonly<Partial<Record<AgentProvider, string>>>;
  executionProfileId: string;
  providerHookConflicts?: Readonly<Partial<Record<AgentProvider, true>>>;
}

export interface VerifiedAgentProfile extends AgentSelection {
  serverId: string;
  paseoVersion: string;
  providerVersion: string;
  executionProfileId: string;
  purpose: AgentPurpose;
  permissions: "deny" | "unknown";
  filesystem: "target-inaccessible" | "unknown";
  shell: "disabled" | "unknown";
  networkTools: "disabled" | "unknown";
  extraTools: "disabled" | "unknown";
  hostHooks: "verified-no-auto-approval-or-tool-injection" | "unknown" | "conflict";
  preferences: "unchanged" | "unknown";
  nativeSchema?: "verified";
  cursorCurrentModel?: string;
}

type Entry = PaseoProviderSnapshotResult["entries"][number];
export interface CapabilityAssessment {
  availability: "available" | "unavailable" | "unverified";
  eligibility: "unverified" | "blocked" | "synthetic-eligible" | "production-eligible";
  reason?: "provider_unavailable" | "model_unavailable" | "capability_unverified" | "unsafe_execution_profile";
}

export function profileFailure(
  host: AgentHost, selection: AgentSelection, purpose: AgentPurpose,
  profiles: readonly VerifiedAgentProfile[],
): "unsafe_execution_profile" | "capability_unverified" | undefined {
  if (host.providerHookConflicts?.[selection.provider] || /^auto$/i.test(selection.mode) || /full[-_ ]?access|auto[-_ ]?(accept|approve|review)|bypass|yolo|unattended/i.test(selection.mode) ||
      (selection.provider === "codex" && selection.mode !== "read-only") ||
      (selection.provider === "antigravity" && selection.mode.toLowerCase() === "default")) return "unsafe_execution_profile";
  const version = host.providerVersions[selection.provider];
  const profile = version && profiles.find((candidate) =>
    candidate.serverId === host.serverId && candidate.paseoVersion === host.paseoVersion &&
    candidate.executionProfileId === host.executionProfileId && candidate.providerVersion === version &&
    candidate.provider === selection.provider && candidate.model === selection.model &&
    candidate.mode === selection.mode && candidate.purpose === purpose,
  );
  if (host.paseoVersion !== "0.17.4" || !host.serverId || !host.executionProfileId || !profile) return "capability_unverified";
  if (profile.permissions !== "deny" || profile.filesystem !== "target-inaccessible" ||
      profile.shell !== "disabled" || profile.networkTools !== "disabled" || profile.extraTools !== "disabled" ||
      profile.hostHooks !== "verified-no-auto-approval-or-tool-injection" || profile.preferences !== "unchanged" ||
      (selection.provider === "cursor" && profile.cursorCurrentModel !== selection.model)) return "unsafe_execution_profile";
  if (selection.provider === "codex" && profile.nativeSchema !== "verified") return "capability_unverified";
}

export function assessCapability(
  host: AgentHost, selection: AgentSelection, purpose: AgentPurpose,
  profiles: readonly VerifiedAgentProfile[], entry?: Entry,
): CapabilityAssessment {
  const availability = entry?.status === "ready" && entry.enabled ? "available" :
    entry && (entry.status === "unavailable" || entry.status === "error" || !entry.enabled) ? "unavailable" : "unverified";
  const blocked = { availability, eligibility: "blocked", reason: "unsafe_execution_profile" } as const;
  const reason = profileFailure(host, selection, purpose, profiles);
  if (reason) return { availability, eligibility: reason === "unsafe_execution_profile" ? "blocked" : "unverified", reason };
  if (!entry || entry.provider !== selection.provider || availability !== "available") {
    return { availability, eligibility: "unverified", reason: "provider_unavailable" };
  }
  const selectedModel = entry.models?.find(({ id }) => id === selection.model);
  if (!selectedModel) return { availability, eligibility: "blocked", reason: "model_unavailable" };
  const mode = entry.modes?.find(({ id }) => id === selection.mode);
  if (!mode || ("isUnattended" in mode && mode.isUnattended === true) || (selection.provider === "cursor" && selectedModel.isDefault !== true)) {
    return blocked;
  }
  return { availability, eligibility: purpose === "production" ? "production-eligible" : "synthetic-eligible" };
}

export function agentConfig(selection: AgentSelection): PaseoAgentConfig {
  return {
    provider: selection.provider + "/" + selection.model,
    modeId: selection.mode,
    ...(selection.provider === "codex" ? {
      options: { sandbox_mode: "read-only", approval_policy: "never", web_search: "disabled" },
    } : {}),
  };
}
