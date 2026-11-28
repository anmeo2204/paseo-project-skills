import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { FoundationScreen } from "./client/foundation-screen";
import { FixtureApprovalScope } from "./client/fixture-approval";
import { createOperationTracker } from "./client/apply-tracker";
import { applyTargetStatusRpc, type ApplyTargetStatusOutput } from "./shared/apply";

const screenId = "foundation";
const slot = "paseo-project-skills";
const title = "Project Skills";
type ProfileStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function createMemoryStorage(): ProfileStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
  };
}

/**
 * Resolves profile storage for operation tracking.
 * Uses `globalThis.localStorage` on Desktop/Web (retaining fail-closed persistence errors),
 * and falls back to session memory storage on React Native mobile where `localStorage` is absent.
 */
export function resolveClientProfileStorage(
  globalObj: { localStorage?: ProfileStorage } = globalThis as unknown as { localStorage?: ProfileStorage },
  fallback: ProfileStorage = createMemoryStorage(),
): ProfileStorage {
  if (
    globalObj.localStorage &&
    typeof globalObj.localStorage.getItem === "function" &&
    typeof globalObj.localStorage.setItem === "function"
  ) {
    return globalObj.localStorage;
  }
  return fallback;
}

export function formatHostApplyNotice(status: ApplyTargetStatusOutput): string | null {
  if (!status.trustBoundaryOk || status.reasons.includes("remote_exposure_enabled")) {
    return "Safe Apply is inactive (Preview-only): Relay or remote exposure is enabled on this daemon, or the local-only trust boundary could not be verified.";
  }
  if (!status.hostCompatible) {
    return `Safe Apply is inactive (Preview-only): host environment is outside the verified compatibility matrix (${status.reasons.join(", ") || "unsupported_environment"}).`;
  }
  if (status.enrolledCount === 0) {
    return "Safe Apply is in Preview-only mode: no project roots are enrolled on this daemon. Enroll a project via host CLI (scripts/enroll-project-skills.mjs) to enable create-only Apply.";
  }
  return null;
}

function ProjectSkillsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="BookOpen"
      active={currentScreen?.screenId === screenId}
      onPress={() => openScreen({ screenId })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const memoryFallback = createMemoryStorage();
  const tracker = createOperationTracker({
    slot,
    storage: () => resolveClientProfileStorage(
      globalThis as unknown as { localStorage?: ProfileStorage },
      memoryFallback,
    ),
  });

  function Screen(props: PluginScreenProps) {
    const targetStatus = useRpc(applyTargetStatusRpc);
    const online = useHosts().some(host => host.serverId === props.host.id && host.status === "online");
    const [probe, setProbe] = useState<{ hostId: string; rpc: typeof targetStatus; status?: ApplyTargetStatusOutput }>();

    useEffect(() => {
      let present = true;
      setProbe(undefined);
      if (online) {
        void targetStatus({}).then(status => {
          if (present) setProbe({ hostId: props.host.id, rpc: targetStatus, status });
        }).catch(() => {
          if (present) setProbe({ hostId: props.host.id, rpc: targetStatus, status: undefined });
        });
      }
      return () => { present = false; };
    }, [online, targetStatus, props.host.id]);

    const settled = online && probe?.hostId === props.host.id && probe.rpc === targetStatus;
    const status = settled ? probe?.status : undefined;
    const notice = status ? formatHostApplyNotice(status) : null;
    const canApprove = Boolean(status && status.hostCompatible && status.trustBoundaryOk);

    const baseScreen = <FoundationScreen {...props} />;
    const withNotice = notice ? (
      <View style={{ flex: 1 }}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: props.theme.colors.border, backgroundColor: props.theme.colors.surface1 }}>
          <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>{notice}</Text>
        </View>
        {baseScreen}
      </View>
    ) : baseScreen;

    return <FixtureApprovalScope slot={slot} tracker={tracker} allowApproval={canApprove}>{withNotice}</FixtureApprovalScope>;
  }

  const removeScreen = client.addScreen({ id: screenId, title, Component: Screen });
  const removeSidebarItem = client.addSidebarHeaderItem({
    id: screenId,
    title,
    Component: ProjectSkillsSidebarItem,
  });

  return () => {
    removeSidebarItem();
    removeScreen();
  };
}
