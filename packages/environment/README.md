A library running in Bun that owns environment state and the internal executor-adapter contract.

## Worktree preparation values

A new-task `worktree.prepare` pins a branch or commit before the host allocates the thread ID. The host keeps the unconsumed selection for 24 hours so a device can reconnect the next day. The first send consumes it in the same transaction as the receipt. Selection lookup checks the deadline. Startup and an hourly sweep discard expired database rows. An unconsumed selection owns no Git reference or directory.

Managed checkout creation supports Git 2.50.1 and later 2.x versions. Preparation uses `git show-ref --exists` to distinguish a missing ref from a failed lookup and `git worktree list --porcelain -z` to verify registration. The daemon starts another copy of kraka to hold the SQLite directory lease. The helper starts Git or the setup command after the daemon records the helper’s PID and OS start time and grants permission through its pipe.

On POSIX, Git and foreground setup commands inherit the helper’s detached process group. Setup commands must keep their writers in that group. On Windows, the helper joins a private kill-on-close Job Object before starting any writer. If the host prevents job assignment, group ownership cannot be confirmed, or forced termination leaves no verified exit record, recovery retains the claim for inspection.

The local operator can place a JSON policy in `STATE/project-policies/<sha256-of-project-id>.json`. Its optional `rows` use the protocol's setting row format. Its optional `setup` is an executable and argument array, run in the new checkout. The host freezes these values for each claim.
