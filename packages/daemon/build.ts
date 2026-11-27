import { join } from "node:path";
import { browserAssets } from "./src/browser-listener";
import manifest from "./package.json";

export async function compileDaemon(
  outfile: string,
  version: string,
  target?: Bun.Build.CompileTarget,
) {
  const asset = await browserAssets();
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src/index.ts")],
    compile: { outfile, ...(target && { target }) },
    define: {
      KRAKA_BROWSER_JS: JSON.stringify(asset),
      KRAKA_RELEASE_VERSION: JSON.stringify(version),
    },
  });
  if (!result.success) throw new AggregateError(result.logs, "Daemon build failed");
}
if (import.meta.main)
  await compileDaemon(join(import.meta.dir, "../../.build/kraka"), manifest.version);
