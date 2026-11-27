import type { PluginTheme } from "@getpaseo/plugin";
import type { useSettings } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text } from "react-native";
import { catalogRefSchema, catalogSettings, catalogSource } from "../shared/catalog-settings";
import { Action, Detail, Input } from "./controls";

export type CatalogSettingsState = ReturnType<typeof useSettings<typeof catalogSettings.schema>>;

export function CatalogSection({ theme, settings }: { theme: PluginTheme; settings: CatalogSettingsState }) {

  return (
    <>
      <Detail theme={theme}>Source repository</Detail>
      <Text selectable style={{ color: theme.colors.foreground }}>{catalogSource}</Text>
      {settings.status === "loading" && <Detail theme={theme}>Loading host settings…</Detail>}
      {(settings.status === "error" || settings.status === "invalid") && <>
        <Detail theme={theme} error>Could not read a valid catalog setting from this host.</Detail>
        <Action theme={theme} label="Reload settings" onPress={() => void settings.reload()} />
      </>}
      {settings.status === "ready" && <CatalogEditor key={settings.revision} theme={theme} settings={settings} />}
    </>
  );
}

function CatalogEditor({ theme, settings }: {
  theme: PluginTheme;
  settings: Extract<CatalogSettingsState, { status: "ready" }>;
}) {
  const [draft, setDraft] = useState(settings.values.catalogRef);
  const valid = catalogRefSchema.safeParse(draft).success;
  const saved = draft === settings.values.catalogRef;

  return (
    <>
      <Text style={{ color: theme.colors.foreground }}>Catalog revision</Text>
      <Input theme={theme} accessibilityLabel="Catalog revision" placeholder="Tag or full commit SHA"
        value={draft} onChangeText={setDraft} editable={!settings.saving} />
      <Detail theme={theme}>Tag names only, or a 40-character commit SHA. Revisions are saved without checking existence.</Detail>
      {!valid && <Detail theme={theme} error>Enter a valid tag name or a full 40-character commit SHA.</Detail>}
      {settings.saveError && <Detail theme={theme} error>Could not save the catalog revision. Reload settings and try again.</Detail>}
      <Action theme={theme} primary label={settings.saving ? "Saving…" : "Save revision"}
        disabled={settings.saving || !valid || saved}
        onPress={() => void settings.save({ catalogRef: draft }, settings.revision)} />
      <Detail theme={theme}>{settings.values.catalogRef ? `Saved on this host: ${settings.values.catalogRef}` : "No revision saved on this host."}</Detail>
    </>
  );
}
