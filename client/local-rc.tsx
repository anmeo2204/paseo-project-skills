import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { FoundationScreen } from "./foundation-screen";
import { FixtureApprovalScope } from "./fixture-approval";
import { createOperationTracker } from "./apply-tracker";
import { localApplyCapabilityRpc } from "../shared/apply";

const slot = "paseo-project-skills-local-rc";
const title = "Project Skills Local RC";
type ProfileStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export default function contribute(client: PluginClientContext) {
  const tracker = createOperationTracker({ slot,
    storage: () => (globalThis as unknown as { localStorage: ProfileStorage }).localStorage });
  function Screen(props: PluginScreenProps) {
    const capability = useRpc(localApplyCapabilityRpc);
    const online = useHosts().some(host => host.serverId === props.host.id && host.status === "online");
    const [verified, setVerified] = useState<{ hostId: string; capability: typeof capability }>();
    useEffect(() => {
      let present = true;
      setVerified(undefined);
      if (online) void capability({}).then(result => {
        if (present && result.enabled) setVerified({ hostId: props.host.id, capability });
      }).catch(() => {});
      return () => { present = false; };
    }, [online, capability, props.host.id]);
    const screen = <FoundationScreen {...props} />;
    return online && verified?.hostId === props.host.id && verified.capability === capability
      ? <FixtureApprovalScope slot={slot} tracker={tracker}>{screen}</FixtureApprovalScope> : screen;
  }

  const removeScreen = client.addScreen({ id: "foundation", title, Component: Screen });
  const removeSidebar = client.addSidebarHeaderItem({ id: "foundation", title, Component: ({currentScreen, openScreen}) =>
    <SidebarRow icon="BookOpen" active={currentScreen?.screenId === "foundation"}
      onPress={() => openScreen({ screenId: "foundation" })} /> });
  return () => { removeSidebar(); removeScreen(); };
}
