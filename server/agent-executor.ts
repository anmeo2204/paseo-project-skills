import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { PaseoAgent, PaseoAgentHandle, PaseoApi, PaseoWorkspaceHandle } from "@getpaseo/client";
import { agentSelectionSchema, type AgentExecutionResult, type AgentSelection } from "../shared/agent-capability";
import { agentCapabilities, agentConfig, assessCapability, profileFailure, type AgentHost, type VerifiedAgentProfile } from "./agent-capabilities";
import { AgentExecutionError, parseAgentOutput, preparePrompt, type AgentOutputContract, type AgentPayload } from "./agent-payload";

const ownershipKey = "paseo-project-skills.operation";
const defaultLimits = { discoveryMs: 15_000, createMs: 20_000, turnMs: 45_000, cleanupMs: 15_000 };
type Request = { requestId: string; serverId: string; selection: AgentSelection; payload: AgentPayload };
type Session = { stop: AbortController; done: Promise<unknown> };

function bounded<T>(start: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new AgentExecutionError("cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new AgentExecutionError("cancelled")));
    const timer = setTimeout(() => finish(() => reject(new AgentExecutionError("timeout"))), ms);
    function finish(settle: () => void) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      settle();
    }
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw new AgentExecutionError("cancelled");
      return start();
    }).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

function inside(parent: string, path: string) {
  const subpath = relative(parent, path);
  return !isAbsolute(subpath) && subpath !== ".." && !subpath.startsWith(".." + sep);
}

class RequestResources {
  readonly operationId = randomUUID();
  readonly workspaceId = "wks_" + randomBytes(8).toString("hex");
  readonly agentId = randomUUID();
  directory?: string;
  discovery?: ReturnType<PaseoApi["providers"]["waitForReady"]>;
  workspace?: Promise<PaseoWorkspaceHandle>;
  agent?: Promise<PaseoAgentHandle>;
  private identity?: { dev: number; ino: number };

  constructor(private readonly paseo: PaseoApi, private readonly host: AgentHost) {}

  async stage(payload: AgentPayload) {
    const base = await realpath(tmpdir());
    if (payload.purpose === "production") {
      const rawTarget = payload.evidence.target.canonicalDirectory;
      if (!isAbsolute(rawTarget)) throw new AgentExecutionError("unsafe_working_directory");
      const target = await realpath(rawTarget);
      if (target !== rawTarget || inside(target, base)) throw new AgentExecutionError("unsafe_working_directory");
    }
    this.directory = await mkdtemp(join(base, "paseo-skill-agent-"));
    const state = await lstat(this.directory);
    this.identity = { dev: state.dev, ino: state.ino };
    if (!state.isDirectory() || (state.mode & 0o077) !== 0 || await realpath(this.directory) !== this.directory) {
      throw new AgentExecutionError("unsafe_working_directory");
    }
    return this.directory;
  }

  ownsWorkspace(workspace: PaseoWorkspaceHandle) {
    return workspace.id === this.workspaceId && workspace.directory === this.directory &&
      workspace.metadata?.[ownershipKey] === this.operationId;
  }

  ownsAgent(agent: PaseoAgentHandle, snapshot: PaseoAgent | null) {
    return agent.id === this.agentId && agent.address.serverId === this.host.serverId &&
      snapshot?.id === this.agentId && snapshot.workspaceId === this.workspaceId &&
      snapshot.cwd === this.directory && snapshot.labels[ownershipKey] === this.operationId;
  }

  async cleanup() {
    // Await late create ACKs even if the caller has already cancelled. An ambiguous
    // rejection is reconciled by exact ID and a request-owned nonce, never by title.
    // Catalog discovery may also own an ACP process using this cwd.
    await this.discovery?.catch(() => undefined);
    if (this.agent) {
      const agent = await this.agent.catch(() => this.paseo.agents.ref(this.agentId));
      const snapshot = (await agent.refresh())?.agent ?? null;
      if (!this.ownsAgent(agent, snapshot)) throw new AgentExecutionError("cleanup_failed");
      const result = await agent.archive();
      if (!result.archivedAt) throw new AgentExecutionError("cleanup_failed");
    }
    if (this.workspace) {
      const workspace = await this.workspace.catch(() => this.paseo.workspaces.ref(this.workspaceId));
      await workspace.refresh();
      if (!this.ownsWorkspace(workspace)) throw new AgentExecutionError("cleanup_failed");
      const result = await workspace.archive();
      if (result.error || result.workspaceId !== this.workspaceId || !result.archivedAt) {
        throw new AgentExecutionError("cleanup_failed");
      }
    }
    if (this.directory) {
      const state = await lstat(this.directory);
      if (!state.isDirectory() || !this.identity || state.dev !== this.identity.dev || state.ino !== this.identity.ino ||
          await realpath(this.directory) !== this.directory) throw new AgentExecutionError("cleanup_failed");
      await rm(this.directory, { recursive: true });
    }
  }

