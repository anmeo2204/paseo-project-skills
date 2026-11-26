import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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
