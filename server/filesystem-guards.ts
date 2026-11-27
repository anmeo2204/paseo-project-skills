import type { Stats } from "node:fs";
import type * as fs from "node:fs/promises";
import { join } from "node:path";

export type GuardFs = Pick<typeof fs, "lstat" | "realpath">;
export const sameNode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
export const sameFile = (a: Stats, b: Stats) => sameNode(a, b) && a.size === b.size &&
  a.mode === b.mode && a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export async function rootMatches(root: string, identity: Stats, io: GuardFs) {
  const state = await io.lstat(root);
  return state.isDirectory() && sameNode(identity, state) && await io.realpath(root) === root;
}

// Callers validate relative paths and root identity. Never follow a symlink,
// special file, hard-linked file or a child mount while resolving descendants.
export async function checkProjectPath(root: string, identity: Stats, path: string,
  kind: "file" | "directory", io: GuardFs) {
  let full = root;
  let state = identity;
  const parts = path === "." ? [] : path.split("/");
  for (const [index, part] of parts.entries()) {
    full = join(full, part);
    state = await io.lstat(full);
    const directory = index < parts.length - 1 || kind === "directory";
    if (state.dev !== identity.dev || (directory ? !state.isDirectory() : !state.isFile() || state.nlink !== 1)) return;
  }
  if (await io.realpath(full) !== full) return;
  return { full, state };
}