  get receipt() {
    return {
      operationId: this.operationId,
      ...(this.workspace ? { workspaceId: this.workspaceId } : {}),
      ...(this.agent ? { agentId: this.agentId } : {}),
    };
  }

  get ownership() { return { [ownershipKey]: this.operationId }; }
}

function verifySession(selection: AgentSelection, snapshot: PaseoAgent): void {
  if (snapshot.provider !== selection.provider || snapshot.runtimeInfo?.provider !== selection.provider ||
      snapshot.runtimeInfo.model !== selection.model) throw new AgentExecutionError("model_mismatch");
  const effectiveMode = snapshot.runtimeInfo.modeId ?? snapshot.currentModeId;
  if (effectiveMode !== selection.mode || (selection.provider === "codex" &&
      (snapshot.options?.sandbox_mode !== "read-only" || snapshot.options?.approval_policy !== "never" ||
       snapshot.options?.web_search !== "disabled"))) throw new AgentExecutionError("unsafe_execution_profile");
}

function projectUsage(usage: PaseoAgent["lastUsage"]) {
  if (!usage) return;
  const { inputTokens, outputTokens, totalCostUsd } = usage;
  const accepted = Object.fromEntries(Object.entries({ inputTokens, outputTokens, totalCostUsd })
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0));
  return Object.keys(accepted).length ? accepted : undefined;
}

export class AgentExecutor {
  private disposed = false;
  private readonly active = new Map<string, Session>();
  private readonly profiles: readonly VerifiedAgentProfile[];
  private readonly host: AgentHost;
  private readonly limits: typeof defaultLimits;

  // Bind one public SDK instance to a trusted host/profile audit. M2.3 ships no
  // approved profiles and exposes no RPC for registering them or starting runs.
  constructor(private readonly paseo: PaseoApi, host: AgentHost, options: {
    profiles?: readonly VerifiedAgentProfile[];
    limits?: Partial<typeof defaultLimits>;
  } = {}) {
    this.host = { ...host, providerVersions: { ...host.providerVersions },
      providerHookConflicts: { ...host.providerHookConflicts } };
    this.profiles = options.profiles?.map((profile) => ({ ...profile })) ?? [];
    this.limits = { ...defaultLimits, ...options.limits };
  }

  async execute<T>(request: Request, output: AgentOutputContract<T>, signal: AbortSignal): Promise<AgentExecutionResult<T>> {
    const { requestId } = request;
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(requestId)) return { status: "error", requestId: "", code: "invalid_input" };
    if (this.disposed || signal.aborted) return { status: "error", requestId, code: "cancelled" };
    if (request.serverId !== this.host.serverId) return { status: "error", requestId, code: "host_mismatch" };
    if (this.active.has(requestId) || this.active.size >= 2) return { status: "error", requestId, code: "busy" };

