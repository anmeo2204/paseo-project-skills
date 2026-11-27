import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { CatalogSnapshotDescriptor } from "../shared/catalog";
import type { EvidenceRef } from "../shared/project-evidence";
import type { RecommendationEvent, RecommendationItem, RecommendationReason } from "../shared/recommendation";
import { Action, Detail, Section } from "./controls";

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
const inventory = {
  present: "Present",
  multiple_occurrences: "Multiple occurrences",
  not_observed: "Not observed in scan",
  unknown: "Installation state unknown",
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
const groups = [["recommended", "Recommended"], ["optional", "Optional"], ["unknown", "Unknown"]] as const;
const displayBoundary = (path: string) => path === "." ? "Project root" : path;

export function RecommendationResults({ theme, result, partial, catalog, selected, onToggle, onSelectRecommended, onClear }: {
  theme: PluginTheme;
  result: Result;
  partial: boolean;
  catalog: CatalogSnapshotDescriptor;
  selected: readonly string[];
  onToggle: (id: string) => void;
  onSelectRecommended: () => void;
  onClear: () => void;
}) {
  const [showUnknown, setShowUnknown] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const descriptions = new Map(catalog.skills.map(({ id, metadata }) => [id, metadata.description]));
  const refs = new Map(result.evidence.map((ref) => [ref.id, ref]));
  const recommended = result.items.filter((item) => item.applicability === "recommended");
  const hasPositive = result.items.some((item) => item.applicability !== "unknown");
  const hasMetadataWarnings = result.metadataCoverage.invalid > 0;

  return (
    <Section theme={theme} title="Recommendation Results">
      <Text selectable style={{ color: theme.colors.foreground }}>Target: {result.target.canonicalDirectory}</Text>
      <Text selectable style={{ color: theme.colors.foregroundMuted }}>Catalog: {result.catalog.commitSha}</Text>
      <Detail theme={theme}>Recommendations describe project fit. Task applicability has not been assessed.</Detail>
      {partial && <Detail theme={theme} error>Partial results. Review the scan and catalog details below.</Detail>}
      {result.scanCoverage.status === "partial" &&
        <Detail theme={theme}>Some project evidence could not be checked. Available matches are shown below.</Detail>}
      {hasMetadataWarnings && <Detail theme={theme}>Some catalog applicability rules were invalid or unsupported.</Detail>}
      {result.metadataCoverage.missing > 0 &&
        <Detail theme={theme}>{result.metadataCoverage.missing} skills have no applicability rule in this catalog revision.</Detail>}
      {(result.warnings.length > 0 || result.scanCoverage.limits.length > 0 || hasMetadataWarnings) && <>
        <Disclosure theme={theme} label="Scan and catalog details" expanded={showWarnings} onPress={() => setShowWarnings(!showWarnings)} />
        {showWarnings && <View style={{ gap: 4 }}>
          {result.warnings.map(({ code, relativePath }, index) => <Detail key={index} theme={theme}>
            {warnings[code]}{relativePath ? ` ${relativePath}` : ""}
          </Detail>)}
          {result.scanCoverage.limits.filter((code) => !result.warnings.some((warning) => warning.code === code))
            .map((code) => <Detail key={code} theme={theme}>{warnings[code]}</Detail>)}
          {result.diagnostics.filter(({ code }) => code !== "missing_applicability")
            .map(({ skillId, code }) => <Detail key={skillId} theme={theme}>{skillId} · {reasons[code]}</Detail>)}
        </View>}
      </>}
      {!hasPositive && <Detail theme={theme}>No positive matches. Open Unknown to review and select skills manually.</Detail>}
      <View accessibilityLiveRegion="polite"><Detail theme={theme}>Selected skills: {selected.length}</Detail></View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action theme={theme} label="Select Recommended" disabled={recommended.every(({ skillId }) => selected.includes(skillId))}
          onPress={onSelectRecommended} />
        <Action theme={theme} label="Clear Selection" disabled={selected.length === 0} onPress={onClear} />
      </View>
      {groups.map(([verdict, title]) => {
        const items = result.items.filter((item) => item.applicability === verdict)
          .sort((a, b) => a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0);
        const heading = `${title} (${items.length})`;
        return <View key={verdict} style={{ gap: 6 }}>
          {verdict === "unknown" ? <Disclosure theme={theme} label={heading} expanded={showUnknown}
            onPress={() => setShowUnknown(!showUnknown)} /> :
            <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>{heading}</Text>}
          {(verdict !== "unknown" || showUnknown) && items.map((item) => <SkillRow key={item.skillId} theme={theme}
            item={item} title={title} description={descriptions.get(item.skillId)} refs={refs}
            checked={selected.includes(item.skillId)} onToggle={() => onToggle(item.skillId)} />)}
        </View>;
      })}
    </Section>
  );
}

function Disclosure({ theme, label, expanded, onPress }: {
  theme: PluginTheme; label: string; expanded: boolean; onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" aria-expanded={expanded} accessibilityState={{ expanded }} onPress={onPress}
    style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, alignSelf: "flex-start" }}>
    <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
    <Text style={{ color: theme.colors.foreground }}>{label}</Text>
  </Pressable>;
}

