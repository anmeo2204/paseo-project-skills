import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PreviewReader } from "./preview-reader";

const exec = promisify(execFile);
export type PreviewGitRoot = "git_root" | "gitfile_root" | "unconfirmed";

// Git is used only for bounded, local rev-parse. No status/index refresh, hooks,
// user aliases, global config, credentials, network or working-tree mutations.
export async function verifyPreviewGitRoot(root: string, reader: PreviewReader, signal: AbortSignal): Promise<PreviewGitRoot> {
  const directory = await reader.inspect(".git", "directory");
  const file = directory === "present" ? "missing" : await reader.inspect(".git", "file");
  if (directory !== "present" && file !== "present") return "unconfirmed";
  reader.checkpoint();
  const { PATH, SystemRoot } = process.env;
  try {
    const { stdout } = await exec("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "rev-parse", "--path-format=absolute", "--show-toplevel", "--is-inside-work-tree"], {
      cwd: root, signal, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 16384, windowsHide: true,
      env: { PATH, SystemRoot, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    await reader.assertRoot();
    if (stdout !== root + "\ntrue\n") return "unconfirmed";
    return directory === "present" ? "git_root" : "gitfile_root";
  } catch {
    reader.checkpoint();
    return "unconfirmed";
  }
}
