import { Readable } from "node:stream";
import { chromium } from "playwright";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { terminate, within } from "./replay-process";
import * as v from "valibot";
const sock = "/fixture/mobile.sock";
let browser: Bun.Subprocess | undefined;
const exec = (args: string[]) => {
  const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode) throw Error(r.stderr.toString());
  return r.stdout.toString();
};
const ips = JSON.parse(exec(["ip", "-j", "-4", "addr"]));
const iface = v.parse(
  v.string(),
  ips.find((i: { addr_info: { local: string }[] }) =>
    i.addr_info.some((a) => a.local === "10.78.41.11"),
  )?.ifname,
);
const control = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://local");
    switch (url.pathname) {
      case "/copy": {
        if (browser) throw Error("Close the browser before copying a profile");
        const id = v.pipe(v.string(), v.uuid());
        const from = v.parse(id, url.searchParams.get("from")),
          to = v.parse(id, url.searchParams.get("to"));
        exec(["cp", "-a", join("/fixture/profiles", from), join("/fixture/profiles", to)]);
        break;
      }
      case "/launch": {
        if (browser) throw Error("Browser already running");
        const profile = v.parse(v.pipe(v.string(), v.uuid()), url.searchParams.get("profile"));
        const dir = join("/fixture/profiles", profile);
        await mkdir(dir, { recursive: true });
        exec(["chown", "pwuser:pwuser", dir]);
        browser = Bun.spawn(
          [
            "runuser",
            "-u",
            "pwuser",
            "--",
            chromium.executablePath(),
            "--headless",
            "--no-sandbox",
            "--no-first-run",
            "--disable-background-networking",
            "--disable-dev-shm-usage",
            `--user-data-dir=${dir}`,
            "--remote-debugging-port=9222",
            "about:blank",
          ],
          { stdout: "ignore", stderr: "pipe" },
        );
        const ready = Promise.withResolvers<void>();
        const lines = createInterface({
          input: Readable.fromWeb(browser.stderr as ReadableStream<Uint8Array>),
        });
        lines.on("line", (line) => {
          if (line.includes("DevTools listening on ws://")) ready.resolve();
        });
        lines.on("close", () => ready.reject(Error("Chromium exited before CDP")));
        await within(ready.promise, 5000, "Chromium DevTools endpoint");
        break;
      }
      case "/stop":
        if (browser) {
          await terminate(browser);
          browser = undefined;
        }
        break;
      case "/lan":
        exec(["ip", "link", "set", iface, "up"]);
        exec(["ip", "route", "replace", "10.78.41.0/24", "dev", iface, "src", "10.78.41.11"]);
        break;
      case "/routed":
        exec(["ip", "link", "set", iface, "down"]);
        exec(["ip", "route", "replace", "10.78.41.0/24", "via", "10.78.42.2"]);
        break;
      case "/disconnect":
        exec(["ip", "route", "del", "10.78.41.0/24", "via", "10.78.42.2"]);
        break;
      case "/route":
        res.end(exec(["ip", "-j", "route", "get", "10.78.41.10"]));
        return;
      default:
        res.writeHead(404);
        res.end();
        return;
    }
    res.end("ok");
  } catch (e) {
    res.writeHead(409);
    res.end(String(e));
  }
});
await rm(sock, { force: true });
control.listen(sock);
const proxy = Bun.spawn(
  ["socat", "UNIX-LISTEN:/fixture/cdp.sock,fork,unlink-early", "TCP:127.0.0.1:9222"],
  { stdout: "ignore", stderr: "inherit" },
);
await writeFile("/tmp/ready", "");
process.once("SIGTERM", () => {
  void (async () => {
    if (browser) await terminate(browser);
    await terminate(proxy);
    control.close();
  })();
});
