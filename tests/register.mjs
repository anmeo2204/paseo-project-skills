import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = new URL("../", import.meta.url).href;
const fixture = new URL("./client-fixture.mjs", import.meta.url).href;
const hostModules = new Set(["react-native", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui"]);

// Compile the production client without an app bundle. Replace only the Electron/RN host surfaces.
registerHooks({
  resolve(specifier, context, next) {
    if (hostModules.has(specifier) && context.parentURL?.startsWith(root) &&
        !context.parentURL.startsWith(root + "node_modules/") && context.parentURL !== fixture) {
      return next(fixture, context);
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith(root) &&
        !context.parentURL.startsWith(root + "node_modules/")) {
      const url = new URL(specifier, context.parentURL).href;
      for (const suffix of [".ts", ".tsx"]) {
        if (existsSync(fileURLToPath(url + suffix))) return next(url + suffix, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(root) && !url.startsWith(root + "node_modules/") && /\.tsx?$/.test(url)) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(source, {
          fileName: fileURLToPath(url),
          compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        }).outputText,
      };
    }
    return next(url, context);
  },
});
