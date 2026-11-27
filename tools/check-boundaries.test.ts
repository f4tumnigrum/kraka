import { describe, expect, test } from "bun:test";
import {
  findBoundaryViolations,
  hasRuntimeTranslatorImport,
  type ClientRuntimeCompilerOptions,
  type WorkspacePackage,
} from "./check-boundaries";

const validPackages: WorkspacePackage[] = [
  {
    name: "@kraka/protocol",
    kraka: {
      kind: "library",
      runtime: ["browser", "electron-main", "bun"],
      role: "protocol",
    },
  },
  {
    name: "@kraka/client-runtime",
    dependencies: {
      "@kraka/protocol": "workspace:*",
    },
    kraka: {
      kind: "library",
      runtime: ["browser", "electron-main", "bun"],
      role: "client-runtime",
    },
  },
  {
    name: "@kraka/environment",
    dependencies: {
      "@kraka/protocol": "workspace:*",
    },
    kraka: {
      kind: "library",
      runtime: ["bun"],
      role: "environment",
    },
  },
];

const adapterPackages: WorkspacePackage[] = [
  {
    name: "@kraka/adapter-acp",
    dependencies: {
      "@kraka/environment": "workspace:*",
      "@kraka/protocol": "workspace:*",
    },
    kraka: {
      kind: "library",
      runtime: ["bun"],
      role: "executor-adapter",
      executor: "Agent Client Protocol",
    },
  },
  {
    name: "@kraka/adapter-codex",
    dependencies: {
      "@kraka/environment": "workspace:*",
      "@kraka/protocol": "workspace:*",
    },
    kraka: { kind: "library", runtime: ["bun"], role: "executor-adapter", executor: "Codex" },
  },
  {
    name: "@kraka/adapter-antigravity",
    dependencies: {
      "@kraka/adapter-acp": "workspace:*",
      "@kraka/environment": "workspace:*",
      "@kraka/protocol": "workspace:*",
    },
    kraka: { kind: "library", runtime: ["bun"], role: "executor-adapter", executor: "Antigravity" },
  },
];

const clientRuntimeOptions: ClientRuntimeCompilerOptions = {
  lib: ["ES2022"],
  types: [],
};

