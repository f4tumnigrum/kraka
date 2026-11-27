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

### Performance budgets

Run `bun run perf` on the reference machine (Apple M2, 16 GiB, macOS 26.2). It exits nonzero for an invalid measurement or an absolute budget breach. To select a workload, use a metric ID, for example `bun run perf P9`.

On pull requests, the macOS job measures the PR base and candidate on the same runner. Both reports retain the absolute budget result for each measured workload. The comparison fails a threshold if the base met its budget and the candidate crosses it, or if the candidate gets worse by more than the tolerance below and reaches half the budget. For minimum throughput, that boundary is twice the minimum rate. Further from the limit, a change beyond tolerance is reported as an observation. This treats a workload using half its allowed time and one delivering twice its required throughput alike. A baseline that was already over budget may stay there. The gate checks each statistic separately, including p99 and the worst sample for an `each` limit. Lower throughput counts as a regression.

| Measurement                          | Allowed worsening from baseline |
| ------------------------------------ | ------------------------------- |
| Median time                          | Greater of 40% and 1 ms         |
| p99 time                             | Greater of 60% and 3 ms         |
| Worst individual time (`each`)       | Greater of 40% and 25 ms        |
| Process footprint                    | Greater of 10% and 2 MiB        |
| Throughput                           | Greater of 15% and 1 MB/s       |
| Bytes, bytes per turn, or archive MB | 5%                              |
| Package count                        | 0 packages                      |

The percentages use the magnitude of the baseline value. Absolute floors keep sub-millisecond noise and near-zero differences between startup times from triggering the relative gate. Tail measurements get more room because a scheduling delay affects p99 more than the median. In the S09 job, the median for reused owner launches moved from 67.7 to 89.7 ms (33%), inside the 40% allowance. The threshold-crossing rule still applies at the budget boundary. [S09 measurements](https://github.com/f4tumnigrum/kraka/actions/runs/46023474950/job/140588759962)

If the PR base fails to install, lacks a workload, or differs in scope, CI records the first complete candidate measurement as its baseline. The report preserves the measured value and absolute budget result. The local reference-machine run decides whether the absolute budget passes. A failed candidate probe or the disappearance of a previously measured workload fails CI. A workload unavailable on both sides is skipped. Main pushes record candidate observations and still fail on probe errors.

The PR job alternates the two revisions after each fresh/reused launch pair, idle PID, verified restart or recovery, rename round, and complete transfer. Each role owns its own state. The switch happens after timing ends. The dependency closure and whole test suite each produce one observation per revision, so each runs once on the base followed by once on the candidate. `budget-sampling.jsonl` records the order.

Open the macOS job's `daemon-budget-reports` artifact for the raw reports and `budget-comparison.jsonl`. Each matched threshold lists its unit, base and candidate values, signed difference, tolerance, and decision. To replay the PR decision locally, run `bun tools/perf-compare.ts budget-baseline.jsonl budget-candidate.jsonl`.

## Protocol reference

Add protocol schemas to `packages/protocol/src/schemas.ts`. Generate the JSON Schema and Markdown reference with one command.

```sh
bun run protocol:reference
```

Generated files live in `docs/generated/protocol/`. Regenerate them after changing a schema. CI checks that the generated files match the schemas.
