import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type { DerivedPreviewEntry, PreviewEntry, ProviderPreviewResult, ProviderPreviewStatus } from "../shared/preview";
import { PagedEffects } from "./paged-effects";
import { Detail, Disclosure, Section } from "./controls";

type Ready = Extract<ProviderPreviewResult, { status: "ready" }>;
type Themed = { theme: PluginTheme };
const names = { codex: "Codex", cursor: "Cursor ACP", antigravity: "Antigravity", kiro: "Kiro" };
const statuses = { create: "Create", unchanged: "Unchanged", conflict: "Conflict", blocked: "Blocked" };
const blocked = {
  unsafe_entry: "The destination or an ancestor is unsafe or has the wrong file type.",
  unreadable: "The destination could not be read.",
  entry_changed: "The destination or an ancestor changed during preview.",
  read_limit: "Reading this destination exceeded the preview budget.",
  diff_limit: "The text diff exceeded the preview budget.",
};
const deferred = {
  canonical_conflict: "a canonical file conflicts with the proposed package",
  canonical_blocked: "a canonical file is blocked",
  kiro_root_unconfirmed: "the selected target could not be confirmed as a Git repo/worktree root",
};
const diagnosticMessages = {
  kiro_root_unconfirmed: "Kiro compatibility is limited at this target; no derived package is proposed.",
  canonical_conflict: "Kiro package deferred because a canonical file conflicts.",
  canonical_blocked: "Kiro package deferred because a canonical file is blocked.",
  duplicate_skill_id: "The same directory ID was observed at these paths. Precedence and activation have not been verified.",
  inventory_unverified: "Some skill paths were unsafe or changed; their inventory could not be verified.",
};

export function PreviewResults({ theme, result, paged = false }: Themed & { result: Ready; paged?: boolean }) {
  const files = [...result.entries, ...result.derivedEntries];
  const noop = files.length > 0 && files.every((entry) => entry.status === "unchanged");
  const limited = result.providers.some((provider) => provider.status === "limited" || provider.skills.some((skill) => skill.status === "deferred"));
  return <Section theme={theme} title="Preview Results">
    <Text selectable style={{ color: theme.colors.foreground }}>Target: {result.intent.canonicalDirectory}</Text>
    <Text selectable style={{ color: theme.colors.foregroundMuted }}>Pinned catalog: {result.intent.catalogCommitSha}</Text>
    {noop && <Detail theme={theme}>No file changes: all planned files already match in bytes and mode.</Detail>}
    {noop && limited && <Detail theme={theme}>Some provider packages are limited or deferred; review compatibility below.</Detail>}
    <Detail theme={theme}>Create: {files.filter((e) => e.status === "create").length} · Unchanged: {files.filter((e) => e.status === "unchanged").length} · Conflict: {files.filter((e) => e.status === "conflict").length} · Blocked: {files.filter((e) => e.status === "blocked").length}</Detail>
    <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>Canonical files ({result.entries.length})</Text>
    {paged ? <PagedEffects theme={theme} label="canonical files" items={result.entries} render={entry => <FileRow key={entry.destination} theme={theme} entry={entry} />} /> :
      result.entries.map((entry) => <FileRow key={entry.destination} theme={theme} entry={entry} />)}
    <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>Kiro derived files ({result.derivedEntries.length})</Text>
    {paged ? <PagedEffects theme={theme} label="derived files" items={result.derivedEntries} render={entry => <FileRow key={entry.destination} theme={theme} entry={entry} />} /> :
      result.derivedEntries.map((entry) => <FileRow key={entry.destination} theme={theme} entry={entry} />)}
    {result.providers.length === 0 && <Detail theme={theme}>Canonical preview only. No target providers selected.</Detail>}
    {result.providers.map((provider) => <ProviderRow key={provider.providerId} theme={theme} provider={provider} />)}
    {result.diagnostics.length > 0 && <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>Preview diagnostics</Text>}
    {result.diagnostics.map((diagnostic, index) => <View key={index} style={{ gap: 3 }}>
      <Detail theme={theme}>{diagnostic.skillId ? diagnostic.skillId + ": " : ""}{diagnosticMessages[diagnostic.code]}</Detail>
      {diagnostic.paths.map((path) => <Text key={path} selectable style={{ color: theme.colors.foregroundMuted }}>{path}</Text>)}
    </View>)}
  </Section>;
}

