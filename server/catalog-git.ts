import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitShaSchema } from "../shared/catalog";
import { CatalogError } from "./catalog-error";
import { catalogLimits } from "./catalog-limits";

export const catalogRemote = "git@github.com:anmeo2204/project-skills.git";

const sshCommand = "/usr/bin/ssh -o BatchMode=yes -o StrictHostKeyChecking=yes";
const tagRef = "refs/catalog/requested-tag";

function gitEnvironment(localFixture: boolean): NodeJS.ProcessEnv {
  const { PATH, HOME, USERPROFILE, SystemRoot, SSH_AUTH_SOCK } = process.env;
  return {
    PATH, HOME, USERPROFILE, SystemRoot, SSH_AUTH_SOCK,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: sshCommand,
    GIT_ALLOW_PROTOCOL: localFixture ? "file" : "ssh",
  };
}

function gitFailure(stderr: string, fetching: boolean): CatalogError {
  if (fetching) {
    if (/host key verification failed|permission denied|no .*host key|remote host identification has changed/i.test(stderr)) {
      return new CatalogError("auth_failed");
    }
    if (/could not resolve hostname|connection (refused|closed|reset|timed out)|network is unreachable|broken pipe/i.test(stderr)) {
      return new CatalogError("network_error");
    }
    if (/couldn't find remote ref|not our ref|unadvertised object|repository not found/i.test(stderr)) {
      return new CatalogError("revision_unavailable");
    }
  }
  return new CatalogError("git_error");
}

async function stagingSize(path: string, limit: number): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await stagingSize(child, limit - total);
    else if (entry.isFile()) total += (await stat(child)).size;
    if (total > limit) break;
  }
  return total;
}

export interface CatalogGitOptions {
  // A local remote and temp root can be injected by tests. The RPC supplies neither.
  fixtureRemote?: string;
  tempRoot?: string;
  timeoutMs?: number;
  lsRemoteTimeoutMs?: number;
  stagingBytes?: number;
}

export class CatalogGit {
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly options: CatalogGitOptions = {}) {}

  async dispose() {
    this.lifetime.abort();
    await Promise.allSettled(this.operations);
  }

  listTags(): Promise<Map<string, string>> {
    if (this.lifetime.signal.aborted) return Promise.reject(new CatalogError("git_error"));
    const operation = this.runListTags();
    this.operations.add(operation);
    const release = () => { this.operations.delete(operation); };
    void operation.then(release, release);
    return operation;
  }

  private async runListTags(): Promise<Map<string, string>> {
    const controller = new AbortController();
    let cancellation: CatalogError | undefined;
    const cancel = (error: CatalogError) => {
      cancellation ??= error;
      controller.abort();
    };
    const dispose = () => cancel(new CatalogError("git_error"));
    this.lifetime.signal.addEventListener("abort", dispose, { once: true });
    const timer = setTimeout(
      () => cancel(new CatalogError("timeout")),
      this.options.lsRemoteTimeoutMs ?? catalogLimits.lsRemoteTimeoutMs,
    );
    try {
      const output = await runGitProcess(
        this.options.tempRoot ?? tmpdir(),
        ["ls-remote", "--tags", "--", this.options.fixtureRemote ?? catalogRemote],
        catalogLimits.lsRemoteBytes,
        controller.signal,
        this.options,
        true,
        false,
      );
      if (cancellation) throw cancellation;
      return parseLsRemoteTags(output.toString("utf8"));
    } catch (error) {
      throw cancellation ?? error;
    } finally {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", dispose);
    }
  }

  withRevision<T>(ref: string, read: (sha: string, git: GitStaging) => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(new CatalogError("git_error"));
    if (this.operations.size >= catalogLimits.concurrentStaging) {
      return Promise.reject(new CatalogError("limit_exceeded"));
    }
    const operation = this.stage(ref, read);
    this.operations.add(operation);
    const release = () => { this.operations.delete(operation); };
    void operation.then(release, release);
    return operation;
  }

  private async stage<T>(ref: string, read: (sha: string, git: GitStaging) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let cancellation: CatalogError | undefined;
    const cancel = (error: CatalogError) => {
      cancellation ??= error;
      controller.abort();
    };
    const dispose = () => cancel(new CatalogError("git_error"));
    this.lifetime.signal.addEventListener("abort", dispose, { once: true });
    const timer = setTimeout(() => cancel(new CatalogError("timeout")), this.options.timeoutMs ?? catalogLimits.timeoutMs);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), "paseo-catalog-"));
      const git = new GitStaging(directory, controller.signal, this.options);
      const sha = await git.resolve(ref);
      const result = await read(sha, git);
      if (cancellation) throw cancellation;
      return result;
    } catch (error) {
      throw cancellation ?? error;
    } finally {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", dispose);
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 2 });
    }
  }
}

