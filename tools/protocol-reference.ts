import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { toJsonSchemaDefs } from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";
import { REQUEST_METHODS, type RequestMethodDefinition, protocolSchemas } from "@kraka/protocol";

type ProtocolSchema = GenericSchema;

export type GeneratedReferenceFiles = Readonly<Record<string, string>>;

export function generateProtocolReference(
  schemas: Readonly<Record<string, ProtocolSchema>>,
  methods: readonly RequestMethodDefinition[] = [],
): GeneratedReferenceFiles {
  const entries = Object.entries(schemas).sort(([left], [right]) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
  const definitions = toJsonSchemaDefs(Object.fromEntries(entries), {
    target: "draft-2020-12",
    errorMode: "throw",
    ignoreActions: ["brand"],
    overrideSchema({ jsonSchema }) {
      // Draft 2020-12 forbids an empty prefixItems. items still constrains the whole array.
      if (jsonSchema.prefixItems?.length === 0) {
        const { prefixItems, ...schema } = jsonSchema;
        return schema;
      }
    },
  });
  const jsonSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: definitions,
  };
  const markdown = [
    "# Protocol reference",
    "",
    "Generated from `packages/protocol/src/schemas.ts`.",
    "",
    ...(methods.length
      ? [
          "## Client requests",
          "",
          "Supply a fresh public nonce in the upgrade query and verify its signed echo with the expected environment key. After a verified hello, authenticate and install the configuration for the same environment. Each signed business request requires an object grant and must fit the signer kind's ceiling. The environment resolves object ownership before accepting the request. A challenge belongs to one connection. Sequences increase within that challenge. Retries retain the business command ID.",
          "",
          "| Method | Required permission | Grant target |",
          "|---|---|---|",
          ...methods.map(
            ({ method, permission, additionalPermissions = [], target }) =>
              `| \`${method}\` | \`${[permission, ...additionalPermissions].join(" and ")}\` | ${target} |`,
          ),
          "",
          "Pairing and authentication exchange proofs before an authorized session exists. Replies, flow windows and subscription pages belong to that connection or its already authorized stream.",
          "",
          "A binary content message contains a four-byte unsigned big-endian JSON-header length, that many UTF-8 header bytes, and the raw chunk in the same WebSocket message. Validate the header and the remaining payload length before accepting the chunk. Other messages carry the frame header as JSON text. Use transport.content for oversized JSON: its authorized connection opens a nonzero stream for chunks of one logical message. Reassemble the declared byte length, then strictly decode the original message and enforce its own signature and object permissions before dispatch. Reserve stream zero for control. Subscription data retains its own flow budget.",
          "",
        ]
      : []),
    ...(entries.length === 0
      ? ["No protocol schemas are registered yet."]
      : entries.flatMap(([name]) => [
          `## ${name}`,
          "",
          "```json",
          JSON.stringify(definitions[name], null, 2),
          "```",
          "",
        ])),
  ].join("\n");

  return {
    "index.md": `${markdown.trimEnd()}\n`,
    "protocol.schema.json": `${JSON.stringify(jsonSchema, null, 2)}\n`,
  };
}

export function findStaleReferenceFiles(
  generated: GeneratedReferenceFiles,
  existing: Readonly<Record<string, string | undefined>>,
): string[] {
  const stale: string[] = [];
  for (const [path, content] of Object.entries(generated)) {
    if (existing[path] !== content) {
      stale.push(path);
    }
  }
  return stale;
}

async function readTextOrMissing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const outputDirectory = resolve(import.meta.dir, "../docs/generated/protocol");
  const generated = generateProtocolReference(protocolSchemas, Object.values(REQUEST_METHODS));
  const checkOnly = process.argv.includes("--check");
  const existing: Record<string, string | undefined> = {};

  for (const path of Object.keys(generated)) {
    existing[path] = await readTextOrMissing(join(outputDirectory, path));
  }

  const stale = findStaleReferenceFiles(generated, existing);
  if (checkOnly) {
    if (stale.length > 0) {
      console.error(
        `Generated protocol files are stale. Run 'bun run protocol:reference'. Stale files: ${stale.join(", ")}.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log("Generated protocol files match their schemas.");
    return;
  }

  await mkdir(outputDirectory, { recursive: true });
  for (const [path, content] of Object.entries(generated)) {
    await writeFile(join(outputDirectory, path), content);
  }
  console.log(`Generated protocol reference files in ${outputDirectory}.`);
}

if (import.meta.main) {
  await main();
}
