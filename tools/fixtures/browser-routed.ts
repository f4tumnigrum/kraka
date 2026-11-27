import { createServer, connect } from "node:net";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
export async function mobile(path: string) {
  const response = await fetch("http://localhost" + path, { unix: "/fixture/mobile.sock" });
  const body = await response.text();
  if (!response.ok) throw Error(body);
  return body;
}
export async function routedBrowser(profileDir: string) {
  await mkdir(profileDir, { recursive: true });
  const pointer = join(profileDir, "mobile-profile");
  try {
    await writeFile(pointer, crypto.randomUUID(), { flag: "wx" });
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
  }
  let profile = await readFile(pointer, "utf8");
  const proxy = createServer((socket) => {
    const dest = connect("/fixture/cdp.sock");
    dest.pipe(socket).pipe(dest);
    socket.on("error", () => dest.destroy());
    dest.on("error", () => socket.destroy());
    socket.on("close", () => dest.destroy());
    dest.on("close", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const addr = proxy.address();
  if (!addr || typeof addr === "string") throw Error("CDP proxy bind failed");
  const url = "http://127.0.0.1:" + addr.port;
  await mobile("/lan");
  return {
    async forkProfile() {
      const next = crypto.randomUUID();
      await mobile("/copy?from=" + profile + "&to=" + next);
      profile = next;
    },
    async launch() {
      await mobile("/launch?profile=" + profile);
      const browser = await chromium.connectOverCDP(url);
      const context = browser.contexts()[0];
      if (!context) throw Error("Missing mobile profile");
      return {
        context,
        async close() {
          await browser.close();
          await mobile("/stop");
        },
      };
    },
    async close() {
      try {
        await mobile("/stop");
        await mobile("/lan");
      } finally {
        await new Promise<void>((resolve, reject) =>
          proxy.close((e) => (e ? reject(e) : resolve())),
        );
      }
    },
  };
}
