import { installArtifact, readArtifact } from "../package-release";
const [archive, prefix] = Bun.argv.slice(2);
if (!archive || !prefix || !process.send)
  throw Error("Expected installer fixture arguments and IPC");
await installArtifact(await readArtifact(archive), prefix, async () => {
  process.send?.("verified");
  await new Promise<void>(() => process.once("disconnect", () => process.exit(1)));
});
