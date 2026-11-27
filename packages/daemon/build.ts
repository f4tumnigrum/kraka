import { browserAssets } from "./src/browser-listener";
const asset = await browserAssets();
const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  compile: { outfile: "../../.build/kraka" },
  define: { KRAKA_BROWSER_JS: JSON.stringify(asset) },
});
if (!result.success) throw new AggregateError(result.logs, "Daemon build failed");
