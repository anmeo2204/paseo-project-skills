import {
  commitShaSchema,
  type CatalogActiveState,
  type CatalogMovedTag,
  type CatalogRelease,
  type CatalogReleaseRelation,
  type CatalogUpdateStatus,
} from "../shared/catalog";
import { stableSemverTagSchema, type CatalogSettingsValues } from "../shared/catalog-settings";
import { CatalogError } from "./catalog-error";
import type { CatalogGit } from "./catalog-git";
import { catalogLimits } from "./catalog-limits";

export type StableReleaseEntry = { tag: string; commitSha: string };

const semverPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableSemver(tag: string): readonly [number, number, number] | null {
  const match = semverPattern.exec(tag);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareStableSemver(a: string, b: string): number {
  const parsedA = parseStableSemver(a);
  const parsedB = parseStableSemver(b);
  if (!parsedA || !parsedB) throw new Error(`Invalid stable SemVer comparison: ${a} vs ${b}`);
  if (parsedA[0] !== parsedB[0]) return parsedA[0] - parsedB[0];
  if (parsedA[1] !== parsedB[1]) return parsedA[1] - parsedB[1];
  return parsedA[2] - parsedB[2];
}

export function extractStableReleases(tags: ReadonlyMap<string, string>): StableReleaseEntry[] {
  const releases: StableReleaseEntry[] = [];
  for (const [tag, sha] of tags) {
    if (!stableSemverTagSchema.safeParse(tag).success) continue;
    const normalizedSha = sha.toLowerCase();
    if (!commitShaSchema.safeParse(normalizedSha).success) continue;
    releases.push({ tag, commitSha: normalizedSha });
  }
  releases.sort((a, b) => compareStableSemver(b.tag, a.tag));
  return releases.slice(0, catalogLimits.maxReleases);
}

export function classifyCatalogUpdates(
  tags: ReadonlyMap<string, string>,
  stableReleases: ReadonlyArray<StableReleaseEntry>,
  settingsValues: CatalogSettingsValues,
): {
  active: CatalogActiveState;
  releases: CatalogRelease[];
  latestStable: StableReleaseEntry | null;
  updateStatus: CatalogUpdateStatus;
  updateAvailable: boolean;
  movedTag?: CatalogMovedTag;
} {
  const rawRef = settingsValues.catalogRef;
  const normalizedRef = rawRef.toLowerCase();
  const isPinnedSha = commitShaSchema.safeParse(normalizedRef).success;
  const active: CatalogActiveState = {
    catalogRef: rawRef,
    ...(settingsValues.selectionMode !== undefined ? { selectionMode: settingsValues.selectionMode } : {}),
    ...(settingsValues.selectedTag !== undefined ? { selectedTag: settingsValues.selectedTag } : {}),
    isPinnedSha,
  };
  const latestStable = stableReleases[0] ?? null;
  const isManagedRelease = isPinnedSha &&
    (settingsValues.selectionMode === "latest_stable" || settingsValues.selectionMode === "specific_version") &&
    settingsValues.selectedTag !== undefined &&
    parseStableSemver(settingsValues.selectedTag) !== null;

  let updateStatus: CatalogUpdateStatus;
  let updateAvailable = false;
  let movedTag: CatalogMovedTag | undefined;

  if (isManagedRelease && settingsValues.selectedTag) {
    const remoteSha = tags.get(settingsValues.selectedTag)?.toLowerCase() ?? null;
    if (remoteSha === null || remoteSha !== normalizedRef) {
      updateStatus = "moved_tag";
      movedTag = {
        tag: settingsValues.selectedTag,
        pinnedCommitSha: normalizedRef,
        remoteCommitSha: remoteSha && commitShaSchema.safeParse(remoteSha).success ? remoteSha : null,
      };
    } else if (!latestStable) {
      updateStatus = "no_stable_releases";
    } else {
      const comparison = compareStableSemver(latestStable.tag, settingsValues.selectedTag);
      if (comparison > 0) {
        updateStatus = "update_available";
        updateAvailable = true;
      } else if (comparison === 0) {
        updateStatus = "up_to_date";
      } else {
        updateStatus = "newer_than_latest";
      }
    }
  } else if (!latestStable) {
    updateStatus = "no_stable_releases";
  } else if (rawRef === "") {
    updateStatus = "unconfigured";
  } else if (!isPinnedSha) {
    updateStatus = "legacy_unpinned";
  } else {
    updateStatus = "custom_revision";
  }

  const releases: CatalogRelease[] = stableReleases.map((entry) => {
    let relation: CatalogReleaseRelation = "uncompared";
    if (isPinnedSha) {
      if (isManagedRelease && settingsValues.selectedTag) {
        if (entry.tag === settingsValues.selectedTag) {
          relation = entry.commitSha === normalizedRef ? "active" : "uncompared";
        } else {
          const cmp = compareStableSemver(entry.tag, settingsValues.selectedTag);
          relation = cmp > 0 ? "newer" : "older";
        }
      } else if (entry.commitSha === normalizedRef) {
        relation = "same_commit";
      }
    }
    return { tag: entry.tag, commitSha: entry.commitSha, relation };
  });

  return {
    active,
    releases,
    latestStable,
    updateStatus,
    updateAvailable,
    ...(movedTag ? { movedTag } : {}),
  };
}

export interface ReleaseCacheEntry {
  tags: ReadonlyMap<string, string>;
  stableReleases: ReadonlyArray<StableReleaseEntry>;
  checkedAt: number;
  cached: boolean;
}

export interface CatalogReleaseCacheOptions {
  now?: () => number;
  wallNow?: () => number;
  ttlMs?: number;
  refreshCooldownMs?: number;
}

export class CatalogReleaseCache {
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly ttlMs: number;
  private readonly refreshCooldownMs: number;
  private cachedEntry: {
    tags: Map<string, string>;
    stableReleases: StableReleaseEntry[];
    fetchedMono: number;
    checkedAt: number;
  } | null = null;
  private inflight: Promise<{
    tags: Map<string, string>;
    stableReleases: StableReleaseEntry[];
    fetchedMono: number;
    checkedAt: number;
  }> | null = null;
  private disposed = false;

  constructor(
    private readonly git: Pick<CatalogGit, "listTags">,
    options: CatalogReleaseCacheOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.ttlMs = options.ttlMs ?? catalogLimits.releaseCacheTtlMs;
    this.refreshCooldownMs = options.refreshCooldownMs ?? catalogLimits.releaseRefreshCooldownMs;
  }

  dispose() {
    this.disposed = true;
    this.cachedEntry = null;
    this.inflight = null;
  }

  async get(options: { refresh?: boolean; bypassCooldown?: boolean } = {}): Promise<ReleaseCacheEntry> {
    if (this.disposed) throw new CatalogError("git_error");
    const currentMono = this.now();
    if (this.cachedEntry) {
      const age = currentMono - this.cachedEntry.fetchedMono;
      const withinTtl = age < this.ttlMs;
      const withinCooldown = !options.bypassCooldown && age < this.refreshCooldownMs;
      if ((!options.refresh && withinTtl) || (options.refresh && withinCooldown)) {
        return {
          tags: new Map(this.cachedEntry.tags),
          stableReleases: this.cachedEntry.stableReleases.map((item) => ({ ...item })),
          checkedAt: this.cachedEntry.checkedAt,
          cached: true,
        };
      }
    }

    if (!this.inflight) {
      const run = (async () => {
        const tags = await this.git.listTags();
        if (this.disposed) throw new CatalogError("git_error");
        const stableReleases = extractStableReleases(tags);
        const entry = {
          tags,
          stableReleases,
          fetchedMono: this.now(),
          checkedAt: this.wallNow(),
        };
        this.cachedEntry = entry;
        return entry;
      })();
      this.inflight = run;
      const clear = () => {
        if (this.inflight === run) this.inflight = null;
      };
      void run.then(clear, clear);
    }

    const fresh = await this.inflight;
    if (this.disposed) throw new CatalogError("git_error");
    return {
      tags: new Map(fresh.tags),
      stableReleases: fresh.stableReleases.map((item) => ({ ...item })),
      checkedAt: fresh.checkedAt,
      cached: false,
    };
  }
}
