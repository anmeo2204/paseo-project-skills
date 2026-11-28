import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const catalogSource = "https://github.com/anmeo2204/project-skills";

export const catalogSelectionModeSchema = z.enum([
  "latest_stable",
  "specific_version",
  "custom",
]);

export const stableSemverTagSchema = z
  .string()
  .regex(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Enter a stable SemVer tag (e.g. v0.1.0).");

export const catalogRefSchema = z.string().refine((ref) => {
  if (ref === "" || /^[0-9a-f]{40}$/i.test(ref)) return true;
  if (/^[0-9a-f]{7,}$/i.test(ref)) return false;

  // Bare names are interpreted exclusively as tags when M2 resolves the revision.
  return ref !== "HEAD" && ref !== "@" && !ref.startsWith("-") &&
    !ref.startsWith("refs/") && !ref.endsWith(".") && !ref.includes("..") &&
    !ref.includes("@{") && !/[\s~^:?*\[\\\u0000-\u001f\u007f]/u.test(ref) &&
    ref.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}, "Enter a tag name or a full 40-character commit SHA.");

export const catalogSettingsSchema = z.object({
  // Authoritative pinned revision used by CatalogLoader, Recommendation, Preview, and Apply.
  // Normal M5.1 UI workflows always persist a lowercase 40-char commit SHA here.
  // Existing hosts with "" or a legacy tag continue to parse without migration breakage.
  catalogRef: catalogRefSchema.default(""),
  selectionMode: catalogSelectionModeSchema.optional(),
  selectedTag: catalogRefSchema.optional(),
}).superRefine((val, ctx) => {
  if (val.catalogRef === "" && (val.selectionMode !== undefined || val.selectedTag !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Selection metadata requires a pinned catalogRef." });
  }
  if (val.selectionMode === "latest_stable" || val.selectionMode === "specific_version") {
    if (!/^[a-f0-9]{40}$/.test(val.catalogRef)) {
      ctx.addIssue({ code: "custom", message: "Managed modes require a pinned 40-character commit SHA." });
    }
    if (!val.selectedTag || !stableSemverTagSchema.safeParse(val.selectedTag).success) {
      ctx.addIssue({ code: "custom", message: "Managed modes require a valid stable SemVer tag." });
    }
  }
  if (val.selectionMode === "custom" && val.selectedTag !== undefined && val.selectedTag === "") {
    ctx.addIssue({ code: "custom", message: "selectedTag must be non-empty when present." });
  }
});

export const catalogSettings = defineSettings({
  id: "catalog",
  scope: "host",
  version: 1,
  schema: catalogSettingsSchema,
});

export type CatalogSelectionMode = z.infer<typeof catalogSelectionModeSchema>;
export type CatalogSettingsValues = z.infer<typeof catalogSettingsSchema>;
