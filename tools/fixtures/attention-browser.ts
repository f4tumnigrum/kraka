import { chromium, type BrowserContext, type Page } from "playwright";
import type { ListReading } from "../../packages/client-runtime/src";
import { join } from "node:path";
import { within } from "./replay-process";
import type { threadFixture } from "./thread-resume";
export type AttentionFixture = Parameters<Parameters<typeof threadFixture>[0]>[0];

const html = `<!DOCTYPE html><html><body><main></main><script type="module">
import {openBrowserList} from "./reader.js";
const main=document.querySelector("main");
function draw(read){
  if(!read){ main.replaceChildren();return; }
  main.dataset.head=read.head.through;
  main.replaceChildren(...read.rows.map(row=>{
    const section=document.createElement("section");
    section.dataset.thread=row.summary.threadId;
    const title=document.createElement("h2");title.textContent=row.summary.title;
    const state=document.createElement("output");state.textContent=row.state;
    section.append(title,state);
    for(const request of row.requests){
      const button=document.createElement("button");
      button.textContent=request.kind;
      button.dataset.request=request.key.object.requestId;
      button.disabled=!request.actionable;
      section.append(button);
    }
    return section;
  }));
}
window.list=await openBrowserList({...window.input,sign:window.sign,installed(read){ draw(read);window.published(read); },changed:draw,fail(error){window.failed(String(error));}});
</script></body></html>`;

export async function browserProfiles(
  f: AttentionFixture,
  run: (
    profiles: { page: Page; at: (position: string) => Promise<ListReading> }[],
  ) => Promise<void>,
) {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../packages/browser-host/src/thread-list.ts")],
    target: "browser",
  });
  if (!build.success || !build.outputs[0])
    throw Error("Browser list build failed: " + build.logs.join("\n"));
  const script = await build.outputs[0].text(),
    url = new URL(f.f.endpoint.replace("ws:", "http:"));
  await Bun.write(join(f.stateDir, "attention-page.html"), html);
  await Bun.write(join(f.stateDir, "attention-reader.js"), script);
  const browser = await chromium.launch({
    ...(process.env.KRAKA_REQUIRED_ATTENTION_CASES === "1" ? {} : { channel: "chrome" }),
    headless: true,
  });
  const contexts: BrowserContext[] = [];
  try {
    const profiles = [];
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      const ctx = await browser.newContext({ viewport });
      contexts.push(ctx);
      const page = await ctx.newPage();
      const device = f.pairing.clients[0]!;
      const input = {
        projectId: f.pairing.projectId,
        registration: {
          identity: f.pairing.identity,
          principal: device.principal,
          deviceId: device.device.deviceId,
          keyId: device.device.keyId,
        },
      };
      await page.addInitScript((input) => Object.assign(globalThis, { input }), input);
      const readings = new Map<string, ListReading>(),
        signals = new Map<string, ReturnType<typeof Promise.withResolvers<ListReading>>>();
      const errored = Promise.withResolvers<never>();
      void errored.promise.catch(() => {});
      page.on("pageerror", errored.reject);
      await page.exposeFunction("failed", (e: string) => errored.reject(Error(e)));
      await page.exposeFunction("sign", device.device.sign);
      await page.exposeFunction("published", (read: ListReading) => {
        readings.set(read.head.through, read);
        signals.get(read.head.through)?.resolve(read);
      });
      await page.goto(url.origin + "/attention");
      profiles.push({
        page,
        async at(position: string) {
          const cached = readings.get(position);
          if (cached) return cached;
          const signal = signals.get(position) ?? Promise.withResolvers<ListReading>();
          signals.set(position, signal);
          return within(
            Promise.race([signal.promise, errored.promise]),
            10000,
            "browser installed " + position,
          );
        },
      });
    }
    await run(profiles);
  } finally {
    try {
      await Promise.all(contexts.map((ctx) => ctx.close()));
    } finally {
      await browser.close();
    }
  }
}
