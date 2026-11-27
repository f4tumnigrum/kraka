A library running in Bun that owns environment state and the internal executor-adapter contract.

## Worktree preparation values

A new-task `worktree.prepare` pins a branch or commit before the host allocates the thread ID. The host keeps the unconsumed selection for 24 hours so a device can reconnect the next day. The first send consumes it in the same transaction as the receipt. Selection lookup checks the deadline. Startup and an hourly sweep discard expired database rows. An unconsumed selection owns no Git reference or directory.

Managed checkout creation requires Git 2.50.1 or later in the 2.x series and Python 3 (`python3` on Unix, `python` on Windows). The embedded Python helper holds the SQLite directory lease and starts a Git or setup process after the daemon commits its group identity. A helper with unconfirmed ownership or exit leaves the checkout available for inspection.

The local operator can place a JSON policy in `STATE/project-policies/<sha256-of-project-id>.json`. Its optional `rows` use the protocol's setting row format. Its optional `setup` is an executable and argument array, run in the new checkout. The host freezes these values for each claim.
