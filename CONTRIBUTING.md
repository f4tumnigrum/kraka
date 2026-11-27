# Contributing

## Development environment

Use Bun 1.4.5 from the workspace root. Install the versions in `bun.lock`.

```sh
bun install --frozen-lockfile
```

## Checks

Run every check before you submit a change.

```sh
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun run protocol:reference:check
```

Run `bun run protocol:reference` after you change a protocol schema. Do not edit files under `docs/generated/protocol/` by hand.

## Merge

Automation merges a change after all required CI checks pass. Human approval is not a merge gate.
