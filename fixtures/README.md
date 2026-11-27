# Replay fixtures

## Executor samples

Samples are grouped by family under `executors/<family>/`. Each JSONL file starts with a header naming the protocol, its source revision and the scenario. Every following line is one frame, numbered from 1 in capture order. Direction is relative to the executor. Use a visible `fake` marker in every sample credential, including opaque tokens embedded in text.

The `frame` field preserves the native protocol JSON unchanged. When implementing an adapter, check its samples against that family's upstream protocol at the revision named in the header.

## User scenarios

In `kraka-scenario-v2`, executor events identify the reporting instance and terminal events carry the native root ID and end time. The reader also accepts `kraka-scenario-v1`. Its older executor events retain only the evidence recorded at the time.

Each `scenarios/*.json` file describes one session from the viewpoints of at least two devices. Read it with `parseScenario` in `tools/fixtures/scenario.ts`. Initialize each environment at its `through` position using the supplied objects, queue metadata and terminal sessions. The clock starts at `startTime` in milliseconds. An initial connection has completed pairing and configuration. Authentication uses sequence 1. The initial settings snapshot uses the starting environment version, with no explicit values or overlays. Each object subscription already holds the scoped window from the initial rows at the installed cursor. A terminal subscription starts at its own `sentThrough` byte offset.

Apply inputs in file order. A label identifies the moment at which the listed outputs can be observed. Each client's `expected` groups give the environment and messages in receive order. Multiple groups at one label continue that order. An omitted group means that client receives no logical application messages at that step. The fixtures observe command receipts, subscription updates and terminal notifications. Transport fragmentation, automatic handshakes, heartbeats and background acknowledgements sit below this observation point.

A `draining` stream replenishes its credit as data arrives. A `manual` stream uses its initial byte counters and explicit window updates. Terminal output events supply the exact UTF-8 text and its repetition count. Each output's content ID denotes the bytes in its half-open range within that terminal generation.

A restart closes the affected connections. A connect input establishes a configured connection with a fresh ID. Later commands can reopen subscriptions using their saved cursors. Device commands in the answer race were prepared from the same open question and arrive in the listed order. A `commands` input captures all signed requests prepared by one device for a single action. Submit them in the listed order. The settings example sends its two members to different environments and observes a receipt from each.

Use the fixture clock and stable identifiers for replay. A driver may bind an allocated identifier on first observation and must use the same binding wherever that identifier recurs. Signatures and challenges carry fake markers and exercise wire shape only.
