import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import type { PreviewManifest } from "../shared/preview-receipt";
import { PreviewError, type PreviewReader } from "./preview-reader";
import type { ReceiptObservations } from "./receipt-observations";

const exec = promisify(execFile);
export async function receiptGitProof(root: string, reader: PreviewReader, observations: ReceiptObservations,
  signal: AbortSignal, rootStatus: "git_root" | "gitfile_root" | "unconfirmed" | undefined): Promise<PreviewManifest["gitProof"]> {
  if (!rootStatus || rootStatus === "unconfirmed") return { status: "unconfirmed" };
  reader.checkpoint();
  const { PATH, SystemRoot } = process.env;
  try {
    const { stdout } = await exec("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "rev-parse", "--path-format=absolute", "--show-toplevel", "--is-inside-work-tree", "--absolute-git-dir", "--git-common-dir"], {
      cwd: root, signal, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 16384, windowsHide: true,
      env: { PATH, SystemRoot, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    const lines = stdout.split("\n");
    if (lines.length !== 5 || lines[0] !== root || lines[1] !== "true" || lines[4] !== "" ||
      !isAbsolute(lines[2]) || !isAbsolute(lines[3])) throw new PreviewError("target_changed");
    for (const path of new Set([lines[2], lines[3]])) {
      const state = await observations.capture(path, "git_metadata");
      if (!state.isDirectory() || await observations.io.realpath(path) !== path) throw new PreviewError("target_changed");
    }
    let markerSha256: string | undefined;
    if (rootStatus === "gitfile_root") {
      const marker = await reader.read(".git");
      if (!marker.bytes || marker.reason) throw new PreviewError("target_changed");
      markerSha256 = createHash("sha256").update(marker.bytes).digest("hex");
    }
    await reader.assertRoot();
    return { status: "confirmed", rootStatus, gitDirectory: lines[2], commonDirectory: lines[3],
      ...(markerSha256 ? { markerSha256 } : {}) };
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    reader.checkpoint();
    throw new PreviewError("target_changed");
  }
}
