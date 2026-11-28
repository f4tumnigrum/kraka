import * as v from "valibot";
import { DESKTOP_IPC, type DesktopBridge } from "@kraka/protocol";

export type DesktopMethod = keyof DesktopBridge;
type Sender = { sender: object; senderFrame: { url: string } | null };
type WindowSource = { contents: object; mainFrame: object; url: string };
export function dispatchDesktop<K extends DesktopMethod>(
  method: K,
  event: Sender,
  source: WindowSource | null,
  raw: unknown,
  bridge: Pick<DesktopBridge, K>,
) {
  if (
    !source ||
    event.sender !== source.contents ||
    !event.senderFrame ||
    event.senderFrame !== source.mainFrame ||
    event.senderFrame.url !== source.url
  )
    throw Error("Untrusted desktop window");

  const contract = DESKTOP_IPC[method];
  const input = v.parse(contract.input, raw);
  return Promise.resolve((bridge[method] as (value: typeof input) => Promise<unknown>)(input)).then(
    (result) => v.parse(contract.result, result),
  );
}

type Instance = { instanceId: string; pid: number };
export async function localEnvironment(
  action: Parameters<DesktopBridge["localEnvironment"]>[0]["action"],
  current: Instance | null,
  owned: { instance: Instance; stop(): Promise<void> } | null,
  start: () => ReturnType<DesktopBridge["localEnvironment"]>,
): ReturnType<DesktopBridge["localEnvironment"]> {
  if (!current) return action === "start" ? start() : "stopped";
  if (
    !owned ||
    owned.instance.instanceId !== current.instanceId ||
    owned.instance.pid !== current.pid
  )
    return "externallyOwned";
  if (action === "stopOwned") {
    await owned.stop();
    return "stopped";
  }
  return "running";
}
