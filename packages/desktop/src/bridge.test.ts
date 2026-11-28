import { test, expect } from "bun:test";
import { dispatchDesktop, localEnvironment } from "./bridge";

test("only the registered window's current top frame can invoke a method", async () => {
  const contents = {},
    frame = { url: "file:///installed/thread.html" };
  const source = { contents, mainFrame: frame, url: frame.url };
  let calls = 0;
  const bridge = {
    async connectRoute() {
      calls++;
      return "ready" as const;
    },
  };
  const input = { environmentId: "e", routeId: "saved" };
  for (const event of [
    { sender: {}, senderFrame: frame },
    { sender: contents, senderFrame: { ...frame } },
    { sender: contents, senderFrame: null },
  ])
    expect(() => dispatchDesktop("connectRoute", event, source, input, bridge)).toThrow();
  const trusted = { sender: contents, senderFrame: frame };
  expect(() => dispatchDesktop("connectRoute", trusted, null, input, bridge)).toThrow();
  expect(() =>
    dispatchDesktop("connectRoute", trusted, { ...source, url: "file:///foreign" }, input, bridge),
  ).toThrow();
  expect(() =>
    dispatchDesktop(
      "connectRoute",
      trusted,
      source,
      { ...input, url: "https://elsewhere" },
      bridge,
    ),
  ).toThrow();
  expect(calls).toBe(0);
  expect(await dispatchDesktop("connectRoute", trusted, source, input, bridge)).toBe("ready");
  expect(calls).toBe(1);
  const invalidResult = { connectRoute: async () => JSON.parse("42") };
  await expect(
    dispatchDesktop("connectRoute", trusted, source, input, invalidResult),
  ).rejects.toThrow();
});

test("stopOwned retains an independent daemon even after a PID is reused", async () => {
  let stops = 0,
    starts = 0;
  const instance = { pid: 42, instanceId: "a" },
    owned = {
      instance,
      stop: async () => {
        stops++;
      },
    };
  const start = async () => {
    starts++;
    return "running" as const;
  };
  expect(await localEnvironment("stopOwned", instance, null, start)).toBe("externallyOwned");
  expect(await localEnvironment("stopOwned", { ...instance, instanceId: "b" }, owned, start)).toBe(
    "externallyOwned",
  );
  expect([starts, stops]).toEqual([0, 0]);
  expect(await localEnvironment("stopOwned", instance, owned, start)).toBe("stopped");
  expect([starts, stops]).toEqual([0, 1]);
});
