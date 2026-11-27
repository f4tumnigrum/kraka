import { chromium } from "playwright";

const selected = process.env.KRAKA_BROWSER ?? "chrome";
if (selected !== "chrome" && selected !== "chromium")
  throw Error("Expected KRAKA_BROWSER=chrome or chromium");
if (selected === "chromium" && process.env.CI !== "true")
  throw Error("Playwright Chromium is reserved for CI. Use the installed Google Chrome locally.");

const options = selected === "chrome" ? { channel: "chrome", headless: true } : { headless: true };

export function launchBrowserProfile(profileDir: string) {
  return chromium.launchPersistentContext(profileDir, options);
}

export async function nativeBrowserSkipReason(): Promise<string | undefined> {
  if (selected !== "chrome") return;
  try {
    const browser = await chromium.launch(options);
    await browser.close();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Chromium distribution 'chrome' is not found")
    )
      return "本机未安装系统 Google Chrome，跳过浏览器用例";
    throw error;
  }
}

export const routedEnabled = process.env.CI === "true" && process.env.KRAKA_BROWSER_ROUTED === "1";
export const routedSkipReason = "双子网浏览器用例只在 CI 的 routed 作业运行";

export function requireRoutedBrowser() {
  if (!routedEnabled) throw Error(routedSkipReason);
}
