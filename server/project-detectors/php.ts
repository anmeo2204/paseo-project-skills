import { hasFile, objectFile, pathFor, record, safeLabel, versionSpec } from "./metadata";
import type { DiscoveryContext, ProjectDetector } from "./types";

function header(text: string, key: string) {
  return new RegExp("^[ \\t/*#@]*" + key + ":[ \\t]*([^\\r\\n]+)", "im").test(text);
}

async function wordpress(context: DiscoveryContext) {
  const markers: { kind: "plugin" | "theme"; path: string; child?: boolean }[] = [];
  if (hasFile(context, "style.css")) {
    const path = pathFor(context, "style.css");
    const content = await context.read(path);
    if (content && header(content, "Theme Name")) markers.push({ kind: "theme", path, child: header(content, "Template") });
  }
  // Only directory-level PHP files are plugin entry candidates. The reader reserves
  // prefix reads for these files and excludes credential files before opening.
  for (const file of context.files) {
    if (file.kind !== "file" || !file.name.endsWith(".php")) continue;
    const componentRoot = context.root === "." || /(?:^|\/)wp-content\/plugins\/[^/]+$/.test(context.root) ||
      file.name === context.root.split("/").at(-1) + ".php" || file.name === "plugin.php";
    if (!componentRoot) continue;
    const content = await context.read(file.path);
    if (content?.startsWith("<?php") && header(content, "Plugin Name")) markers.push({ kind: "plugin", path: file.path });
  }
  return markers;
}

export const phpDetector: ProjectDetector = {
  id: "php",
  candidate(path) {
    if (/(?:^|\/)composer\.json$/.test(path)) return "full";
    if (/(?:^|\/)(?:style\.css|[^/]+\.php)$/.test(path)) return "prefix";
  },
  async discover(context) {
    if (await objectFile(context, "composer.json")) context.boundary("package", context.ref(pathFor(context, "composer.json")));
    for (const marker of await wordpress(context)) context.boundary("application",
      context.ref(marker.path, "header", marker.kind === "theme" ? "theme_name" : "plugin_name"));
  },
  async detect(context) {
    const composer = await objectFile(context, "composer.json");
    if (composer) {
      const manifest = pathFor(context, "composer.json");
      context.fact({ kind: "package_manager", key: "composer", basis: "direct", evidenceIds: [context.ref(manifest)] });
      for (const [section, scope] of [["require", "production"], ["require-dev", "dev"]] as const) {
        const values = record(composer[section]);
        if (!values && composer[section] !== undefined) context.warn("malformed_manifest", manifest);
        for (const [key, value] of Object.entries(values ?? {})) {
          if (!safeLabel(key) || typeof value !== "string") {
            context.warn("malformed_manifest", manifest);
            continue;
          }
          const origin = context.ref(manifest, "declaration", section + "/" + key);
          context.fact({ kind: "dependency", key, ecosystem: "composer", scope, ...versionSpec(value),
            basis: "direct", evidenceIds: [origin] });
          if (key === "php") context.fact({ kind: "language", key, basis: "direct", evidenceIds: [origin] });
          if (key === "laravel/framework" && scope === "production") {
            if (hasFile(context, "artisan")) context.boundary("application", context.ref(pathFor(context, "artisan")));
            context.fact({ kind: "framework", key: "laravel", basis: "inferred", ruleId: "laravel_framework_dependency",
              evidenceIds: [origin, ...(hasFile(context, "artisan") ? [context.ref(pathFor(context, "artisan"))] : [])] });
          }
          for (const [kind, pattern] of [
            ["database", /^(?:ext-(?:pdo(?:[-_]\w+)?|mysqli|pgsql|sqlite3|redis)|doctrine\/(?:dbal|orm|migrations)|illuminate\/database|predis\/predis)$/],
            ["queue", /^(?:illuminate\/queue|laravel\/horizon|php-amqplib\/php-amqplib|symfony\/messenger)$/],
            ["test", /^(?:phpunit\/phpunit|pestphp\/pest)$/],
          ] as const) {
            if (pattern.test(key)) context.fact({ kind, key, basis: "direct", evidenceIds: [origin] });
          }
        }
      }
    }
    for (const marker of await wordpress(context)) {
      const origin = context.ref(marker.path, "header", marker.kind === "theme" ? "theme_name" : "plugin_name");
      context.fact({ kind: "framework", key: "wordpress-" + marker.kind, basis: "inferred",
        ruleId: "wordpress_component_header", evidenceIds: [origin] });
      if (marker.child) context.fact({ kind: "framework", key: "wordpress-child-theme", basis: "inferred",
        ruleId: "wordpress_template_header", evidenceIds: [origin, context.ref(marker.path, "header", "template")] });
      const template = context.owned.find((entry) => entry.kind === "file" &&
        entry.path.startsWith(pathFor(context, "templates") + "/") && entry.name.endsWith(".html"));
      if (marker.kind === "theme" && template && hasFile(context, "theme.json")) {
        context.fact({ kind: "framework", key: "wordpress-block-theme", basis: "inferred", ruleId: "wordpress_block_template",
          evidenceIds: [origin, context.ref(template.path), context.ref(pathFor(context, "theme.json"))] });
      }
    }
  },
};
