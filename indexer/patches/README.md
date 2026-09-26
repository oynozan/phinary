# Ponder 0.17.12 empty-response cache patch

`ponder+0.17.12.patch` fixes a reproduced failure in Ponder's prefetch cache.
`postinstall` applies it with `patch-package --error-on-fail`; a mismatched dependency
must fail installation instead of silently dropping the fix. Both shipped ESM and
TypeScript source are patched. Ponder was already at the latest published version
when this patch was prepared (2026-09-26).

The upstream path serialized `null`/`0x` before comparing them with raw exclusion
values. Those responses could be persisted, and retries kept returning the cache
entry without calling RPC. The patch:

- rejects empty prefetch results;
- evicts empty/failed prefetch entries before transport cache lookup;
- decodes cached values before validation;
- ignores empty values already persisted by older runs;
- preserves valid cache hits, for both readContract and multicall.

No database schema change or data deletion is required. Old invalid entries are
bypassed; they are not rewritten in place because Ponder inserts cache rows with
`onConflictDoNothing`. If disk cleanup is needed later, back up that specific
local database before removing only invalid cache entries. Do not wipe event data.

Regression tests: `npm test -- test/empty-cache.test.mjs` (Node 24 recommended).
They exercise installed Ponder transport, its actual prefetch/retry wrapper, null
and 0x, memory/Promise/database entries, multicall and valid cache reuse. The
original transport failed 12 recovery cases; the patched suite passes 15 cases.

When upgrading Ponder, first check the upstream fix and run these regressions.
Remove this patch and the postinstall hook only after proving the new dependency
recovers without them. Do not generate a patch by disabling error handling or by
replacing historical block reads with `latest`.

See `docs/md/INDEXER-VAULT-INVESTIGATION.md` at the repository root for the incident
and live verification record.