function FileRow({ theme, entry }: Themed & { entry: PreviewEntry | DerivedPreviewEntry }) {
  const [expanded, setExpanded] = useState(false);
  return <View style={{ gap: 4, padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface2 }}>
    <Text selectable style={{ color: theme.colors.foreground, fontWeight: "600" }}>{statuses[entry.status]} · {entry.destination}</Text>
    {"canonicalDestination" in entry && <Text selectable style={{ color: theme.colors.foregroundMuted }}>Canonical source: {entry.canonicalDestination}</Text>}
    {entry.reason && <Detail theme={theme} error>{blocked[entry.reason]}</Detail>}
    {entry.change?.kind === "binary" && <Detail theme={theme}>Binary change · size, SHA-256 and mode available below.</Detail>}
    <Disclosure theme={theme} label={`Preview details for ${entry.destination}`} expanded={expanded} onPress={() => setExpanded(!expanded)} />
    {expanded && <View style={{ gap: 5 }}>
      <Fingerprint theme={theme} label="Proposed" value={entry.proposed} />
      {entry.existing ? <Fingerprint theme={theme} label="Existing" value={entry.existing} /> :
        <Detail theme={theme}>{entry.status === "create" ? "No existing file." : "Existing content unavailable."}</Detail>}
      {entry.change?.kind === "text" && <ScrollView horizontal style={{ maxHeight: 300, backgroundColor: theme.colors.surface0 }}>
        <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12, padding: 8 }}>{entry.change.unifiedDiff}</Text>
      </ScrollView>}
    </View>}
  </View>;
}

function Fingerprint({ theme, label, value }: Themed & { label: string; value: PreviewEntry["proposed"] }) {
  return <View style={{ gap: 2 }}>
    <Detail theme={theme}>{label}: {value.sizeBytes} bytes · mode {value.mode.toString(8).padStart(4, "0")}</Detail>
    <Text selectable style={{ color: theme.colors.foregroundMuted }}>{label} SHA-256: {value.sha256}</Text>
  </View>;
}

function ProviderRow({ theme, provider }: Themed & { provider: ProviderPreviewStatus }) {
  const [expanded, setExpanded] = useState(false);
  const { verification } = provider;
  const label = names[provider.providerId];
  return <View style={{ gap: 4 }}>
    <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{label} · {provider.status === "canonical_only" ? "Canonical only · 0 additional files" : provider.status}</Text>
    {provider.providerId === "kiro" && <>
      {provider.status === "limited" ? <Detail theme={theme}>Kiro is limited: this target is a nested workspace, non-Git directory, or its Git root could not be confirmed. No Kiro files are proposed.</Detail> :
        <Detail theme={theme}>{provider.rootStatus === "gitfile_root" ? "Git root confirmed (gitfile/worktree)." : "Git repository root confirmed."}</Detail>}
      <Detail theme={theme}>Kiro native discovery was verified only with session CWD at root and mode kiro_default. Preview does not change session CWD or configuration.</Detail>
      {provider.skills.filter((skill) => skill.status === "deferred").map((skill) => <Detail key={skill.skillId} theme={theme} error>
        {skill.skillId}: Kiro package deferred because {deferred[skill.reason ?? "kiro_root_unconfirmed"]}.
      </Detail>)}
    </>}
    <Disclosure theme={theme} label={`M3.1 historical verification for ${label}`} expanded={expanded} onPress={() => setExpanded(!expanded)} />
    {expanded && <View style={{ gap: 3 }}>
      <Detail theme={theme}>Historical M3.1 evidence; this is not verification of the current session.</Detail>
      <Detail theme={theme}>Paseo {verification.paseoVersion} · {label} {verification.binaryVersion} · {verification.transport}</Detail>
      <Detail theme={theme}>Mode: {verification.loadMode} · CWD: {verification.cwdScope === "git_root" ? "repo/worktree root" : "root and nested"}</Detail>
      <Detail theme={theme}>{verification.note}</Detail>
    </View>}
  </View>;
}
