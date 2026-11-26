import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { FoundationScreen } from "./client/foundation-screen";

const screenId = "foundation";
const title = "Project Skills";

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
  const removeScreen = client.addScreen({ id: screenId, title, Component: FoundationScreen });
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
