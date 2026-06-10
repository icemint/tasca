# Org-scoping the data plane: app-level `WHERE org_id`, not Postgres RLS

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** maintainer
- **Slices:** 3a (#249), 3b-1 (#250), 3b-2 (#251), 3c (#253), slice 4 (#254 — RBAC, `resolveOrg` = real membership lookup), slice 5 onboarding (5a #255 — validated active-org from `user_active_org` + auto personal org + active-org switcher; 5b #256 — per-action role matrix owner/admin/member; 5c #257 — GitHub workspace→org connect via App install; 5d #258 — org_agent roster + org-scoped routing filter + `agent:<name>` intake) — all shipped. Wave-2 multi-tenancy arc complete.

## Context

Wave 2 makes Tasca multi-tenant. The tenant key is `org_id` on the six task-side tables
(`task`, `dispatch_job`, `routing_decision`, `pull_request`, `platform_connection`,
`webhook_event`). Identity/agent/auth tables stay **global** this wave — per-org rosters belong
with RBAC + onboarding (slices 4/5). The question this ADR settles: **how is the "every tenant
query is scoped to its org" guarantee enforced** — Postgres Row-Level Security (RLS), or
app-level `WHERE org_id` carried by the code?

Our initial lean was RLS (defence-in-depth at the database). We reversed it on the evidence below.

## Decision

**Enforce tenant isolation at the application layer — a required `org_id` on every tenant query —
NOT Postgres RLS.** RLS is rejected for Stage 1 (the `org_id` columns keep it available as a future
backstop once a per-request scoped-connection layer exists).

### Why not RLS (the connection-pooling evidence)

The persistence layer is **raw `pg`** (no ORM) on a **single shared `pg.Pool`**, and ~90% of
queries run **directly on the pool** (only ~10% are transactional). RLS is driven by a session GUC
(`SET app.current_org = …`) read by the policies. On a shared pool that GUC **bleeds across
requests**: connection X is set to org A, returned to the pool, then reused by org B's request
before B sets its own value — so B transiently sees A's rows under normal operation. That is
**worse than a forgotten `WHERE`**: it is a silent, load-dependent cross-tenant read on the happy
path, not an obvious omission. Making RLS safe would force wrapping ~every read in a transaction
(to scope the GUC), plus a second `BYPASSRLS` pool for the deliberately cross-org workers
(reaper/runner/orchestrate resolve org *across* tenants by design), plus webhook-time org
resolution before any policy context exists — a large, fragile new surface for a guarantee we can
get more cheaply elsewhere.

### How the guarantee is enforced instead (two complementary mechanisms)

Neither alone is sufficient; together they make "forgetting to scope a query" not compile or not
pass CI:

1. **The type system (the store is honest by construction).** Every tenant-scoped store method
   takes a **required `orgId` first parameter**. A caller that omits it is a **compile error**.
   There is no optional `orgId?:` and **no default-org fallback inside any scoped method**. The
   single place a default org is materialized is at the **request edge**
   (`coordination/src/resolve-org.ts`: `resolveOrg(session)` + `DEFAULT_ORG_ID`), consumed by the
   read/write APIs (session edge), orchestrate + server (webhook edge), and main (install edge).
   The three cross-org resolvers — `getOrgForConnection`, `getOrgForTask`,
   `getInstallationIdForOwner` — return `null` on a miss; the **edge** decides what to do with a
   miss (default org for an unconnected workspace; skip a vanished task). The store never defaults.

2. **A CI boundary guard (`scripts/check-org-scoping.ts`, wired into `lint`).** Raw tenant-table
   SQL is confined to the **scoped layer** (`coordination/store.ts`, `coordination/schema.ts`,
   `db/dispatch-queue.ts`, `db/claim-repo.ts`, `db/schema.ts`). Any other source file containing
   raw `FROM task` (etc.) fails CI — forcing it through the org-scoped store methods rather than
   bypassing isolation with hand-rolled SQL. The guard's detection is itself unit-tested with a
   deliberately-violating snippet (a guard that never fires is worse than none).

### The three watch items (proved across the slices)

1. **No escape hatch in the store** — a forgotten `orgId` is a compile error; no `orgId?:`, no
   default-org fallback inside the scoped layer. The default-org stub lives at the resolution edge
   only. *(Proved in 3b-2: panel-verified; zero `DEFAULT_ORG` references inside `store.ts`.)*
2. **Unique swap + `ON CONFLICT` in lockstep** — re-prefixing the tenant uniques with `org_id`
   (drop un-prefixed → create org-scoped) ships in the SAME diff as the store's `ON CONFLICT`
   change, and is collision-free on backfilled single-org data (the old uniques guaranteed the
   sub-key unique → the org-prefixed key cannot collide). *(Proved in 3b-2: `org-scoping.test.ts`
   contract-step suite.)*
3. **Cross-org workers are the ONLY unscoped paths** — the reaper (via `getOrgForTask`) and the
   three resolvers are the sole unscoped tenant reads; everything in a request context is scoped.
   *(3c makes the dispatch-queue/claim-repo carry `org_id` as data and the runner/reaper the
   explicit, tested cross-org path.)*

## Expand / contract — applied per writer

The migration is an expand/contract split so no in-flight query ever breaks:

- **3a (#249) — expand.** `organization` table + `org_id` columns + backfill to a default org
  (children derive from their task via the FK chain). Purely additive: a **transitional column
  `DEFAULT 'org_default'`** keeps existing inserts working, then `NOT NULL` + FK + a plain index.
- **3b-1 (#250).** The CI guard, landed *before* the query migration so 3b-2 is written under
  enforcement.
- **3b-2 (#251) — contract (store).** Required-`orgId` signatures + every store query scoped + the
  unique swap coupled with `ON CONFLICT`. The transitional default is dropped on the **five
  store-written tables** — once the store sets `org_id` explicitly, the data-layer fallback must
  not outlive the type-layer enforcement.
- **3c — contract (queue).** `dispatch_job`'s transitional default is dropped **here**, in
  lockstep with its writer (`PgDispatchQueue.enqueue`) starting to set `org_id`. **Key discipline:
  a table's default is dropped only in the slice that updates ITS writer.** Dropping `dispatch_job`'s
  default in 3b-2 (its writer is the queue, not the store) would have broken every enqueue — a real
  bug the 3b-2 PG integration tests caught and the contract DDL was corrected to defer.

## Consequences

- **+** "Can't forget to scope a query" is a **compile error** (type system) backed by a **CI
  gate** (boundary guard) — checkable by humans and machines, no runtime GUC to get right.
- **+** The deliberately cross-org workers (reaper/runner/orchestrate webhook resolution) need no
  special second pool or `BYPASSRLS` — they call the explicit cross-org resolvers, which are the
  named, auditable exceptions.
- **+** Slice 4 (RBAC) swapped a **single function** (`resolveOrg`) from "always default org" to a
  real session→membership lookup (`org_membership`), as designed — the rest of the request path was
  unchanged. It is now async + fail-closed: a verified user with no membership → 403, never the
  default org in a request context.
- **−** Isolation is only as strong as the type+CI discipline — there is no database-level backstop
  yet. A query authored *inside* the scoped layer could still omit a `WHERE org_id` (the guard
  confines *where* tenant SQL lives, not that each statement scopes correctly); that residual is
  carried by code review + the store's required-`orgId` shape, and is why the store is the only
  place tenant SQL lives. RLS remains available later as defence-in-depth (the columns are the
  prerequisite) once slices 4/5 build a per-request scoped-connection layer.
- **−** The webhook ledger resolves the delivery's org from the first event's workspace; a
  (non-existent in practice) multi-workspace delivery would ledger under one workspace's org while
  its tasks scope per-event. Benign — deliveries are single-workspace.

## Provenance

Architected, implemented typecheck-driven, then reviewed by a multi-lens adversarial panel
(tenant-isolation leak hunter; migration correctness; cancel-coupled/cross-org cancel; call-site
regression) with per-finding verification. The panel confirmed all three watch items against the
code; the two findings it raised were merge-hygiene, not isolation defects.
