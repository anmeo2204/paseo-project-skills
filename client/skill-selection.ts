import type { CatalogSnapshotDescriptor } from "../shared/catalog";
import type { RecommendationItem } from "../shared/recommendation";

export type SkillGroupBy = "applicability" | "boundary" | "inventory";
export type ApplicabilityFilter = "all" | "recommended" | "optional" | "unknown";
export type SelectionFilter = "all" | "selected" | "unselected";
export type InventoryFilter = "all" | "observed" | "not_observed" | "needs_review";

export type SkillViewFilter = {
  search: string;
  applicability: ApplicabilityFilter;
  selection: SelectionFilter;
  inventory: InventoryFilter;
  groupBy: SkillGroupBy;
  showUnknown: boolean;
};

export type SkillGroup = {
  key: string;
  title: string;
  collapsible: boolean;
  expanded: boolean;
  autoRevealed: boolean;
  items: RecommendationItem[];
};

export type SelectionSummary = {
  totalSelected: number;
  recommendedSelected: number;
  optionalSelected: number;
  unknownSelected: number;
  observedSelected: number;
  hiddenSelected: number;
  additionalRecommendedCount: number;
};

const compareId = (a: RecommendationItem, b: RecommendationItem) =>
  a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0;

export function isSkillObserved(item: RecommendationItem): boolean {
  return item.inventory.state === "present" || item.inventory.state === "multiple_occurrences";
}

export function skillNeedsInventoryReview(item: RecommendationItem): boolean {
  return (
    item.inventory.state === "multiple_occurrences" ||
    item.inventory.state === "unknown" ||
    item.inventory.occurrences.some((entry) => entry.flags.length > 0)
  );
}

export function hasActiveFilters(filter: Pick<SkillViewFilter, "search" | "applicability" | "selection" | "inventory">): boolean {
  return (
    filter.search.trim().length > 0 ||
    filter.applicability !== "all" ||
    filter.selection !== "all" ||
    filter.inventory !== "all"
  );
}

function matchesSearch(
  item: RecommendationItem,
  normalizedQuery: string,
  metaMap: ReadonlyMap<string, { name: string; description: string }>,
): boolean {
  if (!normalizedQuery) return true;
  if (item.skillId.toLowerCase().includes(normalizedQuery)) return true;
  const meta = metaMap.get(item.skillId);
  if (!meta) return false;
  return (
    meta.name.toLowerCase().includes(normalizedQuery) ||
    meta.description.toLowerCase().includes(normalizedQuery)
  );
}

function matchesFilters(
  item: RecommendationItem,
  filter: SkillViewFilter,
  normalizedQuery: string,
  selectedSet: ReadonlySet<string>,
  metaMap: ReadonlyMap<string, { name: string; description: string }>,
): boolean {
  if (!matchesSearch(item, normalizedQuery, metaMap)) return false;
  if (filter.applicability !== "all" && item.applicability !== filter.applicability) return false;
  if (filter.selection === "selected" && !selectedSet.has(item.skillId)) return false;
  if (filter.selection === "unselected" && selectedSet.has(item.skillId)) return false;
  if (filter.inventory === "observed" && !isSkillObserved(item)) return false;
  if (filter.inventory === "not_observed" && item.inventory.state !== "not_observed") return false;
  if (filter.inventory === "needs_review" && !skillNeedsInventoryReview(item)) return false;
  return true;
}

function primaryBoundaryGroup(item: RecommendationItem): { key: string; title: string } {
  if (item.matches.length === 0) {
    return { key: "boundary:unmatched", title: "No boundary match" };
  }
  const hasProjectWide = item.matches.some(
    (match) => match.boundaryPath === "." && match.reasons.some((reason) => reason.code === "reusable_workflow"),
  );
  if (hasProjectWide) {
    return { key: "boundary:project-wide", title: "Project-wide" };
  }
  const paths = [...new Set(item.matches.map((match) => match.boundaryPath))].sort();
  const primary = paths[0];
  return {
    key: `boundary:path:${primary}`,
    title: primary === "." ? "Project root" : primary,
  };
}

