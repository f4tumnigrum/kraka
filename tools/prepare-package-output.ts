import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve(import.meta.dir, "../.build/packages");
try {
  mkdirSync(directory, { recursive: true });
} catch (error) {
  // Bun on Windows can report EEXIST even for a recursive mkdir.
  if (
    !(error instanceof Error && "code" in error && error.code === "EEXIST") ||
    !statSync(directory).isDirectory()
  )
    throw error;
}
