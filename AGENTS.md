# Agent instructions

Use paths and commands that exist in this repository. Keep generated protocol files in sync with their Valibot schemas by running `bun run protocol:reference`.

Keep client-local state in `@kraka/client-runtime`. Keep environment state in `@kraka/environment`. Put shared wire schemas in `@kraka/protocol`.

The client runtime has no DOM types or interface-framework dependencies. Interface packages may depend only on `@kraka/protocol` and `@kraka/client-runtime`. Keep `@kraka/protocol` independent of other workspace packages.

The command-line client lives in `packages/cli-client/`. Keep its workspace dependencies limited to `@kraka/protocol` and `@kraka/client-runtime`. Do not import `@kraka/environment` from command-line client code.

The environment owns executor delivery IDs, attempts, todo state, native-session bindings, and capability snapshots. Each adapter implements the five calls in `packages/environment/src/adapter-contract.ts`. Keep each adapter's `src/translate.ts` pure and limited to type-only imports. Adapter packages must not depend on peer adapters. `@kraka/adapter-antigravity` may use the shared ACP transport in `@kraka/adapter-acp`.

Adapter packages may depend on `@kraka/environment` and `@kraka/protocol`. They may not import peer adapters. `@kraka/adapter-antigravity` may also use the shared ACP transport from `@kraka/adapter-acp`.

Run all required checks before an automated merge.

```sh
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun run protocol:reference:check
```

CI is the merge gate. Automation merges only when every required check passes. Human review is not required for a merge.
