import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

if (process.env.CI !== "true") throw Error("Electron 只在 CI 运行");
const require = createRequire(join(import.meta.dir, "../../packages/desktop/package.json"));
const dir = dirname(require.resolve("electron/package.json"));
if (require("electron/package.json").version !== "38.0.0")
  throw Error("Unexpected locked Electron version");
const env = { ...process.env };
delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
execFileSync(process.execPath, [join(dir, "install.js")], { env, stdio: "inherit" });
const binary = join(dir, "dist", readFileSync(join(dir, "path.txt"), "utf8").trim());
const version = readFileSync(join(dir, "dist", "version"), "utf8")
  .trim()
  .replace(/^v/, "");
if (version !== "38.0.0" || !statSync(binary).isFile())
  throw Error("Unexpected extracted Electron runtime");
console.info("Installed Electron " + version);
