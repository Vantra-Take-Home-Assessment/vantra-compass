# Vantra (Project Compass slice)

Fleet telemetry backend: NestJS, MongoDB and Redis, split into three services
behind one gateway. The architecture plan, prioritisation, risks and
reflection are in the Project Compass plan document submitted with this branch.

## Service boundaries

```
  devices                    dispatchers / UI
     │                              │
     ▼                              ▼
 ┌──────────────── gateway (nginx :3000) ─────────────────┐
 │ /ingestion/* → ingestion   /auth /vehicles /dashboard  │
 │ /alerts /admin/* → alerting       → fleet-api          │
 │ /internal/* → 404 (service-to-service only)            │
 └────────────────────────────────────────────────────────┘

 ingestion ──writes──▶ telemetryevents, vehicle_latest      (Mongo)
     │  ├──monotonic merge──▶ latest:{tenant}               (Redis hash) ◀──reads── fleet-api
     │  └──XADD──▶ telemetry.received                       (Redis stream) ──▶ alerting
     └──reads──▶ vehreg (vehicleId → tenant)                (Redis hash) ◀──writes── fleet-api

 fleet-api ──cache miss──▶ GET ingestion /internal/latest
 ingestion ──registry miss──▶ GET fleet-api /internal/vehicles/:id
 alerting ──verify before alerting (batched)──▶ POST ingestion /internal/vehicles/last-seen
```

| Service | Responsibility | Owns (only writer) | Talks to |
|---|---|---|---|
| **fleet-api** | identity, tenants, vehicle registry, dashboard reads | `users`, `tenants`, `vehicles`; Redis `vehreg`, `fleet:{tenant}:vehicles` | reads `latest:{tenant}`; calls ingestion on cache miss |
| **ingestion** | device write path, latest-reading projection | `telemetryevents` (append-only), `vehicle_latest`; Redis `latest:{tenant}`; stream `telemetry.received` | reads `vehreg`; calls fleet-api on registry miss |
| **alerting** | offline detection, alert lifecycle, reliable delivery | `alerts` (with outbox state), `alerting_vehicle_state` | consumes `telemetry.received`; calls ingestion to verify before alerting |

Rules that hold everywhere:

- A service never reads or writes another service's collections. Cross-service data goes over the stream, an `/internal` HTTP call, or a Redis key that has exactly one writer.
- Every read is scoped by the `tenantId` in the caller's JWT. Every service verifies the JWT itself with the shared secret.
- `/internal/*` needs `x-internal-token`, and the gateway also blocks it from outside.

For this slice all three services share one Mongo database. Ownership is
enforced in code (each service only registers its own models). Moving to
separate databases is a later step, covered in the plan.

## Running it

Requires Docker with Compose v2. Node isn't needed to run the stack: the seed
and migration run inside the service image.

```bash
git clone https://github.com/Vantra-Take-Home-Assessment/vantra-compass.git
cd vantra-compass

docker compose up -d mongo redis
docker compose run --rm tools node dist/scripts/seed.js   # builds the image, then ~1M historical events (~1 min)
docker compose run --rm tools                             # Compass migration: tenants, backfills, projections (idempotent)
docker compose up -d --build                              # gateway + 3 services; all report healthy in ~15s
```

Check it with `docker compose ps` (every service `healthy`) and
`curl http://localhost:3000/health`.

API at `http://localhost:3000` (same paths as the monolith). Swagger UI is at
`/docs/fleet-api`, `/docs/ingestion` and `/docs/alerting`. A Postman
collection covering every endpoint, with auto-login and status-code tests,
is in [docs/postman/](docs/postman/Vantra-Compass.postman_collection.json).
Import it, run the two logins, then any request (or Run collection). `GET /health` on
each service reports `{ ok, mongo, redis }` and returns 503 if Mongo is down.

**Port clashes.** If you already run Mongo or Redis on the host, override the
published ports (the services talk to each other on the compose network, so
only host-side tools care): `REDIS_HOST_PORT=6380 MONGO_HOST_PORT=27018 docker compose up -d`,
then point host tools at them, e.g. `REDIS_URL_TEST=redis://localhost:6380/15 npm run test:int`.

