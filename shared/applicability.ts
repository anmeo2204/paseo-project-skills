import { z } from "zod";

const selectorSchema = z.strictObject({
  kind: z.enum(["language", "framework", "manifest", "package_manager", "dependency", "build", "test", "database", "queue", "router"]),
  basis: z.enum(["direct", "inferred"]),
  key: z.string().min(1).max(160).regex(/^[a-zA-Z0-9@._/+*-]+(?![\s\S])/).optional(),
  ecosystem: z.enum(["npm", "composer", "go"]).optional(),
  scope: z.enum(["production", "dev", "peer", "optional", "indirect"]).optional(),
  sourceFile: z.string().min(1).max(160).regex(/^[a-zA-Z0-9._-]+(?![\s\S])/)
    .refine((name) => name !== "." && name !== "..").optional(),
}).refine(({ kind, key, sourceFile, ecosystem, scope }) =>
  (key !== undefined || (sourceFile !== undefined && ["router", "database", "queue"].includes(kind))) &&
  (kind === "dependency" || (ecosystem === undefined && scope === undefined)));

const conditionSchema = z.array(z.array(selectorSchema).min(1).max(4)).min(1).max(4);

export const applicabilitySchema = z.discriminatedUnion("scope", [
  z.strictObject({
    schemaVersion: z.literal(1),
    scope: z.literal("project"),
    level: z.enum(["recommended", "optional"]),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    scope: z.literal("boundary"),
    appliesWhen: conditionSchema,
    recommendWhen: z.union([z.literal("on_match"), conditionSchema]).optional(),
  }),
]);

export type ApplicabilityRule = z.infer<typeof applicabilitySchema>;
export type Condition = z.infer<typeof conditionSchema>;