export class GitStaging {
  constructor(
    private readonly directory: string,
    private readonly signal: AbortSignal,
    private readonly options: CatalogGitOptions,
  ) {}

  async resolve(ref: string): Promise<string> {
    const template = join(this.directory, "empty-template");
    await mkdir(template);
    await this.run(["init", "--bare", "--object-format=sha1", "--template=" + template, "."], 4096);

    const isSha = commitShaSchema.safeParse(ref).success;
    const refspec = isSha ? ref : "refs/tags/" + ref + ":" + tagRef;
    await this.run([
      "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-auto-maintenance",
      "--", this.options.fixtureRemote ?? catalogRemote, refspec,
    ], 4096, true);

    const revision = isSha ? "FETCH_HEAD" : tagRef + "^{commit}";
    let sha: string;
    try {
      sha = (await this.run(["rev-parse", "--verify", revision], 128)).toString("ascii").trim();
      if (!commitShaSchema.safeParse(sha).success || (isSha && sha !== ref) ||
          (await this.run(["cat-file", "-t", sha], 128)).toString("ascii").trim() !== "commit") {
        throw new CatalogError("revision_unavailable");
      }
    } catch (error) {
      if (error instanceof CatalogError && error.code === "git_error" && !this.signal.aborted) {
        throw new CatalogError("revision_unavailable");
      }
      throw error;
    }
    return sha;
  }

  listSkills(sha: string) {
    // Include tree entries so the root and each intermediate directory can be validated.
    return this.run(["ls-tree", "-r", "-t", "-l", "-z", sha, "--", "skills"],
      (catalogLimits.entries + 1) * (catalogLimits.pathBytes + 96));
  }

  async readBlob(oid: string, size: number) {
    const bytes = await this.run(["cat-file", "blob", oid], size);
    if (bytes.length !== size) throw new CatalogError("invalid_catalog");
    return bytes;
  }

  private run(args: string[], maxBytes: number, fetching = false): Promise<Buffer> {
    return runGitProcess(this.directory, args, maxBytes, this.signal, this.options, fetching, fetching);
  }
}

export function parseLsRemoteTags(stdout: string): Map<string, string> {
  const direct = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{40})\trefs\/tags\/(.+)$/.exec(line);
    if (!match) continue;
    const [, sha, refName] = match;
    if (refName.endsWith("^{}")) {
      const tag = refName.slice(0, -3);
      if (tag) peeled.set(tag, sha);
    } else {
      direct.set(refName, sha);
    }
  }
  const resolved = new Map<string, string>();
  for (const [tag, sha] of direct) {
    resolved.set(tag, peeled.get(tag) ?? sha);
  }
  return resolved;
}

function runGitProcess(
  cwd: string,
  args: string[],
  maxBytes: number,
  signal: AbortSignal,
  options: CatalogGitOptions,
  fetching: boolean,
  monitorStaging: boolean,
): Promise<Buffer> {
  if (signal.aborted) return Promise.reject(new CatalogError("git_error"));
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "fetch.fsckObjects=true", ...args], {
      cwd,
      env: gitEnvironment(options.fixtureRemote !== undefined),
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      shell: false,
    });
    const stdout: Buffer[] = [];
    let count = 0;
    let stderr = "";
    let failure: unknown;
    let measuring = false;
    let active = true;
    const stop = (error: unknown) => {
      failure ??= error;
      if (!active || !child.pid) return;
      try {
        if (detached) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (killError) {
        if ((killError as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const abort = () => stop(new CatalogError("git_error"));
    signal.addEventListener("abort", abort, { once: true });
    const stagingLimit = options.stagingBytes ?? catalogLimits.stagingBytes;
    const monitor = monitorStaging ? setInterval(async () => {
      if (measuring || !active) return;
      measuring = true;
      try {
        if (await stagingSize(cwd, stagingLimit) > stagingLimit && active) {
          stop(new CatalogError("limit_exceeded"));
        }
      } catch (error) {
        // Git can rename a pack while the size check is walking the staging directory.
        if (active && (error as NodeJS.ErrnoException).code !== "ENOENT") stop(error);
      } finally {
        measuring = false;
      }
    }, 100) : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      count += chunk.length;
      if (count > maxBytes) stop(new CatalogError("limit_exceeded"));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.subarray(0, Math.max(0, 8192 - stderr.length)).toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure ??= new CatalogError(error.code === "ENOENT" ? "git_unavailable" : "host_io_error");
    });
    child.on("close", async (code) => {
      active = false;
      clearInterval(monitor);
      signal.removeEventListener("abort", abort);
      try {
        if (failure) throw failure;
        if (code !== 0) throw gitFailure(stderr, fetching);
        if (monitorStaging && await stagingSize(cwd, stagingLimit) > stagingLimit) {
          throw new CatalogError("limit_exceeded");
        }
        resolve(Buffer.concat(stdout, count));
      } catch (error) {
        reject(error);
      }
    });
  });
}
