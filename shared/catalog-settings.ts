import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const catalogSource = "https://github.com/anmeo2204/project-skills";

export const catalogRefSchema = z.string().refine((ref) => {
  if (ref === "" || /^[0-9a-f]{40}$/i.test(ref)) return true;
  if (/^[0-9a-f]{7,}$/i.test(ref)) return false;

  // Bare names are interpreted exclusively as tags when M2 resolves the revision.
  return ref !== "HEAD" && ref !== "@" && !ref.startsWith("-") &&
    !ref.startsWith("refs/") && !ref.endsWith(".") && !ref.includes("..") &&
    !ref.includes("@{") && !/[\s~^:?*\[\\\u0000-\u001f\u007f]/u.test(ref) &&
    ref.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}, "Enter a tag name or a full 40-character commit SHA.");

export const catalogSettings = defineSettings({
  id: "catalog",
  scope: "host",
  version: 1,
  schema: z.object({ catalogRef: catalogRefSchema.default("") }),
});