function SkillRow({ theme, item, title, description, refs, checked, onToggle }: {
  theme: PluginTheme; item: RecommendationItem; title: string; description: string | undefined;
  refs: ReadonlyMap<string, EvidenceRef>; checked: boolean; onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = item.reasons[0] ?? item.matches.find(({ verdict }) => verdict === item.applicability)?.reasons[0];
  const occurrenceFlags = [...new Set(item.inventory.occurrences.flatMap((entry) => entry.flags))];
  return <View style={{ gap: 4, padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2 }}>
    <Pressable accessibilityRole="checkbox" accessibilityLabel={`Select ${item.skillId}`} aria-checked={checked} accessibilityState={{ checked }}
      onPress={onToggle} style={{ flexDirection: "row", alignItems: "center", minHeight: 36, gap: 8 }}>
      <Icon name={checked ? "SquareCheck" : "Square"} size={16}
        color={checked ? theme.colors.accent : theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foreground, flex: 1, fontWeight: "600" }}>{item.skillId}</Text>
    </Pressable>
    {description && <Detail theme={theme}>{description}</Detail>}
    <Detail theme={theme}>{title} · {inventory[item.inventory.state]}</Detail>
    {occurrenceFlags.length > 0 && <Detail theme={theme}>{occurrenceFlags.map((flag) => flags[flag]).join(" · ")}</Detail>}
    {summary && <Detail theme={theme}>{reasons[summary.code]}</Detail>}
    {item.matches.length > 0 && <Detail theme={theme}>Matching boundaries: {item.matches.length}</Detail>}
    <Disclosure theme={theme} label={`Details for ${item.skillId}`} expanded={expanded} onPress={() => setExpanded(!expanded)} />
    {expanded && <View style={{ gap: 8 }}>
      {item.reasons.map((reason) => <ReasonDetails key={reason.code} theme={theme} reason={reason} refs={refs} />)}
      {item.matches.map((match) => <View key={match.boundaryPath} style={{ gap: 3 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>
          {displayBoundary(match.boundaryPath)} · {match.verdict === "recommended" ? "Recommended" : "Optional"}
        </Text>
        {match.reasons.map((reason) => <ReasonDetails key={reason.code} theme={theme} reason={reason} refs={refs} />)}
      </View>)}
      {item.inventory.occurrences.length > 0 && <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>Existing skill inventory</Text>
        {item.inventory.occurrences.map((entry) => <View key={`${entry.layout}:${entry.relativePath}`} style={{ gap: 3 }}>
          <Text selectable style={{ color: theme.colors.foreground }}>{entry.relativePath}</Text>
          <Detail theme={theme}>{entry.layout} · {displayBoundary(entry.boundaryPath)} · {entry.match === "confirmed" ? "Confirmed" : "Candidate"}</Detail>
          {entry.directoryId !== entry.declaredId &&
            <Detail theme={theme}>Directory ID: {entry.directoryId ?? "Unknown"} · Declared ID: {entry.declaredId ?? "Unknown"}</Detail>}
          {entry.flags.map((flag) => <Detail key={flag} theme={theme}>{flags[flag]}</Detail>)}
          {entry.evidenceIds.map((id) => refs.has(id) && <EvidenceLine key={id} theme={theme} refValue={refs.get(id)!} />)}
        </View>)}
      </View>}
    </View>}
  </View>;
}

function ReasonDetails({ theme, reason, refs }: {
  theme: PluginTheme; reason: RecommendationReason; refs: ReadonlyMap<string, EvidenceRef>;
}) {
  return <View style={{ gap: 3 }}>
    <Detail theme={theme}>{reasons[reason.code]}</Detail>
    {reason.refs.map((ref, index) => {
      if (ref.kind === "project_evidence") {
        const value = refs.get(ref.evidenceId);
        return value && <EvidenceLine key={index} theme={theme} refValue={value} />;
      }
      if (ref.kind === "catalog_file") return <Text key={index} selectable style={{ color: theme.colors.foregroundMuted }}>
        Catalog rule: {ref.path} · {ref.blobSha}
      </Text>;
      return <Detail key={index} theme={theme}>See scan coverage above.</Detail>;
    })}
  </View>;
}

function EvidenceLine({ theme, refValue }: { theme: PluginTheme; refValue: EvidenceRef }) {
  return <Text selectable style={{ color: theme.colors.foregroundMuted }}>
    {refValue.relativePath} · {refValue.kind}{refValue.selector ? ` · ${refValue.selector}` : ""}
  </Text>;
}
