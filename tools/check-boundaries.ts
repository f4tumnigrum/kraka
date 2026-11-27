import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as v from "valibot";

const dependencyMapSchema = v.optional(v.record(v.string(), v.string()));
const workspacePackageSchema = v.object({
  name: v.string(),
  dependencies: dependencyMapSchema,
  devDependencies: dependencyMapSchema,
  peerDependencies: dependencyMapSchema,
  kraka: v.object({
    kind: v.picklist(["application", "library"]),
    runtime: v.array(v.string()),
    role: v.string(),
    executor: v.optional(v.string()),
  }),
});
const clientRuntimeConfigSchema = v.object({
  compilerOptions: v.object({
    lib: v.optional(v.array(v.string())),
    types: v.optional(v.array(v.string())),
  }),
});

export type WorkspacePackage = v.InferOutput<typeof workspacePackageSchema>;
export type ClientRuntimeCompilerOptions = v.InferOutput<
  typeof clientRuntimeConfigSchema
>["compilerOptions"];

const uiFrameworkNames = new Set([
  "@angular/core",
  "@chakra-ui/react",
  "@emotion/react",
  "@mui/material",
  "@radix-ui/react",
  "@types/react",
  "@types/react-dom",
  "lit",
  "preact",
  "react",
  "react-dom",
  "solid-js",
  "svelte",
  "vue",
]);

function allDependencies(manifest: WorkspacePackage): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
}

function workspaceDependencies(manifest: WorkspacePackage): string[] {
  return allDependencies(manifest).filter((name) => name.startsWith("@kraka/"));
}

