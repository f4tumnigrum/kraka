A library running in Bun that owns command-line client commands through the client-runtime and protocol packages.

## Start a task

Run `bun packages/cli-client/src/first-send.ts` with a JSON document on standard input. Supply the verified local writer's `instance`, device `signer`, `privateKeyPath`, device-local SQLite `journal` path, and a stable draft `key`. The `input` has the registered `projectId`, message `content`, and one of these checkout choices.

```json
{"kind":"shared"}
{"kind":"isolated","selection":null}
{"kind":"isolated","selection":{"branch":"feature/task","baseRef":"main"}}
```

Reuse the journal and draft key to retrieve a lost receipt. A new key starts a separate task.
