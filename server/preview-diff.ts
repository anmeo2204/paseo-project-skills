import { TextDecoder } from "node:util";

function text(bytes: Buffer) {
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? undefined : value;
  } catch { return undefined; }
}

// A single hunk with three context lines. Common prefix/suffix trimming is linear
// in input size, including pathological minified files; no quadratic LCS table.
export function previewDiff(path: string, before: Buffer | undefined, after: Buffer,
  oldMode: number | undefined, newMode: number): { kind: "binary" } | { kind: "text"; unifiedDiff: string } {
  const oldText = before === undefined ? "" : text(before);
  const newText = text(after);
  if (oldText === undefined || newText === undefined) return { kind: "binary" };
  const a = oldText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const b = newText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const label = (prefix: string) => JSON.stringify(prefix + path);
  const mode = (value: number) => (0o100000 | value).toString(8);
  let diff = `diff --git ${label("a/")} ${label("b/")}\n`;
  if (oldMode === undefined) diff += `new file mode ${mode(newMode)}\n`;
  else if (oldMode !== newMode) diff += `old mode ${mode(oldMode)}\nnew mode ${mode(newMode)}\n`;
  if (oldText !== newText) {
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    const start = Math.max(0, prefix - 3);
    const context = Math.min(3, suffix);
    const oldEnd = a.length - suffix;
    const newEnd = b.length - suffix;
    const oldCount = oldEnd + context - start;
    const newCount = newEnd + context - start;
    diff += `--- ${before === undefined ? "/dev/null" : label("a/")}\n+++ ${label("b/")}\n`;
    diff += `@@ -${oldCount ? start + 1 : start},${oldCount} +${newCount ? start + 1 : start},${newCount} @@\n`;
    const line = (sign: string, value: string) => sign + value + (value.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");
    for (let i = start; i < prefix; i++) diff += line(" ", a[i]);
    for (let i = prefix; i < oldEnd; i++) diff += line("-", a[i]);
    for (let i = prefix; i < newEnd; i++) diff += line("+", b[i]);
    for (let i = 0; i < context; i++) diff += line(" ", a[oldEnd + i]);
  }
  return { kind: "text", unifiedDiff: diff };
}
