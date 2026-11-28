import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { agentProviderSchema, type AgentProvider } from "./agent-capability";

export const workspacePreferenceLimits = Object.freeze({
  maxRecentProjects: 8,
  maxProviderPreferenceRoots: 32,
  maxWorkspacePages: 20,
});

const safePathSchema = z.string().min(1).max(4096).refine((path) => !path.includes("\0"));
const uniqueProviders = (values: AgentProvider[]) => new Set(values).size === values.length;

export const recentProjectSchema = z.strictObject({
  canonicalDirectory: safePathSchema,
  label: z.string().min(1).max(200),
  kind: z.string().min(1).max(64),
  lastUsedAt: z.number().int().nonnegative(),
});

export const providerPreferenceEntrySchema = z.strictObject({
  providers: z.array(agentProviderSchema).max(4).refine(uniqueProviders),
  updatedAt: z.number().int().nonnegative(),
});

export const workspacePreferencesSchema = z.object({
  recentProjects: z.array(recentProjectSchema).max(workspacePreferenceLimits.maxRecentProjects).default([]),
  providerPreferencesByRoot: z.record(safePathSchema, providerPreferenceEntrySchema)
    .refine((map) => Object.keys(map).length <= workspacePreferenceLimits.maxProviderPreferenceRoots)
    .default({}),
});

export const workspacePreferencesSettings = defineSettings({
  id: "workspace-preferences",
  scope: "host",
  version: 1,
  schema: workspacePreferencesSchema,
});

export type RecentProject = z.infer<typeof recentProjectSchema>;
export type ProviderPreferenceEntry = z.infer<typeof providerPreferenceEntrySchema>;
export type WorkspacePreferencesValues = z.infer<typeof workspacePreferencesSchema>;

export type WorkspacePreferenceMutation =
  | {
    type: "record_recent";
    canonicalDirectory: string;
    label: string;
    kind: string;
    now: number;
  }
  | {
    type: "remove_recent";
    canonicalDirectory: string;
  }
  | {
    type: "set_providers";
    canonicalDirectory: string;
    providers: readonly AgentProvider[];
    now: number;
  };

export function normalizeProviders(providers: readonly AgentProvider[]): AgentProvider[] {
  return [...new Set(providers)].sort();
}

export function applyWorkspacePreferenceMutation(
  current: WorkspacePreferencesValues,
  mutation: WorkspacePreferenceMutation,
): WorkspacePreferencesValues {
  if (mutation.type === "record_recent") {
    const label = mutation.label.trim().slice(0, 200) || mutation.canonicalDirectory.slice(0, 200);
    const kind = mutation.kind.trim().slice(0, 64) || "Directory";
    const entry: RecentProject = {
      canonicalDirectory: mutation.canonicalDirectory,
      label,
      kind,
      lastUsedAt: Math.max(0, Math.trunc(mutation.now)),
    };
    const nextRecent = [
      entry,
      ...current.recentProjects.filter((item) => item.canonicalDirectory !== mutation.canonicalDirectory),
    ].slice(0, workspacePreferenceLimits.maxRecentProjects);
    return {
      recentProjects: nextRecent,
      providerPreferencesByRoot: { ...current.providerPreferencesByRoot },
    };
  }

  if (mutation.type === "remove_recent") {
    return {
      recentProjects: current.recentProjects.filter((item) => item.canonicalDirectory !== mutation.canonicalDirectory),
      providerPreferencesByRoot: { ...current.providerPreferencesByRoot },
    };
  }

  // P3: Explicitly store `providers: []` so an empty preference is distinguished from missing (`undefined`).
  const nextMap: Record<string, ProviderPreferenceEntry> = {
    ...current.providerPreferencesByRoot,
    [mutation.canonicalDirectory]: {
      providers: normalizeProviders(mutation.providers),
      updatedAt: Math.max(0, Math.trunc(mutation.now)),
    },
  };
  const keys = Object.keys(nextMap);
  if (keys.length > workspacePreferenceLimits.maxProviderPreferenceRoots) {
    const sorted = keys
      .map((key) => ({ key, updatedAt: nextMap[key].updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const trimmed: Record<string, ProviderPreferenceEntry> = {};
    for (const item of sorted.slice(0, workspacePreferenceLimits.maxProviderPreferenceRoots)) {
      trimmed[item.key] = nextMap[item.key];
    }
    return {
      recentProjects: [...current.recentProjects],
      providerPreferencesByRoot: trimmed,
    };
  }
  return {
    recentProjects: [...current.recentProjects],
    providerPreferencesByRoot: nextMap,
  };
}

export function applyWorkspacePreferenceMutations(
  current: WorkspacePreferencesValues,
  mutations: readonly WorkspacePreferenceMutation[],
): WorkspacePreferencesValues {
  let next = current;
  for (const mutation of mutations) {
    next = applyWorkspacePreferenceMutation(next, mutation);
  }
  return next;
}

export function lookupProviderPreference(
  values: WorkspacePreferencesValues | undefined,
  canonicalDirectory: string,
): { found: false } | { found: true; providers: AgentProvider[] } {
  if (!values) return { found: false };
  if (!Object.prototype.hasOwnProperty.call(values.providerPreferencesByRoot, canonicalDirectory)) {
    return { found: false };
  }
  const entry = values.providerPreferencesByRoot[canonicalDirectory];
  return { found: true, providers: normalizeProviders(entry.providers) };
}
