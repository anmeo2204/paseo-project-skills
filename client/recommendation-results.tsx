import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { CatalogSnapshotDescriptor } from "../shared/catalog";
import type { EvidenceRef } from "../shared/project-evidence";
import type { RecommendationEvent, RecommendationItem, RecommendationReason } from "../shared/recommendation";
import { Action, Detail, Disclosure, Input, Section } from "./controls";
import type { ProviderId } from "./provider-selection";
import {
  filterAndGroupSkills,
  hasActiveFilters,
  type ApplicabilityFilter,
  type InventoryFilter,
  type SelectionFilter,
  type SkillGroupBy,
} from "./skill-selection";

type Result = Extract<RecommendationEvent, { result: unknown }>["result"];

const reasons: Record<RecommendationReason["code"], string> = {
  reusable_workflow: "Reusable workflow for the project.",
  strong_project_match: "Project evidence meets the recommendation rule.",
  project_match: "The rule matches this project as an optional skill.",
  additional_evidence_unobserved: "Project fit found. Evidence for a stronger recommendation was not observed.",
  partial_evidence: "The scan did not collect enough evidence to assess project fit.",
  no_supported_evidence: "The scan found no evidence matching this rule.",
  missing_applicability: "This catalog revision has no applicability rule for the skill.",
  invalid_applicability: "The applicability rule could not be validated.",
  unsupported_rule_version: "The applicability rule version is unsupported.",
};

// D2: Explicit observed-file labels (never implying provider activation or installation success).
const inventoryLabels = {
  present: "Observed in project",
  multiple_occurrences: "Multiple copies observed",
  not_observed: "Not observed",
  unknown: "File state unverified",
};

const applicabilityLabels: Record<RecommendationItem["applicability"], string> = {
  recommended: "Recommended",
  optional: "Optional",
  unknown: "Unknown",
  not_applicable: "Not applicable",
};

const providerDisplayNames: Record<ProviderId, string> = {
  codex: "Codex",
  cursor: "Cursor",
  kiro: "Kiro",
  antigravity: "Antigravity",
};

const flags = {
  metadata_mismatch: "Metadata mismatch",
  malformed: "Malformed metadata",
  unreadable: "Unreadable metadata",
  possible_customization: "Possible customization",
};

const warnings = {
  malformed_manifest: "A project manifest could not be read as valid metadata.",
  malformed_skill: "An existing skill has malformed or mismatched metadata.",
  duplicate_skill_id: "More than one occurrence of a skill was observed.",
  permission_denied: "Permission was denied while reading the project.",
  unreadable: "Part of the project could not be read.",
  unsafe_entry: "The scanner skipped an unsafe entry.",
  entry_changed: "An entry changed during the scan.",
  unsupported_workspace_pattern: "A workspace pattern is unsupported.",
  missing_member: "A declared workspace member was not found.",
  manager_conflict: "Package manager indicators disagree.",
  max_depth: "The scan reached its directory depth limit.",
  directory_budget: "The scan reached its directory limit.",
  entry_budget: "The scan reached its entry limit.",
  boundary_budget: "The scan reached its application boundary limit.",
  file_budget: "The scan reached its file count limit.",
  file_size: "A file exceeded the scan size limit.",
  byte_budget: "The scan reached its total read limit.",
  response_budget: "Evidence exceeded the supported response size.",
  deadline: "The scan reached its time limit.",
};

const displayBoundary = (path: string) => (path === "." ? "Project root" : path);

function FilterPill({
  theme,
  label,
  active,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        minHeight: 36,
        justifyContent: "center",
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
      }}
    >
      <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

