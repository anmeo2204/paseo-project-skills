import { z } from "zod";
import { agentProviderSchema } from "./agent-capability";
import { commitShaSchema, skillSlugSchema } from "./catalog";
import { catalogSource } from "./catalog-settings";

const unique = <T>(values: T[]) => new Set(values).size === values.length;

// Selection records intent only; it is never an authorization to write files.
export const selectionIntentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  hostId: z.string().min(1).max(256),
  canonicalDirectory: z.string().min(1).max(4096).refine((path) => !path.includes("\0")),
  catalogSource: z.literal(catalogSource),
  catalogCommitSha: commitShaSchema,
  settingsRevision: z.string().min(1).max(1024),
  selectedSkillIds: z.array(skillSlugSchema).max(512).refine(unique),
  targetProviderIds: z.array(agentProviderSchema).max(4).refine(unique),
  recommendationRequestId: z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/),
});

export type SelectionIntentV1 = z.infer<typeof selectionIntentV1Schema>;