export function findBoundaryViolations(
  packages: readonly WorkspacePackage[],
  compilerOptions: ClientRuntimeCompilerOptions,
  sourceImports: Readonly<Record<string, readonly string[]>> = {},
  translatorRuntimeImports: readonly string[] = [],
  packageConfigs: Readonly<Record<string, ClientRuntimeCompilerOptions>> = {},
): string[] {
  const violations: string[] = [];
  const packageNames = new Set(packages.map((manifest) => manifest.name));
  const protocolPackage = packages.find((manifest) => manifest.kraka.role === "protocol");
  const clientRuntime = packages.find((manifest) => manifest.kraka.role === "client-runtime");
  const environment = packages.find((manifest) => manifest.kraka.role === "environment");

  for (const manifest of packages) {
    const browser = manifest.name === "@kraka/browser-host";
    const config = packageConfigs[manifest.name];
    if (
      browser &&
      (manifest.kraka.role !== "interface" ||
        manifest.kraka.kind !== "library" ||
        manifest.kraka.runtime.join() !== "browser" ||
        !config?.lib?.includes("DOM") ||
        config.types?.length)
    ) {
      violations.push("The browser host must be a browser-only interface library with DOM types.");
    }
    if (!browser && config?.lib?.some((lib) => lib.toLowerCase().includes("dom")))
      violations.push(`${manifest.name} must compile without DOM libraries.`);
    if (
      !browser &&
      (workspaceDependencies(manifest).includes("@kraka/browser-host") ||
        sourceImports[manifest.name]?.includes("@kraka/browser-host"))
    ) {
      violations.push(`${manifest.name} must not import browser host types.`);
    }
    if (manifest.kraka.runtime.length === 0) {
      violations.push(`${manifest.name} must declare a runtime.`);
    }
    for (const dependency of workspaceDependencies(manifest)) {
      if (!packageNames.has(dependency)) {
        violations.push(`${manifest.name} depends on unknown workspace package ${dependency}.`);
      }
    }
    if (manifest.kraka.role === "interface" || manifest.kraka.role === "cli-client") {
      const allowed = new Set(["@kraka/client-runtime", "@kraka/protocol"]);
      const forbidden = workspaceDependencies(manifest).filter((name) => !allowed.has(name));
      if (forbidden.length > 0) {
        violations.push(
          `${manifest.name} may depend only on @kraka/protocol and @kraka/client-runtime. Found ${forbidden.join(", ")}.`,
        );
      }
      const forbiddenImports = (sourceImports[manifest.name] ?? []).filter(
        (name) => name !== manifest.name && packageNames.has(name) && !allowed.has(name),
      );
      if (forbiddenImports.length > 0) {
        violations.push(
          `${manifest.name} source may import only @kraka/protocol and @kraka/client-runtime. Found ${forbiddenImports.join(", ")}.`,
        );
      }
    }

    if (manifest.kraka.role === "executor-adapter") {
      const adapterDependencies = workspaceDependencies(manifest).filter((name) =>
        name.startsWith("@kraka/adapter-"),
      );
      const allowed = new Set(
        manifest.kraka.executor === "Antigravity" ? ["@kraka/adapter-acp"] : [],
      );
      const forbiddenDependencies = adapterDependencies.filter((name) => !allowed.has(name));
      if (forbiddenDependencies.length > 0) {
        violations.push(
          `${manifest.name} must not depend on peer adapter packages. Found ${forbiddenDependencies.join(", ")}.`,
        );
      }

      const forbiddenImports = (sourceImports[manifest.name] ?? [])
        .filter((name) => name.startsWith("@kraka/adapter-") && name !== manifest.name)
        .filter((name) => !allowed.has(name));
      if (forbiddenImports.length > 0) {
        violations.push(
          `${manifest.name} source must not import peer adapter packages. Found ${forbiddenImports.join(", ")}.`,
        );
      }

      if (translatorRuntimeImports.includes(manifest.name)) {
        violations.push(`${manifest.name}/src/translate.ts may import types only.`);
      }
    }
  }

  if (protocolPackage && workspaceDependencies(protocolPackage).length > 0) {
    violations.push("@kraka/protocol must not depend on another workspace package.");
  }

  if (clientRuntime) {
    const forbiddenWorkspaceDependencies = workspaceDependencies(clientRuntime).filter(
      (name) => name !== "@kraka/protocol",
    );
    if (forbiddenWorkspaceDependencies.length > 0) {
      violations.push(
        `@kraka/client-runtime may depend only on @kraka/protocol. Found ${forbiddenWorkspaceDependencies.join(", ")}.`,
      );
    }

    const forbiddenFrameworks = allDependencies(clientRuntime).filter((name) =>
      uiFrameworkNames.has(name),
    );
    if (forbiddenFrameworks.length > 0) {
      violations.push(
        `@kraka/client-runtime must not depend on interface frameworks. Found ${forbiddenFrameworks.join(", ")}.`,
      );
    }

    const libraries = compilerOptions.lib ?? [];
    if (libraries.some((library) => library.toLowerCase().includes("dom"))) {
      violations.push("@kraka/client-runtime must compile without DOM libraries.");
    }
    if ((compilerOptions.types ?? []).length > 0) {
      violations.push("@kraka/client-runtime must compile without ambient type packages.");
    }
  }

  if (
    environment &&
    workspaceDependencies(environment).some((name) => name.startsWith("@kraka/adapter-"))
  ) {
    violations.push("@kraka/environment must not depend on executor-adapter packages.");
  }

  return violations;
}

function parseJson<TSchema extends v.GenericSchema>(
  schema: TSchema,
  source: string,
  path: string,
): v.InferOutput<TSchema> {
  const raw: unknown = JSON.parse(source);
  const parsed = v.safeParse(schema, raw);
  if (!parsed.success) {
    const messages = parsed.issues.map((issue) => issue.message).join(" ");
    throw new Error(`Invalid workspace configuration at ${path}. ${messages}`);
  }
  return parsed.output;
}

