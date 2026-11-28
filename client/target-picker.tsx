import { usePaseo } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PaseoWorkspace } from "@getpaseo/client";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { workspacePreferenceLimits, type RecentProject } from "../shared/workspace-preferences";
import { Action, Detail, Disclosure, Input } from "./controls";

export interface Target {
  id: string;
  label: string;
  kind: string;
  path: string;
  fromRecent?: boolean;
}

function matchesQuery(target: Target, normalizedQuery: string) {
  if (!normalizedQuery) return true;
  return (
    target.label.toLowerCase().includes(normalizedQuery) ||
    target.kind.toLowerCase().includes(normalizedQuery) ||
    target.path.toLowerCase().includes(normalizedQuery)
  );
}

export function TargetPicker({
  theme,
  hostId,
  recentProjects = [],
  onSelect,
  onRemoveRecent,
}: {
  theme: PluginTheme;
  hostId: string;
  recentProjects?: readonly RecentProject[];
  onSelect: (target: Target) => void;
  onRemoveRecent?: (canonicalDirectory: string) => void;
}) {
  const paseo = usePaseo();
  const pickerId = useId();
  const [open, setOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [path, setPath] = useState("");

  const projects = useQuery({
    queryKey: ["projects", hostId, pickerId],
    queryFn: async () => (await paseo.projects.list()).projects,
    enabled: open,
    retry: false,
    gcTime: 0,
  });

  // P2: Fetch paginated workspace pages (bounded) so search covers all pages, not just page 1.
  const workspaces = useQuery({
    queryKey: ["workspaces", hostId, pickerId],
    queryFn: async ({ signal }) => {
      const entries: PaseoWorkspace[] = [];
      let cursor: string | undefined;
      let pages = 0;
      let truncated = false;
      do {
        if (signal.aborted) return { entries, truncated };
        if (pages >= workspacePreferenceLimits.maxWorkspacePages) {
          truncated = true;
          break;
        }
        const page = await paseo.workspaces.list({ page: { limit: 100, cursor } });
        entries.push(...page.entries);
        pages++;
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      return { entries, truncated };
    },
    enabled: open,
    retry: false,
    gcTime: 0,
  });

  function submitPath() {
    if (path.trim()) onSelect({ id: "manual", label: "Manual directory", kind: "Directory", path });
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) setSearch("");
  }

  function select(target: Target) {
    onSelect(target);
    handleOpenChange(false);
  }

  const normalizedQuery = search.trim().toLowerCase();
  const projectTargets: Target[] = (projects.data ?? []).map((project) => ({
    id: `project:${project.projectId}`,
    label: project.projectCustomName || project.projectDisplayName,
    kind: project.projectKind === "git" ? "Git root" : "Non-Git root",
    path: project.projectRootPath,
  }));
  const workspaceTargets: Target[] = (workspaces.data?.entries ?? []).map((workspace) => ({
    id: `workspace:${workspace.id}`,
    label: workspace.title || workspace.name,
    kind: workspace.workspaceKind === "worktree" ? "Git worktree" : "Workspace",
    path: workspace.workspaceDirectory,
  }));
  const filteredProjects = projectTargets.filter((item) => matchesQuery(item, normalizedQuery));
  const filteredWorkspaces = workspaceTargets.filter((item) => matchesQuery(item, normalizedQuery));
  const anyLoading = projects.isPending || workspaces.isPending;
  const noMatches = Boolean(
    normalizedQuery &&
    !anyLoading &&
    !projects.isError &&
    !workspaces.isError &&
    filteredProjects.length === 0 &&
    filteredWorkspaces.length === 0,
  );

  return (
    <View style={{ gap: 8 }}>
      <Action theme={theme} primary label="Choose project or workspace" onPress={() => handleOpenChange(true)} />

      {/* D2: Recent Projects are explicit 1-click quick-pickers scoped to this host. */}
      {recentProjects.length > 0 && (
        <View style={{ gap: 6 }}>
          <Detail theme={theme}>Recent projects on this host</Detail>
          <View style={{ gap: 4 }}>
            {recentProjects.slice(0, 5).map((item) => (
              <View
                key={item.canonicalDirectory}
                style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Recent project ${item.label}`}
                  onPress={() => onSelect({
                    id: `recent:${item.canonicalDirectory}`,
                    label: item.label,
                    kind: item.kind,
                    path: item.canonicalDirectory,
                    fromRecent: true,
                  })}
                  style={{
                    flex: 1,
                    minHeight: 36,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    gap: 2,
                    borderRadius: 6,
                    backgroundColor: theme.colors.surface2,
                  }}
                >
                  <Text style={{ color: theme.colors.foreground }}>{item.label} · {item.kind}</Text>
                  <Detail theme={theme}>{item.canonicalDirectory}</Detail>
                </Pressable>
                {onRemoveRecent && (
                  <Action
                    theme={theme}
                    label="Remove"
                    onPress={() => onRemoveRecent(item.canonicalDirectory)}
                  />
                )}
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Advanced manual path entry collapsed by default */}
      <Disclosure
        theme={theme}
        label="Advanced: Enter path manually"
        expanded={manualOpen}
        onPress={() => setManualOpen((value) => !value)}
      />
      {manualOpen && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.colors.foreground }}>Absolute path on the host</Text>
          <Input
            theme={theme}
            accessibilityLabel="Absolute path on the host"
            value={path}
            onChangeText={setPath}
            onSubmitEditing={submitPath}
          />
          <Action theme={theme} label="Use directory" disabled={!path.trim()} onPress={submitPath} />
        </View>
      )}

      <Modal open={open} onOpenChange={handleOpenChange} title="Choose target directory">
        <Modal.Content>
          <View style={{ gap: 10 }}>
            <View style={{ gap: 6 }}>
              <Input
                theme={theme}
                accessibilityLabel="Search projects and workspaces"
                placeholder="Filter by name, kind, or path…"
                value={search}
                onChangeText={setSearch}
              />
              {search.length > 0 && (
                <Action theme={theme} label="Clear search" onPress={() => setSearch("")} />
              )}
            </View>
            {noMatches ? (
              <Detail theme={theme}>No matching projects or workspaces.</Detail>
            ) : (
              <>
                <TargetList
                  theme={theme}
                  title="Project roots"
                  pending={projects.isPending}
                  error={projects.isError}
                  retry={() => void projects.refetch()}
                  targets={filteredProjects}
                  emptyLabel={normalizedQuery ? "No matching project roots." : "None on this host."}
                  onSelect={select}
                />
                <TargetList
                  theme={theme}
                  title="Workspaces"
                  pending={workspaces.isPending}
                  error={workspaces.isError}
                  retry={() => void workspaces.refetch()}
                  targets={filteredWorkspaces}
                  emptyLabel={normalizedQuery ? "No matching workspaces." : "None on this host."}
                  onSelect={select}
                />
                {workspaces.data?.truncated && (
                  <Detail theme={theme}>
                    Showing the first {workspaces.data.entries.length} workspaces. Use Advanced: Enter path manually for unlisted workspaces.
                  </Detail>
                )}
              </>
            )}
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function TargetList({
  theme,
  title,
  pending,
  error,
  retry,
  targets,
  emptyLabel,
  onSelect,
}: {
  theme: PluginTheme;
  title: string;
  pending: boolean;
  error: boolean;
  retry: () => void;
  targets: Target[];
  emptyLabel: string;
  onSelect: (target: Target) => void;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>{title}</Text>
      {pending && <Detail theme={theme}>Loading…</Detail>}
      {error && <>
        <Detail theme={theme} error>Could not load {title.toLowerCase()} from this host.</Detail>
        <Action theme={theme} label={`Retry ${title.toLowerCase()}`} onPress={retry} />
      </>}
      {!pending && !error && targets.length === 0 && <Detail theme={theme}>{emptyLabel}</Detail>}
      {!error && targets.map((target) => (
        <Pressable
          key={target.id}
          accessibilityRole="button"
          onPress={() => onSelect(target)}
          style={{ padding: 10, gap: 3, borderRadius: 6, backgroundColor: theme.colors.surface2 }}
        >
          <Text style={{ color: theme.colors.foreground }}>{target.label} · {target.kind}</Text>
          <Detail theme={theme}>{target.path}</Detail>
        </Pressable>
      ))}
    </View>
  );
}
