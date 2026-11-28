import { createContext, createElement, useContext } from "react";

export { usePaseo, useRpc, useSubscription } from "@getpaseo/plugin/client";

export const HostFixture = createContext(null);
export const useHosts = () => useContext(HostFixture).hosts;
const defaultPreferences = {
  status: "ready",
  revision: "prefs-default",
  saving: false,
  saveError: null,
  values: { recentProjects: [], providerPreferencesByRoot: {} },
  save: async () => true,
  reset: async () => true,
  reload: async () => {},
};
export function useSettings(definition) {
  if (definition.scope !== "host") throw new Error("Expected host-scoped settings");
  const fixture = useContext(HostFixture);
  if (fixture.settingsById && definition.id in fixture.settingsById) {
    return fixture.settingsById[definition.id];
  }
  if (definition.id === "workspace-preferences") {
    return fixture.preferences ?? defaultPreferences;
  }
  return fixture.settings;
}

export const Pressable = "pressable";
export const Text = "text";
export const View = "view";
export const TextInput = "input";
export const Icon = "icon";
export const ScrollView = "scroll-view";
export const SidebarRow = "sidebar-row";
export const Modal = Object.assign(
  ({ open, children }) => open ? createElement("modal", null, children) : null,
  { Content: "modal-content" },
);