**Host-side scripts** (`npm run simulate`, `npm test`, `npm run test:int`,
`npm run seed`) need Node 20+ and `npm install`. `package.json` already allows
bcrypt's install script for npm 11+, which otherwise skips it and leaves bcrypt
without its native binary (`Cannot find module ... bcrypt_lib.node`).

**Windows.** Works with Docker Desktop or Docker Engine inside WSL2. With plain
Docker Engine in WSL2 (no Docker Desktop), WSL can shut the distro down once no
WSL terminal is open, which stops Docker and every container with it. Keep a WSL
terminal open while you use the stack.

| Login | Password | Role / tenant |
|---|---|---|
| `demo@vantra.internal` | `demo-password-123` | dispatcher, northbound-logistics |
| `admin@<tenant>.demo` (`coastal-freight`, `highland-transit`, `metro-delivery`, `northbound-logistics`) | `compass-demo-123` | admin of that tenant |

Simulated live devices (duplicates and late deliveries included):

```bash
npm run simulate -- --vehicles 20 --interval 5 --duration 120
```

Alerts are delivered as `[deliver]` log lines in `docker compose logs -f alerting`.
Set `NOTIFY_WEBHOOK_URL` to POST them somewhere instead. Set
`NOTIFY_SIMULATED_FAILURE_RATE=0.5` to watch retries and backoff work.

### Local, without Docker for the services

Copy `.env.example` to `.env`, run Mongo and Redis via compose, then
`npm run dev:fleet-api`, `npm run dev:ingestion` and `npm run dev:alerting`
(ports 3001, 3002 and 3003; there's no gateway in this mode).

## Tests

```bash
npm test            # unit tests
npm run test:int    # integration tests against real Mongo + Redis (compose mongo/redis must be up)
```

The integration tests cover the concurrency behaviour. `alert-state.int-spec.ts`
first reproduces the cross-boundary race with the monolith's check-then-act
logic, then shows that the CAS version doesn't have it. It also covers
concurrent sweepers, out-of-order events, the VANTRA-441 regression, crash
repair and the outbox. `latest-cache.int-spec.ts` covers monotonic merges,
rebuilds racing live writes, and eviction during a rebuild.

## API changes vs the monolith

| Endpoint | Change |
|---|---|
| `POST /auth/register` | **Was open to anyone, and the new account could read every fleet.** Now admin-only; the user is created in the admin's tenant. |
| `POST /auth/login` | JWT now carries `tenantId` and `role`. Pre-Compass tokens are rejected, so users must log in again once. Users with no tenant can't log in. Rate limit is shared across replicas (Redis). |
| `GET /vehicles`, `/vehicles/:id`, `/dashboard/*`, `/alerts/:vehicleId` | Tenant-scoped. Another tenant's vehicle returns 404. |
| `POST /vehicles` | Admin-only; validated body. |
| `GET /dashboard/vehicle-statuses` | Same shape. `latest` gains `batteryPct` (normalised number); `location` no longer contains a stray `_id`. |
| `POST /ingestion/telemetry` | Same contract. Telemetry for unregistered vehicles is stored but quarantined (`tenantId: null`). |
| `POST /alerts/:alertId/resolve` | New. Records `resolvedBy`. |
| `POST /admin/vehicles/:id/force-recalibrate` | Was undocumented and open to any user. Now admin-only and tenant-scoped; it acknowledges the current offline episode and doesn't silence future ones. |
| `/internal/*` | Service-to-service only. |

## What happened to...

- **`DriftCorrectionJob`**: removed. It rewrote `recordedAt` on raw telemetry. Liveness now uses server-side `receivedAt`, so nothing needs correcting. See the plan, section 5.
- **The 6h alert debounce (VANTRA-441)**: replaced. See the plan, section 5.
- **The monolith entrypoint** (`src/main.ts`, `app.module.ts`): replaced by `src/apps/*/main.ts`. In a real rollout the gateway would route to the monolith and move one path at a time (plan, section 2).
