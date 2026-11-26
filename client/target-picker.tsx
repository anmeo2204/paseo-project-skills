import { usePaseo } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PaseoWorkspace } from "@getpaseo/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Action, Detail, Input } from "./controls";

export interface Target {
  id: string;
  label: string;
  kind: string;
  path: string;
}

export function TargetPicker({ theme, hostId, onSelect }: {
  theme: PluginTheme;
  hostId: string;
  onSelect: (target: Target) => void;
}) {
  const paseo = usePaseo();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const projects = useQuery({
    queryKey: ["projects", hostId],
    queryFn: async () => (await paseo.projects.list()).projects,
    enabled: open,
    retry: false,
  });
  const workspaces = useQuery({
    queryKey: ["workspaces", hostId],
    queryFn: async ({ signal }) => {
      const entries: PaseoWorkspace[] = [];
      let cursor: string | undefined;
      do {
        if (signal.aborted) return entries;
        const page = await paseo.workspaces.list({ page: { limit: 100, cursor } });
        entries.push(...page.entries);
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      return entries;
    },
    enabled: open,
    retry: false,
  });

  function submitPath() {
    if (path.trim()) onSelect({ id: "manual", label: "Manual directory", kind: "Directory", path });
  }

  return (
    <>
      <Action theme={theme} label="Choose project or workspace" onPress={() => setOpen(true)} />
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground }}>Absolute path on the host</Text>
        <Input theme={theme} accessibilityLabel="Absolute path on the host" value={path}
          onChangeText={setPath} onSubmitEditing={submitPath} />
        <Action theme={theme} label="Use directory" disabled={!path.trim()} onPress={submitPath} />
      </View>
      <Modal open={open} onOpenChange={setOpen} title="Choose target directory">
        <Modal.Content>
          <TargetList theme={theme} title="Project roots" pending={projects.isPending} error={projects.isError}
            retry={() => void projects.refetch()} targets={(projects.data ?? []).map((project) => ({
              id: `project:${project.projectId}`,
              label: project.projectCustomName || project.projectDisplayName,
              kind: project.projectKind === "git" ? "Git root" : "Non-Git root",
              path: project.projectRootPath,
            }))} onSelect={select} />
          <TargetList theme={theme} title="Workspaces" pending={workspaces.isPending} error={workspaces.isError}
            retry={() => void workspaces.refetch()} targets={(workspaces.data ?? []).map((workspace) => ({
              id: `workspace:${workspace.id}`,
              label: workspace.title || workspace.name,
              kind: workspace.workspaceKind === "worktree" ? "Git worktree" : "Workspace",
              path: workspace.workspaceDirectory,
            }))} onSelect={select} />
        </Modal.Content>
      </Modal>
    </>
  );

  function select(target: Target) {
    onSelect(target);
    setOpen(false);
  }
}

function TargetList({ theme, title, pending, error, retry, targets, onSelect }: {
  theme: PluginTheme;
  title: string;
  pending: boolean;
  error: boolean;
  retry: () => void;
  targets: Target[];
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
      {!pending && !error && targets.length === 0 && <Detail theme={theme}>None on this host.</Detail>}
      {!error && targets.map((target) => (
        <Pressable key={target.id} accessibilityRole="button" onPress={() => onSelect(target)}
          style={{ padding: 10, gap: 3, borderRadius: 6, backgroundColor: theme.colors.surface2 }}>
          <Text style={{ color: theme.colors.foreground }}>{target.label} · {target.kind}</Text>
          <Detail theme={theme}>{target.path}</Detail>
        </Pressable>
      ))}
    </View>
  );
}