export function filterAndGroupSkills(
  items: readonly RecommendationItem[],
  catalog: Pick<CatalogSnapshotDescriptor, "skills">,
  selected: readonly string[],
  filter: SkillViewFilter,
): {
  filteredCount: number;
  groups: SkillGroup[];
  summary: SelectionSummary;
} {
  const metaMap = new Map(catalog.skills.map(({ id, metadata }) => [id, metadata]));
  const selectedSet = new Set(selected);
  const normalizedQuery = filter.search.trim().toLowerCase();
  const filtered = items
    .filter((item) => matchesFilters(item, filter, normalizedQuery, selectedSet, metaMap))
    .sort(compareId);

  // D3: Auto-reveal matching Unknown skills during search or relevant filtering without mutating showUnknown.
  const autoRevealUnknown = Boolean(
    normalizedQuery.length > 0 ||
    filter.applicability === "unknown" ||
    filter.selection === "selected" ||
    filter.inventory !== "all",
  );

  let groups: SkillGroup[] = [];

  if (filter.groupBy === "applicability") {
    const tiers = [
      ["recommended", "Recommended"],
      ["optional", "Optional"],
      ["unknown", "Unknown"],
    ] as const;
    groups = tiers.map(([verdict, title]) => {
      const groupItems = filtered.filter((item) => item.applicability === verdict);
      const isUnknown = verdict === "unknown";
      const autoRevealed = isUnknown && !filter.showUnknown && autoRevealUnknown && groupItems.length > 0;
      const expanded = !isUnknown || filter.showUnknown || autoRevealed;
      return {
        key: verdict,
        title,
        collapsible: isUnknown,
        expanded,
        autoRevealed,
        items: groupItems,
      };
    });
  } else if (filter.groupBy === "boundary") {
    const buckets = new Map<string, { title: string; items: RecommendationItem[] }>();
    for (const item of filtered) {
      const { key, title } = primaryBoundaryGroup(item);
      const bucket = buckets.get(key) ?? { title, items: [] };
      bucket.items.push(item);
      buckets.set(key, bucket);
    }
    const orderedKeys = [...buckets.keys()].sort((a, b) => {
      if (a === "boundary:project-wide") return -1;
      if (b === "boundary:project-wide") return 1;
      if (a === "boundary:unmatched") return 1;
      if (b === "boundary:unmatched") return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    groups = orderedKeys.map((key) => {
      const bucket = buckets.get(key)!;
      return {
        key,
        title: bucket.title,
        collapsible: false,
        expanded: true,
        autoRevealed: false,
        items: bucket.items,
      };
    });
  } else {
    const inventoryBuckets: Array<{ key: string; title: string; items: RecommendationItem[] }> = [
      { key: "inventory:observed", title: "Observed in project", items: [] },
      { key: "inventory:not_observed", title: "Not observed", items: [] },
      { key: "inventory:unknown", title: "File state unverified", items: [] },
    ];
    for (const item of filtered) {
      if (isSkillObserved(item)) inventoryBuckets[0].items.push(item);
      else if (item.inventory.state === "not_observed") inventoryBuckets[1].items.push(item);
      else inventoryBuckets[2].items.push(item);
    }
    groups = inventoryBuckets
      .filter((bucket) => bucket.items.length > 0)
      .map((bucket) => ({
        key: bucket.key,
        title: bucket.title,
        collapsible: false,
        expanded: true,
        autoRevealed: false,
        items: bucket.items,
      }));
  }

  // P2: Count selected skills hidden by search, filters, or collapsed groups.
  const visibleSkillIds = new Set<string>();
  for (const group of groups) {
    if (!group.expanded) continue;
    for (const item of group.items) visibleSkillIds.add(item.skillId);
  }

  let recommendedSelected = 0;
  let optionalSelected = 0;
  let unknownSelected = 0;
  let observedSelected = 0;
  let additionalRecommendedCount = 0;

  for (const item of items) {
    const isSel = selectedSet.has(item.skillId);
    if (item.applicability === "recommended" && !isSel) additionalRecommendedCount++;
    if (!isSel) continue;
    if (item.applicability === "recommended") recommendedSelected++;
    else if (item.applicability === "optional") optionalSelected++;
    else unknownSelected++;
    if (isSkillObserved(item)) observedSelected++;
  }

  const hiddenSelected = selected.filter((id) => !visibleSkillIds.has(id)).length;

  return {
    filteredCount: filtered.length,
    groups,
    summary: {
      totalSelected: selected.length,
      recommendedSelected,
      optionalSelected,
      unknownSelected,
      observedSelected,
      hiddenSelected,
      additionalRecommendedCount,
    },
  };
}
