import { parseInstalledCommand } from "./installed-arguments";
import { identityCommand } from "@kraka/cli-client";
import { readInstancePublication } from "@kraka/environment";
export async function run(args: string[]) {
  const parsed = parseInstalledCommand("identity", args);
  const signal = AbortSignal.timeout(90_000);
  const publication = await readInstancePublication(parsed.stateDir);
  if (!publication) throw Error("Environment is unavailable");
  process.stdout.write(
    JSON.stringify(await identityCommand(publication.environmentId, publication.endpoint, signal)) +
      "\n",
  );
}
