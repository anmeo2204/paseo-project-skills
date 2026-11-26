import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const foundationStatusRpc = defineRpc({
  name: "foundation.status",
  input: z.strictObject({}),
  output: z.object({ status: z.literal("ready") }),
});
