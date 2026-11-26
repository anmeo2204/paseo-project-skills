import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { catalogResultSchema } from "./catalog";
import { projectScanEvent } from "./project-evidence";

export const foundationStatusRpc = defineRpc({
  name: "foundation.status",
  input: z.strictObject({}),
  output: z.object({ status: z.literal("ready") }),
});

export const validateDirectoryRpc = defineRpc({
  name: "target.validate-directory",
  input: z.strictObject({ path: z.string() }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ready"), directory: z.string() }),
    z.object({
      status: z.literal("error"),
      code: z.enum(["invalid_path", "missing", "not_directory", "permission_denied", "unreadable"]),
    }),
  ]),
});

export const catalogLoadRpc = defineRpc({
  name: "catalog.load",
  input: z.strictObject({}),
  output: catalogResultSchema,
});

export const targetScanSubscription = defineSubscription({
  name: "target.scan",
  input: z.strictObject({
    requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/),
    canonicalDirectory: z.string().min(1).max(4096),
  }),
  event: projectScanEvent,
});