describe("workspace package boundaries", () => {
  test("accepts the protocol and client-runtime dependency direction", () => {
    expect(findBoundaryViolations(validPackages, clientRuntimeOptions)).toEqual([]);
  });

  test("rejects an interface package that depends on an environment package", () => {
    const packages: WorkspacePackage[] = [
      ...validPackages,
      {
        name: "@kraka/web-interface",
        dependencies: {
          "@kraka/environment": "workspace:*",
          "@kraka/protocol": "workspace:*",
        },
        kraka: {
          kind: "application",
          runtime: ["browser"],
          role: "interface",
        },
      },
    ];

    expect(findBoundaryViolations(packages, clientRuntimeOptions)).toContain(
      "@kraka/web-interface may depend only on @kraka/protocol and @kraka/client-runtime. Found @kraka/environment.",
    );
  });

  test("rejects a command-line client that depends on the environment package", () => {
    const packages: WorkspacePackage[] = [
      ...validPackages,
      {
        name: "@kraka/cli-client",
        dependencies: {
          "@kraka/environment": "workspace:*",
          "@kraka/client-runtime": "workspace:*",
          "@kraka/protocol": "workspace:*",
        },
        kraka: {
          kind: "library",
          runtime: ["bun"],
          role: "cli-client",
        },
      },
    ];

    expect(findBoundaryViolations(packages, clientRuntimeOptions)).toContain(
      "@kraka/cli-client may depend only on @kraka/protocol and @kraka/client-runtime. Found @kraka/environment.",
    );
  });

  test("rejects a command-line source import of the environment package", () => {
    const packages: WorkspacePackage[] = [
      ...validPackages,
      {
        name: "@kraka/cli-client",
        dependencies: {
          "@kraka/client-runtime": "workspace:*",
          "@kraka/protocol": "workspace:*",
        },
        kraka: {
          kind: "library",
          runtime: ["bun"],
          role: "cli-client",
        },
      },
    ];

    expect(
      findBoundaryViolations(packages, clientRuntimeOptions, {
        "@kraka/cli-client": ["@kraka/environment"],
      }),
    ).toContain(
      "@kraka/cli-client source may import only @kraka/protocol and @kraka/client-runtime. Found @kraka/environment.",
    );
  });

  test("rejects DOM libraries in the client-runtime TypeScript project", () => {
    expect(
      findBoundaryViolations(validPackages, {
        ...clientRuntimeOptions,
        lib: ["ES2022", "DOM"],
      }),
    ).toContain("@kraka/client-runtime must compile without DOM libraries.");
  });

  test("allows Antigravity to share ACP transport and keeps other adapter packages independent", () => {
    expect(
      findBoundaryViolations([...validPackages, ...adapterPackages], clientRuntimeOptions, {
        "@kraka/adapter-antigravity": ["@kraka/adapter-acp"],
      }),
    ).toEqual([]);
  });

  test("rejects a peer adapter package dependency", () => {
    const packages = adapterPackages.map((manifest) =>
      manifest.name === "@kraka/adapter-codex"
        ? {
            ...manifest,
            dependencies: {
              ...manifest.dependencies,
              "@kraka/adapter-opencode": "workspace:*",
            },
          }
        : manifest,
    );

    expect(findBoundaryViolations([...validPackages, ...packages], clientRuntimeOptions)).toContain(
      "@kraka/adapter-codex must not depend on peer adapter packages. Found @kraka/adapter-opencode.",
    );
  });

  test("rejects a peer adapter package source import", () => {
    expect(
      findBoundaryViolations([...validPackages, ...adapterPackages], clientRuntimeOptions, {
        "@kraka/adapter-codex": ["@kraka/adapter-opencode"],
      }),
    ).toContain(
      "@kraka/adapter-codex source must not import peer adapter packages. Found @kraka/adapter-opencode.",
    );
  });

  test("permits only the declared ACP shared package as a peer dependency", () => {
    const packages = adapterPackages.map((manifest) =>
      manifest.name === "@kraka/adapter-antigravity"
        ? {
            ...manifest,
            dependencies: {
              ...manifest.dependencies,
              "@kraka/adapter-codex": "workspace:*",
            },
          }
        : manifest,
    );

    expect(findBoundaryViolations([...validPackages, ...packages], clientRuntimeOptions)).toContain(
      "@kraka/adapter-antigravity must not depend on peer adapter packages. Found @kraka/adapter-codex.",
    );
  });

  test("rejects runtime imports in an adapter translator", () => {
    expect(
      findBoundaryViolations([...validPackages, ...adapterPackages], clientRuntimeOptions, {}, [
        "@kraka/adapter-codex",
      ]),
    ).toContain("@kraka/adapter-codex/src/translate.ts may import types only.");
  });

  test("recognizes type-only imports while rejecting runtime forms", () => {
    expect(hasRuntimeTranslatorImport('import type { Frame } from "./native";')).toBe(false);
    expect(hasRuntimeTranslatorImport('import { normalize } from "./runtime";')).toBe(true);
    expect(hasRuntimeTranslatorImport('const runtime = await import("./runtime");')).toBe(true);
    expect(hasRuntimeTranslatorImport('const runtime = require("./runtime");')).toBe(true);
    expect(hasRuntimeTranslatorImport('export { normalize } from "./runtime";')).toBe(true);
    expect(hasRuntimeTranslatorImport('export type { NativeFrame } from "./native";')).toBe(false);
  });
});

test("only the browser host can compile with DOM and shared packages cannot import it", () => {
  const host: WorkspacePackage = {
    name: "@kraka/browser-host",
    kraka: { kind: "library", role: "interface", runtime: ["browser"] },
    dependencies: { "@kraka/protocol": "workspace:*", "@kraka/client-runtime": "workspace:*" },
  };
  const configs = { [host.name]: { lib: ["ES2022", "DOM"], types: [] } };
  expect(
    findBoundaryViolations([...validPackages, host], clientRuntimeOptions, {}, [], configs),
  ).toEqual([]);
  expect(
    findBoundaryViolations(
      [...validPackages, host],
      clientRuntimeOptions,
      { "@kraka/protocol": [host.name] },
      [],
      configs,
    ),
  ).toContain("@kraka/protocol must not import browser host types.");
  expect(
    findBoundaryViolations(validPackages, clientRuntimeOptions, {}, [], {
      "@kraka/protocol": { lib: ["DOM"] },
    }),
  ).toContain("@kraka/protocol must compile without DOM libraries.");
});
