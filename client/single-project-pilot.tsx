import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { FoundationScreen } from "./foundation-screen";
import { FixtureApprovalScope } from "./fixture-approval";
import { createOperationTracker } from "./apply-tracker";
import { localApplyCapabilityRpc } from "../shared/apply";

const slot = "paseo-project-skills-single-project-pilot";
const title = "Project Skills Single-Project Pilot";
type ProfileStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
export const pilotPreviewOnlyNotice =
  "Safe Apply is inactive on this daemon (Preview-only): opt-in is off, no project root is enrolled, or the enrolled root identity could not be verified.";

export default function contribute(client: PluginClientContext) {
  const tracker = createOperationTracker({ slot,
    storage: () => (globalThis as unknown as { localStorage: ProfileStorage }).localStorage });
  function Screen(props: PluginScreenProps) {
    const capability = useRpc(localApplyCapabilityRpc);
    const online = useHosts().some(host => host.serverId === props.host.id && host.status === "online");
    const [probe, setProbe] = useState<{ hostId: string; capability: typeof capability; enabled: boolean }>();
    useEffect(() => {
      let present = true;
      setProbe(undefined);
      if (online) void capability({}).then(result => {
        if (present) setProbe({ hostId: props.host.id, capability, enabled: Boolean(result.enabled) });
      }).catch(() => {
        if (present) setProbe({ hostId: props.host.id, capability, enabled: false });
      });
      return () => { present = false; };
    }, [online, capability, props.host.id]);
    const settled = online && probe?.hostId === props.host.id && probe.capability === capability;
    const enabled = Boolean(settled && probe?.enabled);
    const screen = <FoundationScreen {...props} />;
    if (enabled) {
      return <FixtureApprovalScope slot={slot} tracker={tracker}>{screen}</FixtureApprovalScope>;
    }
    if (settled) {
      return (
        <View style={{ flex: 1 }}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: props.theme.colors.border, backgroundColor: props.theme.colors.surface1 }}>
            <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>{pilotPreviewOnlyNotice}</Text>
          </View>
          {screen}
        </View>
      );
    }
    return screen;
  }

  const removeScreen = client.addScreen({ id: "foundation", title, Component: Screen });
  const removeSidebar = client.addSidebarHeaderItem({ id: "foundation", title, Component: ({currentScreen, openScreen}) =>
    <SidebarRow icon="BookOpen" active={currentScreen?.screenId === "foundation"}
      onPress={() => openScreen({ screenId: "foundation" })} /> });
  return () => { removeSidebar(); removeScreen(); };
}
