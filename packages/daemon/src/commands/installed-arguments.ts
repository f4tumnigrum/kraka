import { parseArgs } from "node:util";
import { resolve } from "node:path";
type InstalledCommand =
  | { kind: "identity"; stateDir: string }
  | { kind: "foreground"; stateDir: string; action: "print" | "open" }
  | { kind: "writer"; stateDir: string; recording: string | null };
export function parseInstalledCommand(
  command: "identity",
  args: string[],
): Extract<InstalledCommand, { kind: "identity" }>;
export function parseInstalledCommand(
  command: "start",
  args: string[],
): Exclude<InstalledCommand, { kind: "identity" }>;
export function parseInstalledCommand(
  command: "identity" | "start",
  args: string[],
): InstalledCommand;
export function parseInstalledCommand(
  command: "identity" | "start",
  args: string[],
): InstalledCommand {
  if (command === "identity") {
    const { values } = parseArgs({
      args,
      options: { "state-dir": { type: "string" }, json: { type: "boolean" } },
      allowPositionals: false,
    });
    if (!values["state-dir"] || !values.json)
      throw Error("Expected identity --state-dir DIR --json");
    return { kind: "identity", stateDir: resolve(values["state-dir"]) };
  }
  const { values } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      recording: { type: "string" },
      "local-owner": { type: "boolean" },
      "print-pairing": { type: "boolean" },
      "open-browser": { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (!values["state-dir"])
    throw Error("Expected start --state-dir DIR [--print-pairing | --open-browser]");
  const stateDir = resolve(values["state-dir"]);
  if (
    [
      values.recording,
      values["local-owner"],
      values["print-pairing"],
      values["open-browser"],
    ].filter((value) => value !== undefined).length > 1
  )
    throw Error("Choose one startup mode");
  if (values.recording !== undefined || values["local-owner"])
    return { kind: "writer", stateDir, recording: values.recording ?? null };
  return { kind: "foreground", stateDir, action: values["open-browser"] ? "open" : "print" };
}
