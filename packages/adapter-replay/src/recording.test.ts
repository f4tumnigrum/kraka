import { expect, test } from "bun:test";
import probe from "../../../fixtures/executors/replay/echoes-a-host-probe.jsonl" with {
  type: "text",
};

test("loads the embedded replay probe as unchanged JSONL text", async () => {
  const source = Bun.file(
    new URL("../../../fixtures/executors/replay/echoes-a-host-probe.jsonl", import.meta.url),
  );
  expect(probe).toBe(await source.text());
});
