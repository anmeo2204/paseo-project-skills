import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useLayoutEffect, useRef, useState } from "react";
import { providerPreviewRpc } from "../shared/rpc";
import { providerPreviewResultSchema, type ProviderPreviewResult } from "../shared/preview";
import type { SelectionIntentV1 } from "../shared/selection-intent";
import { Action, Detail, Section } from "./controls";
import { FixtureApprovalPreview, useFixtureApproval } from "./fixture-approval";
import { previewErrors, previewIntentKey, invalidResult } from "./preview-presentation";
import { PreviewResults } from "./preview-results";

type Ready = Extract<ProviderPreviewResult, { status: "ready" }>;
type Attempt = { scope: string };
type Run = { attempt: Attempt } & (
  | { phase: "pending" | "cancelled" }
  | { phase: "error"; message: string }
  | { phase: "complete"; result: Ready }
);
type PreviewProps = { theme: PluginTheme; intent: SelectionIntentV1; generation: string; disabled?: boolean };
export function PreviewRun(props: PreviewProps) {
  return useFixtureApproval() ? <FixtureApprovalPreview {...props} /> : <ReadOnlyPreview {...props} />;
}

function ReadOnlyPreview({ theme, intent, generation, disabled = false }: PreviewProps) {
  const preview = useRpc(providerPreviewRpc);
  const scope = JSON.stringify([generation, previewIntentKey(intent), disabled]);
  const active = useRef<Attempt | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const visible = run?.attempt.scope === scope ? run : null;
  useLayoutEffect(() => {
    active.current = null;
    setRun(null);
    return () => { active.current = null; };
  }, [scope]);

  async function start() {
    if (disabled || intent.selectedSkillIds.length === 0 || active.current) return;
    const attempt = { scope };
    active.current = attempt;
    setRun({ attempt, phase: "pending" });
    const fail = (message: string) => {
      if (active.current !== attempt) return;
      active.current = null;
      setRun({ attempt, phase: "error", message });
    };
    try {
      // One RPC per explicit click. The SDK has no cancellation handle for this RPC.
      const raw = await preview(intent);
      if (active.current !== attempt) return;
      const parsed = providerPreviewResultSchema.safeParse(raw);
      if (!parsed.success) return fail(invalidResult);
      if (parsed.data.status === "error") return fail(previewErrors[parsed.data.code]);
      if (previewIntentKey(parsed.data.intent) !== previewIntentKey(intent)) return fail(invalidResult);
      active.current = null;
      setRun({ attempt, phase: "complete", result: parsed.data });
    } catch { fail("Could not receive a preview from this host. Check the connection and try again."); }
  }

  return <>
    <Section theme={theme} title="Preview Changes">
      <Detail theme={theme}>Review the proposed files without writing to the project.</Detail>
      {intent.selectedSkillIds.length === 0 && <Detail theme={theme}>Select at least one skill to preview changes.</Detail>}
      <Action theme={theme} primary label="Preview Changes" disabled={disabled || intent.selectedSkillIds.length === 0 || visible?.phase === "pending"}
        onPress={() => void start()} />
      <Detail theme={theme}>Changing the selection discards this preview. Preview does not authorize installation.</Detail>
      {visible?.phase === "pending" && <>
        <Detail theme={theme}>Preparing read-only preview…</Detail>
        <Action theme={theme} label="Cancel Preview" onPress={() => {
          if (active.current !== visible.attempt) return;
          active.current = null;
          setRun({ attempt: visible.attempt, phase: "cancelled" });
        }} />
        <Detail theme={theme}>Cancel stops waiting here. The daemon may finish; its late reply will be ignored.</Detail>
      </>}
      {visible?.phase === "cancelled" && <Detail theme={theme}>Stopped waiting for preview. The daemon request was not cancelled.</Detail>}
      {visible?.phase === "error" && <Detail theme={theme} error>{visible.message}</Detail>}
    </Section>
    {visible?.phase === "complete" && <PreviewResults key={scope} theme={theme} result={visible.result} />}
  </>;
}
