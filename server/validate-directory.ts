import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, parse, sep } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { validateDirectoryRpc } from "../shared/rpc";

export async function validateDirectory(
  { path }: RpcInput<typeof validateDirectoryRpc>,
): Promise<RpcOutput<typeof validateDirectoryRpc>> {
  // Windows allows drive-root-relative paths such as \folder in isAbsolute().
  if (!isAbsolute(path) || path.includes("\0") || (sep === "\\" && parse(path).root.length === 1)) {
    return { status: "error", code: "invalid_path" };
  }

  try {
    const directory = await realpath(path);
    if (!(await stat(directory)).isDirectory()) {
      return { status: "error", code: "not_directory" };
    }
    await access(directory, constants.R_OK | constants.X_OK);
    return { status: "ready", directory };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    switch (code) {
      case "ENOENT": return { status: "error", code: "missing" };
      case "ENOTDIR": return { status: "error", code: "not_directory" };
      case "EACCES":
      case "EPERM": return { status: "error", code: "permission_denied" };
      default: return { status: "error", code: "unreadable" };
    }
  }
}
