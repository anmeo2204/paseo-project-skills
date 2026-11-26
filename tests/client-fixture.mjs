import { createContext, createElement, useContext } from "react";

export { usePaseo, useRpc } from "@getpaseo/plugin/client";

export const HostFixture = createContext(null);
export const useHosts = () => useContext(HostFixture).hosts;
export function useSettings(definition) {
  if (definition.scope !== "host") throw new Error("Expected host-scoped settings");
  return useContext(HostFixture).settings;
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
