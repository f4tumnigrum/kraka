export {};
const [control, ...argv] = process.argv.slice(2);
if (!control) throw Error("Missing fixture controller");
const overrides = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
].filter((key) => process.env[key] !== undefined);
const answer = await fetch(control, {
  method: "POST",
  body: JSON.stringify({ argv, overrides }),
});
if (!answer.ok) process.exit(1);
process.stderr.write("synthetic-gh-private-diagnostic\n");
process.stdout.write(await answer.text());