export function RecommendationResults({
  theme,
  result,
  partial,
  catalog,
  selected,
  providers = [],
  compact = false,
  onToggle,
  onSelectRecommended,
  onClear,
}: {
  theme: PluginTheme;
  result: Result;
  partial: boolean;
  catalog: CatalogSnapshotDescriptor;
  selected: readonly string[];
  providers?: readonly ProviderId[];
  compact?: boolean;
  onToggle: (id: string) => void;
  onSelectRecommended: () => void;
  onClear: () => void;
}) {
  const [showUnknown, setShowUnknown] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const [search, setSearch] = useState("");
  const [applicabilityFilter, setApplicabilityFilter] = useState<ApplicabilityFilter>("all");
  const [selectionFilter, setSelectionFilter] = useState<SelectionFilter>("all");
  const [inventoryFilter, setInventoryFilter] = useState<InventoryFilter>("all");
  const [groupBy, setGroupBy] = useState<SkillGroupBy>("applicability");

  const descriptions = new Map(catalog.skills.map(({ id, metadata }) => [id, metadata.description]));
  const refs = new Map(result.evidence.map((ref) => [ref.id, ref]));
  const hasPositive = result.items.some((item) => item.applicability !== "unknown");
  const hasMetadataWarnings = result.metadataCoverage.invalid > 0;
  const hasAnyObserved = result.items.some((item) => item.inventory.state !== "not_observed");

  const viewFilter = {
    search,
    applicability: applicabilityFilter,
    selection: selectionFilter,
    inventory: inventoryFilter,
    groupBy,
    showUnknown,
  };
  const activeFilters = hasActiveFilters(viewFilter);
  const { filteredCount, groups, summary } = filterAndGroupSkills(result.items, catalog, selected, viewFilter);

  function resetFilters() {
    setSearch("");
    setApplicabilityFilter("all");
    setSelectionFilter("all");
    setInventoryFilter("all");
  }

  // P2: Show Selected resets conflicting filters and reveals all selected skills (including Unknown).
  function showAllSelected() {
    setSearch("");
    setApplicabilityFilter("all");
    setInventoryFilter("all");
    setSelectionFilter("selected");
  }

  const selectRecommendedLabel = summary.additionalRecommendedCount > 0
    ? `Select Recommended (+${summary.additionalRecommendedCount})`
    : "Select Recommended";
  const providerListText = providers.length > 0
    ? providers.map((id) => providerDisplayNames[id]).join(", ")
    : "none (canonical .agents/skills only)";

  return (
    <Section theme={theme} title="Recommendation Results">
      <Text selectable style={{ color: theme.colors.foreground }}>Target: {result.target.canonicalDirectory}</Text>
      <Text selectable style={{ color: theme.colors.foregroundMuted }}>Catalog: {result.catalog.commitSha}</Text>
      <Detail theme={theme}>Recommendations describe project fit. Task applicability has not been assessed.</Detail>
      {hasAnyObserved && (
        <Detail theme={theme}>
          Observed status reflects files found during the read-only scan only. It does not confirm provider discovery, activation, or precedence, and Safe Apply never overwrites existing files.
        </Detail>
      )}
      {partial && <Detail theme={theme} error>Partial results. Review the scan and catalog details below.</Detail>}
      {result.scanCoverage.status === "partial" && (
        <Detail theme={theme}>Some project evidence could not be checked. Available matches are shown below.</Detail>
      )}
      {hasMetadataWarnings && <Detail theme={theme}>Some catalog applicability rules were invalid or unsupported.</Detail>}
      {result.metadataCoverage.missing > 0 && (
        <Detail theme={theme}>{result.metadataCoverage.missing} skills have no applicability rule in this catalog revision.</Detail>
      )}
      {(result.warnings.length > 0 || result.scanCoverage.limits.length > 0 || hasMetadataWarnings) && (
        <>
          <Disclosure theme={theme} label="Scan and catalog details" expanded={showWarnings} onPress={() => setShowWarnings(!showWarnings)} />
          {showWarnings && (
            <View style={{ gap: 4 }}>
              {result.warnings.map(({ code, relativePath }, index) => (
                <Detail key={index} theme={theme}>
                  {warnings[code]}{relativePath ? ` ${relativePath}` : ""}
                </Detail>
              ))}
              {result.scanCoverage.limits
                .filter((code) => !result.warnings.some((warning) => warning.code === code))
                .map((code) => <Detail key={code} theme={theme}>{warnings[code]}</Detail>)}
              {result.diagnostics
                .filter(({ code }) => code !== "missing_applicability")
                .map(({ skillId, code }) => <Detail key={skillId} theme={theme}>{skillId} · {reasons[code]}</Detail>)}
            </View>
          )}
        </>
      )}
      {!hasPositive && <Detail theme={theme}>No positive matches. Open Unknown to review and select skills manually.</Detail>}

      {/* Search & filter controls (view-only: never mutate selection or invalidate Preview) */}
      <View style={{ gap: 8 }}>
        <View style={{ gap: 6 }}>
          <Input
            theme={theme}
            accessibilityLabel="Search skills"
            placeholder="Search by skill name, ID, or description…"
            value={search}
            onChangeText={setSearch}
          />
          {search.length > 0 && <Action theme={theme} label="Clear search" onPress={() => setSearch("")} />}
        </View>

        <View style={{ gap: 6 }}>
          <Detail theme={theme}>Filter by applicability</Detail>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <FilterPill theme={theme} label="All" active={applicabilityFilter === "all"} onPress={() => setApplicabilityFilter("all")} />
            <FilterPill theme={theme} label="Recommended" active={applicabilityFilter === "recommended"} onPress={() => setApplicabilityFilter("recommended")} />
            <FilterPill theme={theme} label="Optional" active={applicabilityFilter === "optional"} onPress={() => setApplicabilityFilter("optional")} />
            <FilterPill theme={theme} label="Unknown" active={applicabilityFilter === "unknown"} onPress={() => setApplicabilityFilter("unknown")} />
          </View>
        </View>

        <View style={{ gap: 6 }}>
          <Detail theme={theme}>Filter by selection & observed files</Detail>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <FilterPill theme={theme} label="Any selection" active={selectionFilter === "all"} onPress={() => setSelectionFilter("all")} />
            <FilterPill theme={theme} label="Selected" active={selectionFilter === "selected"} onPress={() => setSelectionFilter("selected")} />
            <FilterPill theme={theme} label="Unselected" active={selectionFilter === "unselected"} onPress={() => setSelectionFilter("unselected")} />
            <FilterPill theme={theme} label="Any files" active={inventoryFilter === "all"} onPress={() => setInventoryFilter("all")} />
            <FilterPill theme={theme} label="Observed" active={inventoryFilter === "observed"} onPress={() => setInventoryFilter("observed")} />
            <FilterPill theme={theme} label="Not observed" active={inventoryFilter === "not_observed"} onPress={() => setInventoryFilter("not_observed")} />
            <FilterPill theme={theme} label="Needs review" active={inventoryFilter === "needs_review"} onPress={() => setInventoryFilter("needs_review")} />
          </View>
        </View>

        <View style={{ gap: 6 }}>
          <Detail theme={theme}>Group skills</Detail>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <FilterPill theme={theme} label="By Applicability" active={groupBy === "applicability"} onPress={() => setGroupBy("applicability")} />
            <FilterPill theme={theme} label="By Boundary" active={groupBy === "boundary"} onPress={() => setGroupBy("boundary")} />
            <FilterPill theme={theme} label="By Observed Status" active={groupBy === "inventory"} onPress={() => setGroupBy("inventory")} />
          </View>
        </View>

        {activeFilters && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <Detail theme={theme}>Showing {filteredCount} of {result.items.length} skills</Detail>
            <Action theme={theme} label="Reset filters" onPress={resetFilters} />
          </View>
        )}
      </View>

      {/* P1: Bulk actions operate on complete scan result */}
      <View accessibilityLiveRegion="polite"><Detail theme={theme}>Selected skills: {selected.length}</Detail></View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Select Recommended"
          accessibilityState={{ disabled: summary.additionalRecommendedCount === 0 }}
          disabled={summary.additionalRecommendedCount === 0}
          onPress={onSelectRecommended}
          style={{
            alignSelf: "flex-start",
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
            opacity: summary.additionalRecommendedCount === 0 ? 0.55 : 1,
          }}
        >
          <Text style={{ color: theme.colors.foreground }}>{selectRecommendedLabel}</Text>
        </Pressable>
        <Action theme={theme} label="Clear Selection" disabled={selected.length === 0} onPress={onClear} />
      </View>

      {/* Skill groups */}
      {filteredCount === 0 && activeFilters ? (
        <View style={{ gap: 6 }}>
          <Detail theme={theme}>No skills match the current search and filters.</Detail>
          <Action theme={theme} label="Reset filters" onPress={resetFilters} />
        </View>
      ) : (
        groups.map((group) => {
          const heading = `${group.title} (${group.items.length})`;
          return (
            <View key={group.key} style={{ gap: 6 }}>
              {group.collapsible ? (
                <Disclosure
                  theme={theme}
                  label={heading}
                  expanded={group.expanded}
                  onPress={() => setShowUnknown(!showUnknown)}
                />
              ) : (
                <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>
                  {heading}
                </Text>
              )}
              {group.autoRevealed && (
                <Detail theme={theme}>Showing matching Unknown skills for active search/filters.</Detail>
              )}
              {group.expanded && group.items.map((item) => (
                <SkillRow
                  key={item.skillId}
                  theme={theme}
                  item={item}
                  description={descriptions.get(item.skillId)}
                  refs={refs}
                  compact={compact}
                  checked={selected.includes(item.skillId)}
                  onToggle={() => onToggle(item.skillId)}
                />
              ))}
            </View>
          );
        })
      )}

      {/* P2: Compact selection summary before Preview */}
      <View
        style={{
          gap: 4,
          padding: 10,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
        }}
      >
        <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>
          Selection Summary
        </Text>
        <Detail theme={theme}>
          Selected: {summary.totalSelected} ({summary.recommendedSelected} recommended · {summary.optionalSelected} optional · {summary.unknownSelected} unknown)
        </Detail>
        <Detail theme={theme}>Target providers: {providerListText}</Detail>
        {summary.observedSelected > 0 && (
          <Detail theme={theme}>
            {summary.observedSelected} selected {summary.observedSelected === 1 ? "skill has" : "skills have"} existing files observed (Preview will check unchanged vs conflict).
          </Detail>
        )}
        {summary.hiddenSelected > 0 && (
          <View style={{ gap: 6 }}>
            <Detail theme={theme}>
              {summary.hiddenSelected} selected {summary.hiddenSelected === 1 ? "skill is" : "skills are"} hidden by current filters or collapsed groups.
            </Detail>
            <Action theme={theme} label="Show Selected" onPress={showAllSelected} />
          </View>
        )}
        <Detail theme={theme}>Selection records intent only. Review Preview Changes before approving any file creation.</Detail>
      </View>
    </Section>
  );
}

