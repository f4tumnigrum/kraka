import { runCommand } from "./commands/registry";
export { parseInstalledCommand } from "./commands/installed-arguments";
export { listenReplay } from "./commands/replay";
export type { IdentityPort } from "./identity";
export { listenIdentity } from "./identity";
declare const KRAKA_DAEMON_ENTRY: boolean;
if ((typeof KRAKA_DAEMON_ENTRY !== "undefined" && KRAKA_DAEMON_ENTRY) || import.meta.main) {
  try {
    await runCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
