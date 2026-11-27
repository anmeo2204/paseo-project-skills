import type { PreviewErrorCode } from "../shared/preview";
import type { SelectionIntentV1 } from "../shared/selection-intent";

export const previewErrors: Record<PreviewErrorCode, string> = {
  invalid_selection: "The selection is invalid. Run Scan & Recommend and select skills again.",
  host_mismatch: "The selected host no longer matches. Reconnect and scan again.",
  settings_changed: "The saved catalog settings changed. Run Scan & Recommend again.",
  catalog_mismatch: "The pinned catalog changed. Run Scan & Recommend again.",
  catalog_unavailable: "The catalog is unavailable on this host. Check its saved revision and try again.",
  invalid_catalog: "The selected catalog package could not be validated. Check the catalog revision.",
  invalid_target: "The target directory is no longer valid. Select and validate it again.",
  target_changed: "The target changed on this host. Select and scan it again.",
  limit_exceeded: "The preview exceeded its resource limits. Select fewer skills and try again.",
  busy: "The host is finishing another preview. Wait a moment and try again.",
  cancelled: "The host cancelled this preview. Try again when it is ready.",
  host_io_error: "The host could not read the preview destinations. Check access and try again.",
};
export const invalidResult = "The preview result could not be verified. Try again.";
export const previewIntentKey = (intent: SelectionIntentV1) => JSON.stringify({ ...intent,
  selectedSkillIds: [...intent.selectedSkillIds].sort(), targetProviderIds: [...intent.targetProviderIds].sort() });

