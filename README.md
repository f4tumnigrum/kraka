# kraka

kraka is a workspace for operating external coding agents through a local environment daemon and clients.

Use `kraka` as the configuration directory name. Use `kraka://` for application links.

## Package map

| Package                      | Kind        | Runtime                     | Workspace dependencies                                                             | Responsibility                                                                         |
| ---------------------------- | ----------- | --------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@kraka/protocol`            | Library     | Browser, Electron main, Bun | None                                                                               | Shared wire schemas and protocol-reference generation.                                 |
| `@kraka/client-runtime`      | Library     | Browser, Electron main, Bun | `@kraka/protocol`                                                                  | Client-local state, connections, authorization, synchronization, and offline delivery. |
| `@kraka/environment`         | Library     | Bun                         | `@kraka/protocol`                                                                  | Environment state and the internal executor-adapter contract.                          |
| `@kraka/cli-client`          | Library     | Bun                         | `@kraka/client-runtime`, `@kraka/protocol`                                         | Command-line client operations through the client runtime and protocol.                |
| `@kraka/daemon`              | Application | Bun                         | `@kraka/environment`, `@kraka/cli-client`, `@kraka/protocol`, all adapter packages | Environment startup, the `kraka` command, and same-origin static client files.         |
| `@kraka/desktop`             | Application | Electron main               | `@kraka/client-runtime`, `@kraka/protocol`                                         | Electron main-process shell.                                                           |
| `@kraka/adapter-codex`       | Library     | Bun                         | `@kraka/environment`, `@kraka/protocol`                                            | Codex transport and native-event conversion.                                           |
| `@kraka/adapter-claude-code` | Library     | Bun                         | `@kraka/environment`, `@kraka/protocol`                                            | Claude Code transport and native-event conversion.                                     |
| `@kraka/adapter-opencode`    | Library     | Bun                         | `@kraka/environment`, `@kraka/protocol`                                            | OpenCode transport and native-event conversion.                                        |
| `@kraka/adapter-pi`          | Library     | Bun                         | `@kraka/environment`, `@kraka/protocol`                                            | Pi transport and native-event conversion.                                              |
| `@kraka/adapter-antigravity` | Library     | Bun                         | `@kraka/adapter-acp`, `@kraka/environment`, `@kraka/protocol`                      | Antigravity event conversion over the shared ACP transport boundary.                   |
| `@kraka/adapter-acp`         | Library     | Bun                         | `@kraka/environment`, `@kraka/protocol`                                            | Shared ACP transport declarations and generic ACP event conversion.                    |
| `@kraka/adapter-replay`      | Library     | Bun                         | `@kraka/environment`, `@kraka/protocol`                                            | Recorded events for replay mode.                                                       |

The browser runtime also runs in the Electron renderer. Interface code is maintained outside this workspace and depends on `@kraka/protocol` and `@kraka/client-runtime`.

## Install

Use Bun 1.4.5. Install the locked dependencies from the workspace root.

```sh
bun install --frozen-lockfile
```

## Check

Run the full local check set before merging.

```sh
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun run protocol:reference:check
```

## Protocol reference

Add protocol schemas to `packages/protocol/src/schemas.ts`. Generate the JSON Schema and Markdown reference with one command.

```sh
bun run protocol:reference
```

Generated files live in `docs/generated/protocol/`. Regenerate them after changing a schema. CI checks that the generated files match the schemas.
