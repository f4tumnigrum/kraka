import { appendFileSync } from "node:fs";
const file = process.env.KRAKA_OPENER_RECORD;
const [url, ...other] = Bun.argv.slice(2);
if (!file || !url || other.length) throw Error("Expected one browser URL");
appendFileSync(file, JSON.stringify(url) + "\n");
