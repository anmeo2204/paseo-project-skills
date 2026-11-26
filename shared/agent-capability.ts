import { z } from "zod";

export const agentProviderSchema = z.enum(["codex", "cursor", "kiro", "antigravity"]);
export const agentSelectionSchema = z.strictObject({
  provider: agentProviderSchema,
  model: z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
  mode: z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
});
export type AgentSelection = z.infer<typeof agentSelectionSchema>;
export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type AgentPurpose = "synthetic" | "production";

export type AgentErrorCode =
  | "invalid_input" | "input_limit" | "busy" | "host_mismatch" | "provider_unavailable"
  | "model_unavailable" | "model_mismatch" | "capability_unverified" | "unsafe_execution_profile"
  | "unsafe_working_directory" | "permission_required" | "invalid_output" | "output_limit"
  | "timeout" | "cancelled" | "provider_error" | "cleanup_failed";

export type AgentExecutionResult<T> =
  | {
    status: "ok";
    requestId: string;
    selection: AgentSelection;
    value: T;
    usage?: { inputTokens?: number; outputTokens?: number; totalCostUsd?: number };
  }
  | {
    status: "error";
    requestId: string;
    code: AgentErrorCode;
    cleanup?: { workspaceId?: string; agentId?: string; operationId: string };
  };