function SkillRow({
  theme,
  item,
  description,
  refs,
  compact,
  checked,
  onToggle,
}: {
  theme: PluginTheme;
  item: RecommendationItem;
  description: string | undefined;
  refs: ReadonlyMap<string, EvidenceRef>;
  compact: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = item.reasons[0] ?? item.matches.find(({ verdict }) => verdict === item.applicability)?.reasons[0];
  const occurrenceFlags = [...new Set(item.inventory.occurrences.flatMap((entry) => entry.flags))];
  const applicabilityLabel = applicabilityLabels[item.applicability];
  const shortDescription = compact && description && description.length > 140
    ? `${description.slice(0, 137)}…`
    : description;

  return (
    <View style={{ gap: 4, padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2 }}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`Select ${item.skillId}`}
        aria-checked={checked}
        accessibilityState={{ checked }}
        onPress={onToggle}
        style={{ flexDirection: "row", alignItems: "center", minHeight: 36, gap: 8 }}
      >
        <Icon
          name={checked ? "SquareCheck" : "Square"}
          size={16}
          color={checked ? theme.colors.accent : theme.colors.foregroundMuted}
        />
        <Text style={{ color: theme.colors.foreground, flex: 1, fontWeight: "600" }}>{item.skillId}</Text>
      </Pressable>
      {shortDescription && <Detail theme={theme}>{shortDescription}</Detail>}
      <Detail theme={theme}>
        {applicabilityLabel} · {inventoryLabels[item.inventory.state]}
        {item.matches.length > 0 ? ` · Matching boundaries: ${item.matches.length}` : ""}
      </Detail>
      {occurrenceFlags.length > 0 && <Detail theme={theme}>{occurrenceFlags.map((flag) => flags[flag]).join(" · ")}</Detail>}
      {summary && <Detail theme={theme}>{reasons[summary.code]}</Detail>}
      <Disclosure theme={theme} label={`Details for ${item.skillId}`} expanded={expanded} onPress={() => setExpanded(!expanded)} />
      {expanded && (
        <View style={{ gap: 8 }}>
          {compact && description && description.length > 140 && <Detail theme={theme}>{description}</Detail>}
          {item.reasons.map((reason) => <ReasonDetails key={reason.code} theme={theme} reason={reason} refs={refs} />)}
          {item.matches.map((match) => (
            <View key={match.boundaryPath} style={{ gap: 3 }}>
              <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
                {displayBoundary(match.boundaryPath)} · {match.verdict === "recommended" ? "Recommended" : "Optional"}
              </Text>
              {match.reasons.map((reason) => <ReasonDetails key={reason.code} theme={theme} reason={reason} refs={refs} />)}
            </View>
          ))}
          {item.inventory.occurrences.length > 0 && (
            <View style={{ gap: 6 }}>
              <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>
                Existing skill inventory
              </Text>
              {item.inventory.occurrences.map((entry) => (
                <View key={`${entry.layout}:${entry.relativePath}`} style={{ gap: 3 }}>
                  <Text selectable style={{ color: theme.colors.foreground }}>{entry.relativePath}</Text>
                  <Detail theme={theme}>
                    {entry.layout} · {displayBoundary(entry.boundaryPath)} · {entry.match === "confirmed" ? "Confirmed" : "Candidate"}
                  </Detail>
                  {entry.directoryId !== entry.declaredId && (
                    <Detail theme={theme}>
                      Directory ID: {entry.directoryId ?? "Unknown"} · Declared ID: {entry.declaredId ?? "Unknown"}
                    </Detail>
                  )}
                  {entry.flags.map((flag) => <Detail key={flag} theme={theme}>{flags[flag]}</Detail>)}
                  {entry.evidenceIds.map((id) => refs.has(id) && <EvidenceLine key={id} theme={theme} refValue={refs.get(id)!} />)}
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function ReasonDetails({
  theme,
  reason,
  refs,
}: {
  theme: PluginTheme;
  reason: RecommendationReason;
  refs: ReadonlyMap<string, EvidenceRef>;
}) {
  return (
    <View style={{ gap: 3 }}>
      <Detail theme={theme}>{reasons[reason.code]}</Detail>
      {reason.refs.map((ref, index) => {
        if (ref.kind === "project_evidence") {
          const value = refs.get(ref.evidenceId);
          return value && <EvidenceLine key={index} theme={theme} refValue={value} />;
        }
        if (ref.kind === "catalog_file") {
          return (
            <Text key={index} selectable style={{ color: theme.colors.foregroundMuted }}>
              Catalog rule: {ref.path} · {ref.blobSha}
            </Text>
          );
        }
        return <Detail key={index} theme={theme}>See scan coverage above.</Detail>;
      })}
    </View>
  );
}

function EvidenceLine({ theme, refValue }: { theme: PluginTheme; refValue: EvidenceRef }) {
  return (
    <Text selectable style={{ color: theme.colors.foregroundMuted }}>
      {refValue.relativePath} · {refValue.kind}{refValue.selector ? ` · ${refValue.selector}` : ""}
    </Text>
  );
}