async function loadWorkspacePackage(path: string): Promise<WorkspacePackage> {
  const source = await readFile(path, "utf8");
  return parseJson(workspacePackageSchema, source, path);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

async function packageSourceImports(
  packageName: string,
  packageDirectory: string,
  workspaceDirectories: ReadonlyMap<string, string>,
): Promise<string[]> {
  const imports = new Set<string>();
  const paths = await sourceFiles(join(packageDirectory, "src"));
  const expression = /\b(?:from\s*|(?:import|require)\s*\(\s*|import\s*)["']([^"']+)["']/g;

  for (const path of paths) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(expression)) {
      const specifier = match[1];
      if (!specifier) continue;
      if (specifier.startsWith("@kraka/")) {
        const importedPackage = [...workspaceDirectories.keys()].find(
          (name) => specifier === name || specifier.startsWith(`${name}/`),
        );
        if (importedPackage) imports.add(importedPackage);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const importedPath = resolve(dirname(path), specifier);
      for (const [name, directory] of workspaceDirectories) {
        const relativePath = relative(directory, importedPath);
        if (
          !isAbsolute(relativePath) &&
          relativePath !== ".." &&
          !relativePath.startsWith(`..${sep}`)
        ) {
          imports.add(name);
        }
      }
    }
  }

  imports.delete(packageName);
  return [...imports];
}

export function hasRuntimeTranslatorImport(source: string): boolean {
  const moduleDeclarations = source.match(/^\s*(?:import|export)\b[^\n]*/gm) ?? [];
  return (
    moduleDeclarations.some((statement) =>
      /^\s*import\b/.test(statement)
        ? !/^\s*import\s+type\b/.test(statement)
        : /\bfrom\s*["']/.test(statement) && !/^\s*export\s+type\b/.test(statement),
    ) ||
    /\b(?:await\s+)?import\s*\(/.test(source) ||
    /\brequire\s*\(/m.test(source)
  );
}

async function readTranslatorSource(packageDirectory: string): Promise<string> {
  try {
    return await readFile(join(packageDirectory, "src/translate.ts"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

async function main(): Promise<void> {
  const rootDirectory = resolve(process.argv[2] ?? resolve(import.meta.dir, ".."));
  const packagesDirectory = join(rootDirectory, "packages");
  const packageDirectories = await readdir(packagesDirectory, { withFileTypes: true });
  const loadedPackages = await Promise.all(
    packageDirectories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = join(packagesDirectory, entry.name);
        const manifest = await loadWorkspacePackage(join(directory, "package.json"));
        return { directory, manifest };
      }),
  );
  const packages = loadedPackages.map(({ manifest }) => manifest);
  const workspaceDirectories = new Map(
    loadedPackages.map(({ directory, manifest }) => [manifest.name, directory]),
  );
  const sourceImports: Record<string, readonly string[]> = {};
  const translatorRuntimeImports: string[] = [];
  const rootConfigPath = join(rootDirectory, "tsconfig.json");
  const sharedConfig = parseJson(
    clientRuntimeConfigSchema,
    await readFile(rootConfigPath, "utf8"),
    rootConfigPath,
  ).compilerOptions;
  const packageConfigs: Record<string, ClientRuntimeCompilerOptions> = {};
  for (const { directory, manifest } of loadedPackages) {
    sourceImports[manifest.name] = await packageSourceImports(
      manifest.name,
      directory,
      workspaceDirectories,
    );
    packageConfigs[manifest.name] = sharedConfig;
    const configPath = join(directory, "tsconfig.json");
    try {
      packageConfigs[manifest.name] = {
        ...sharedConfig,
        ...parseJson(clientRuntimeConfigSchema, await readFile(configPath, "utf8"), configPath)
          .compilerOptions,
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (manifest.kraka.role === "executor-adapter") {
      const translatorSource = await readTranslatorSource(directory);
      if (hasRuntimeTranslatorImport(translatorSource))
        translatorRuntimeImports.push(manifest.name);
    }
  }
  const configPath = join(rootDirectory, "packages/client-runtime/tsconfig.json");
  const configSource = await readFile(configPath, "utf8");
  const config = parseJson(clientRuntimeConfigSchema, configSource, configPath);
  const violations = findBoundaryViolations(
    packages,
    config.compilerOptions,
    sourceImports,
    translatorRuntimeImports,
    packageConfigs,
  );

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(violation);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Workspace package boundaries are valid.");
}

if (import.meta.main) {
  await main();
}
