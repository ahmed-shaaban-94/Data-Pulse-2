# Data-Pulse-2 — P-0 Preprod Deployment Runbook

Deploys the DP-2 backend (api + worker) onto the `Retail-Tower-OS` droplet, behind
`api-preprod.smartdatapulse.tech`, on the managed PostgreSQL 16 cluster `ezaby`.

This is the artifact that closes **#349 / D-DEPLOY**.

## Topology

```
Internet ──443──▶ Caddy (TLS, Let's Encrypt) ──▶ api:3000 (NestJS)
                                                   ├─▶ redis:6379 (BullMQ, sessions, locks)
                                                   └─▶ ezaby (managed PG16, PRIVATE host, sslmode=require)
worker ──▶ redis + ezaby     migrate (one-shot) ──▶ ezaby  (runs before api/worker)
```

Postgres is the **managed DO cluster** `ezaby` — not a container. Redis is containerized.

## Prerequisites (one-time, on the droplet)

1. Docker + Compose v2 (present on `Retail-Tower-OS`).
2. Firewall: ports 80 + 443 inbound open (done in infra P2).
3. DNS: `api-preprod.smartdatapulse.tech` A-record → droplet public IP (exists, DNS-only).
4. The `ezaby` cluster's trusted sources include this droplet (done).
5. **1Password CLI (`op`)** installed and authenticated via a **service-account token**:
   ```bash
   export OP_SERVICE_ACCOUNT_TOKEN=...   # placed on the droplet; never committed
   op whoami                              # verify
   ```
6. A `deploy/prod.env` (copied from `deploy/prod.env.example`) containing only
   `op://` references + non-secret config — **no secret values**.

## Deploy

```bash
gh repo clone ahmed-shaaban-94/Data-Pulse-2   # or: git pull on an existing clone (HTTPS/gh auth)
cd Data-Pulse-2
git checkout <deploy-ref>                       # the reconciled origin/main commit being deployed

cp deploy/prod.env.example deploy/prod.env      # then set the op:// references
op run --env-file=deploy/prod.env -- \
  docker compose -f docker-compose.prod.yml up -d --build
```

`op run` resolves the references into the container env in memory only. The
`migrate` service runs `migrate up` against `ezaby` and must exit 0 before
`api`/`worker` start (compose `service_completed_successfully` gate).

## Verify

```bash
docker compose -f docker-compose.prod.yml ps          # all healthy; migrate Exited(0)
curl -sS -o /dev/null -w "%{http_code}\n" https://api-preprod.smartdatapulse.tech/
# any app response (e.g. 401/404 from NestJS) proves the edge is live; TCP timeout = not live
op run --env-file=deploy/prod.env -- \
  docker compose -f docker-compose.prod.yml run --rm migrate node dist/cli/migrate.js status
```

## Operations

```bash
# logs
docker compose -f docker-compose.prod.yml logs -f api
# redeploy a new ref
git pull && op run --env-file=deploy/prod.env -- docker compose -f docker-compose.prod.yml up -d --build
# stop
docker compose -f docker-compose.prod.yml down            # keeps volumes (redis AOF, caddy certs)
```

## Known follow-ups (not in this artifact)

- **Add a public `GET /health` route** to `apps/api`; currently healthchecks use the
  unauthenticated Prometheus metrics listener on `:9464`.
- **Hardening:** run containers as a non-root user; add resource limits; offsite backups
  of `ezaby`; monitoring/alerting; log shipping.
- **Console** (`console-preprod`) is a separate later deployment.
