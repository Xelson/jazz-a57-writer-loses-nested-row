# jazz 2.0.0-alpha.57: the writer's own live view drops the nested row it just wrote (issue 10)

A runnable reproduction for a defect we reported against `jazz-tools@2.0.0-alpha.57`.
Everything runs in-process: a sync server from `jazz-tools/testing` (`startLocalJazzServer`,
in memory, local-first auth) and memory clients from `jazz-tools/client` (WASM in Node). There
is no app code, only the public API.

```bash
pnpm install
pnpm test
```

Node ≥ 22.12. The test is `tests/10-writer-loses-nested-row.test.ts`; its helpers are in `tests/harness.ts`.

On alpha.57 the red cases fail and every `control:` case passes. The result is the same on
every run:

```
Tests  2 failed | 4 passed (6)
```

Every red case asserts the correct behaviour, so it turns green once the defect is fixed. To
check a newer build, run `pnpm add jazz-tools@<version>` and then `pnpm test`.

## What goes wrong

**A correction here too.** We reported this as passing when the test ran alone. That was
noise: the defect is about 95 % reproducible, and the ordering of our tests had nothing to do
with it.

The steps:
1. A client subscribes to `messages{attachments{mediaAsset}}` at the `global` tier, which is
   the default for a Node client with a `serverUrl`.
2. In one tick, without awaiting acknowledgements, it inserts an asset, a message, and an
   attachment pointing at both.
3. Its live view shows the attachment with its asset. It then receives
   `Remove …>mediaAsset>K>originalFile` and `Remove …>mediaAsset` (in the fuller schema of our
   first report) and keeps `mediaAsset: null`.

Meanwhile a one-shot `db.all` on the same client returns the asset. Nothing re-inserts it: the
asset is still gone after 10 s (`HOLD_MS=10000`).

Measured with the schema in the test file, 10 runs per row, each on a fresh server:

| scenario | asset lost |
|---|---|
| writer's own subscription, default tier (global) | 10 / 10 |
| writer's own subscription, `{ tier: 'global' }` | 9 / 10 |
| writer's own subscription, `{ tier: 'local' }` | 0 / 10 |
| each insert acknowledged at `global` before the next | 0 / 10 |
| one level: `attachments{mediaAsset}` | 0 / 10 |

With a fuller schema (asset → original file, asset → variants; three include shapes), the
writer's own view lost the asset in 29 runs of 30, and another client's view in 0 of 30.

Each case in the file runs `RUNS` times (default 5) and fails on the first run that loses the
asset. `HOLD_MS` (default 1000) is how long the asset must stay in the view after it first
appears.

**Not established:** the mechanism. Our guess, unverified, is that the global-tier view settles
the attachment before the asset it points at and never revisits the asset once the asset
settles.

## Notes

- `pnpm-lock.yaml` pins the versions we ran: `jazz-tools` 2.0.0-alpha.57 and `vitest` 2.1.9,
  on Node 22.13.1 with pnpm 11.0.8. The install also works on pnpm 10.14.
- `pnpm-workspace.yaml` declines the esbuild and protobufjs build scripts. pnpm 11 otherwise
  treats them as an install error, and the tests need neither.
