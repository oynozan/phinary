# Railway demo deployment

Deployment created 2026-09-27 (JST):
- Project: https://railway.com/project/f9f7b173-25b5-432a-816f-ab2635e36038
- Web: https://web-production-7a0813.up.railway.app
- Environment: production (`3b47d378-e0d7-4c06-aa22-07934543c98b`)
- Web service: `adb9bad2-42ea-426e-8f6a-75cf04631d7c`
- Indexer service: `97865263-96ee-4d98-8987-5fbfd804bb2d`
- Postgres service: `82ce409c-fb97-44ea-9837-1888b54036f5`

Deployment readiness must be checked separately; the presence of a URL does not
mean initial indexing or wallet-origin configuration has completed.

Use a paid Hobby (or higher) workspace. Keep Web, Indexer and Postgres running
until explicitly stopped. No cron schedule and no Serverless/App Sleeping.
Set one replica, `sleepApplication: false`, and restart policy `ALWAYS` through
Railway service settings/API. Apply equivalent settings to Postgres and retain its
volume. Railway's API now rejects legacy railway.json configuration, even though
the older documentation/schema remain available.

## Services

Both application services use the repository root as their build context, not
`web/` or `indexer/`: they need the sibling swap SDK and deployment manifest.

| Service | Dockerfile path in Railway service settings | Environment |
| --- | --- | --- |
| web | `deploy/railway/web.Dockerfile` | `PORT=3000`, `PHINARY_INDEXER_URL=http://${{indexer.RAILWAY_PRIVATE_DOMAIN}}:42069` |
| indexer | `deploy/railway/indexer.Dockerfile` | `PORT=42069`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `PONDER_NETWORK=unichain-sepolia` |
| Postgres | Railway Postgres service with persistent volume | Use private networking; no public TCP proxy required |

Generate a public domain only for Web. Register its HTTPS origin in the existing
Privy app/client allowed origins. The default public Privy identifiers are already
in the app; overrides and `NEXT_PUBLIC_PHINARY_RPC_URL` must be present at build
time. A `NEXT_PUBLIC_` URL is browser-visible; do not put a secret RPC key there.
Indexer can use a server-only `PONDER_RPC_URL_1301` for a dedicated archival RPC.
Do not set `PONDER_PGLITE_DIR` on Railway.

The indexer entrypoint requires Postgres and uses Railway's deployment ID for
Ponder's schema, following the Ponder deployment guide. Database persistence
retains indexed data and RPC cache; code/schema changes may still require replay.
The existing Ponder empty-response patch is applied during image installation.

## Readiness

Initial historical indexing must finish before calling the demo ready. Railway
checks `/ready` for up to one hour. Web additionally rejects indexed data more
than 60 seconds behind, so a healthy HTTP process alone is not sufficient.
Verify market charts, Activity and matching onchain market addresses from the
public Web URL after synchronization. Verify Privy connection separately.

Keep the initial snapshot start from the deployment unless a reduced history
window is explicitly chosen; do not silently truncate history to speed startup.

## Bots

Existing local mirror and keeper processes can remain local if they write to
the same public Unichain Sepolia deployment. A local Anvil fork is not equivalent.
The PC must remain awake/online, with funded accounts and mirror ownership.
Do not start duplicate bot instances with the same signing key. This deployment
does not copy signing keys or start bots on Railway.

## Operations

The existing services were deployed with Railway CLI uploads, not GitHub
autodeploys. Pushing these files to GitHub does not update the running services.
Deploy a reviewed revision explicitly when a new release is needed.

For a clean upload containing only committed deployment inputs:

```sh
# Run from the repository root after committing the intended release.
deploy_dir=$(mktemp -d /tmp/phinary-release.XXXXXX)
git archive HEAD .dockerignore deploy/railway web indexer packages/swap-sdk deployments/unichain-sepolia.json | tar -x -C "$deploy_dir"
# Deploy only the service being changed; each command starts a real deployment.
railway up "$deploy_dir" --path-as-root --project f9f7b173-25b5-432a-816f-ab2635e36038 --environment production --service web --detach
# Only when changing the indexer:
# railway up "$deploy_dir" --path-as-root --project f9f7b173-25b5-432a-816f-ab2635e36038 --environment production --service indexer --detach
```

Web healthcheck: `/` with a 300-second timeout. Indexer healthcheck: `/ready`
with a 3600-second timeout. Keep these settings in the Railway service settings.

Always-on compute incurs usage charges beyond the plan's included credit.
Monitor CPU, memory, volume growth and RPC throughput after initial sync. Hobby
volume capacity must be checked against actual Ponder cache/history growth.
A spending hard limit can stop the demo; agree on that limit separately.

Before the demo, leave the validated deployment running and avoid unnecessary
redeployments. Platform failures/restarts can still cause temporary interruption.
When asked to stop, stop/remove the application deployments through Railway's
deployment controls (do not just kill a process under `ALWAYS`). Keep Postgres's
volume for later recovery; storage can continue to incur charges.

References:
- https://ponder.sh/docs/production/railway
- https://docs.railway.com/deployments/serverless
- https://docs.railway.com/deployments/restart-policy