    const stop = new AbortController();
    const abort = () => stop.abort();
    signal.addEventListener("abort", abort, { once: true });
    const { completion, cleanup } = this.run(request, output, stop.signal);
    const done = completion.finally(() => signal.removeEventListener("abort", abort));
    this.active.set(requestId, { stop, done });
    // Keep the slot until late cleanup settles; unresolved operations cannot be
    // retried on the same executor merely because the caller's deadline elapsed.
    void cleanup.then(() => this.active.delete(requestId), () => this.active.delete(requestId));
    return done;
  }

  async dispose() {
    this.disposed = true;
    const active = [...this.active.values()];
    for (const { stop } of active) stop.abort();
    await Promise.allSettled(active.map(({ done }) => done));
  }

  private run<T>(request: Request, output: AgentOutputContract<T>, signal: AbortSignal) {
    const resources = new RequestResources(this.paseo, this.host);
    const execute = async (): Promise<AgentExecutionResult<T>> => {
      const selection = agentSelectionSchema.parse(request.selection);
      const purpose = request.payload.purpose;
      const failure = profileFailure(this.host, selection, purpose, this.profiles);
      if (failure) throw new AgentExecutionError(failure);
      const { prompt, jsonSchema } = preparePrompt(request.payload, output);
      const cwd = await resources.stage(request.payload);
      const snapshot = await bounded(
        () => resources.discovery = this.paseo.providers.waitForReady({ cwd, timeoutMs: this.limits.discoveryMs }),
        this.limits.discoveryMs, signal,
      );
      const entry = snapshot.entries.find(({ provider }) => provider === selection.provider);
      const assessment = assessCapability(this.host, selection, purpose, this.profiles, entry);
      if (assessment.eligibility !== (purpose === "production" ? "production-eligible" : "synthetic-eligible")) {
        throw new AgentExecutionError(assessment.reason ?? "capability_unverified");
      }
      const workspace = await bounded(() => resources.workspace = this.paseo.workspaces.create({
        workspaceId: resources.workspaceId,
        source: { kind: "directory", path: cwd },
        title: "Project Skills analysis",
        background: true,
        metadata: resources.ownership,
      }), this.limits.createMs, signal);
      if (!resources.ownsWorkspace(workspace)) throw new AgentExecutionError("unsafe_working_directory");

      const native = agentCapabilities[selection.provider].output === "native-schema";
      const agent = await bounded(() => resources.agent = workspace.agents.create({
        agentId: resources.agentId,
        background: true,
        title: "Project Skills analysis",
        labels: resources.ownership,
        config: agentConfig(selection),
        ...(native ? { prompt, outputSchema: jsonSchema, clientMessageId: resources.operationId } : {}),
      }), this.limits.createMs, signal);
      // Check ownership and effective model/mode before submitting text to ACP.
      // Codex schema is initial-turn only, so its preflight is the pre-submit gate.
      const current = agent.current() ?? (await bounded(() => agent.refresh(), this.limits.createMs, signal))?.agent ?? null;
      if (!resources.ownsAgent(agent, current) || !current) throw new AgentExecutionError("unsafe_execution_profile");
      if (current.pendingPermissions.length) {
        throw new AgentExecutionError("permission_required");
      }
      verifySession(selection, current);
      if (!native && (current.status !== "idle" || current.activeTurn || current.lastUserMessageAt)) {
        throw new AgentExecutionError("unsafe_execution_profile");
      }
      const result = await bounded(
        () => native ? agent.waitForFinish(this.limits.turnMs) :
          agent.run(prompt, { timeoutMs: this.limits.turnMs, messageId: resources.operationId }),
        this.limits.turnMs, signal,
      );
      if (result.status === "permission" || result.final?.pendingPermissions.length) throw new AgentExecutionError("permission_required");
      if (result.status === "timeout") throw new AgentExecutionError("timeout");
      if (result.status !== "idle" || !result.final) throw new AgentExecutionError("provider_error");
      if (!resources.ownsAgent(agent, result.final)) throw new AgentExecutionError("unsafe_execution_profile");
      verifySession(selection, result.final);
      const value = parseAgentOutput(result.lastMessage, output.schema);
      const usage = projectUsage(result.final.lastUsage);
      return { status: "ok", requestId: request.requestId, selection, value, ...(usage ? { usage } : {}) };
    };
    const result = execute().catch((error): AgentExecutionResult<T> => ({
      status: "error", requestId: request.requestId, code: error instanceof AgentExecutionError ? error.code :
        signal.aborted ? "cancelled" : error instanceof SyntaxError || error?.name === "ZodError" ? "invalid_input" : "provider_error",
    }));
    const cleanup = result.then(() => resources.cleanup());
    const completion = result.then(async (outcome): Promise<AgentExecutionResult<T>> => {
      try {
        await bounded(() => cleanup, this.limits.cleanupMs);
      } catch {
        return { status: "error", requestId: request.requestId, code: "cleanup_failed", cleanup: resources.receipt };
      }
      return signal.aborted ? { status: "error", requestId: request.requestId, code: "cancelled" } : outcome;
    });
    return { completion, cleanup };
  }
}
