/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step carries the reason it must precede the next; the ordering is the substance of this file.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process — AD-17 and rule 7. It matters concretely here: below `SCHEMA_VERSION`
 * the `executions_respect_timelock` trigger and the `votes_proposal_subject_uniq` constraint may
 * not exist, and a service that could create them at boot is a service that could start without
 * them — which is a service that executes treasury spends early and counts a member twice.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHICH PROBES ARE HARD, AND WHY THE ANSWER IS NOT THE DEPENDENCY MAP'S.**
 *
 * `07-dependency-map.md:137-140` marks ledger **hard**, policy **hard (fail-closed)**, identity
 * soft, and indexer **hard for the re-evaluation job**. Readiness is a different question from
 * dependency strength, and conflating them takes services out of the load balancer for outages
 * they can survive:
 *
 *   Postgres   HARD. Nothing in this service works without it.
 *   ledger     SOFT. A ledger outage stops treasury EXECUTIONS, and that is handled where it
 *              happens: the execute job fails and retries, and `community_proposals_timelocked`
 *              climbs. It does not stop voting, discussion, membership or reading a tally — which
 *              is most of what this service is. Failing readiness would take governance offline
 *              for a dependency only one code path has.
 *   policy     SOFT, for the same reason and more strongly: policy is on the execution path only.
 *   identity   SOFT. Its JWKS is cached by the verifier, so a brief outage does not stop
 *              authentication at all.
 *   indexer    SOFT, and its dependency is nominally hard. The job it serves does not demote
 *              anybody on an unknown holding (`gating.ts`), so an indexer outage degrades token
 *              gating to "not re-checked" rather than to "everybody evicted" — and taking the
 *              whole service out of rotation would not make the check run any sooner.
 *
 * The hard/soft split is therefore: **Postgres is the only hard probe, because it is the only
 * dependency whose absence makes every route wrong rather than one path slow.**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module via `NODE_OPTIONS`,
 * which reads `OTEL_EXPORTER_OTLP_ENDPOINT` from the environment itself. That is why no `OTEL_*`
 * variable appears in `src/env.ts`.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics, scrapeRefresh } from './server.ts'
import {
  registerHandlers,
  rescheduleRecurring,
  sampleGovernance,
  sampleQueue,
  seedRecurring,
} from './jobs.ts'
import { httpLedgerClient } from './ledgerclient.ts'
import { httpPolicyClient } from './policyclient.ts'
import { indexerOracle, unavailableOracle } from './gating.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail, so a pool failure is a structured line rather than a
//    bare V8 stack the collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  // Said at boot, because a rotation that is half-finished looks exactly like a rotation that is
  // finished until somebody counts the secrets.
  ingestSecrets: env.ingestSecrets.length,
  // Said at boot, because "token gating is not actually running" is otherwise invisible until
  // somebody reads a metric. See gating.ts.
  tokenGating: env.indexerBaseUrl === null ? 'no indexer configured — holdings are unknown' : 'configured',
})

// 3. The database pool. Opened before the schema assertion (which is a query) and before the
//    Lifecycle (whose readiness probe closes over it).
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  onnotice: () => {},
})
const db = sql as unknown as Sql

// 4. Assert the schema. This does NOT migrate. Failing here rather than serving is the point.
try {
  await assertSchemaAtLeast(db, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report. See the header for the hard/soft split and its reasoning.
const lifecycle = new Lifecycle({
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})
lifecycle.addProbe(
  postgresProbe('postgres', (signal) =>
    Promise.race([
      sql`select 1`,
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
      }),
    ]),
  ),
)
lifecycle.addProbe(httpProbe('identity', env.identityJwksUrl, { kind: 'soft' }))
lifecycle.addProbe(httpProbe('ledger', `${env.ledgerBaseUrl}/livez`, { kind: 'soft' }))
lifecycle.addProbe(httpProbe('policy', `${env.policyBaseUrl}/livez`, { kind: 'soft' }))
if (env.indexerBaseUrl !== null) {
  lifecycle.addProbe(httpProbe('indexer', `${env.indexerBaseUrl}/livez`, { kind: 'soft' }))
}

// 6. The upstream clients. One credential, presented to all three — a single service identity for
//    this service, which is what SD-05's scoped service tokens are. The scopes it needs are named
//    in `LEDGER_SCOPES`, `POLICY_SCOPES` and `INDEXER_SCOPES` so the deploy can mint exactly those.
const token = () => env.serviceCredential
const ledger = httpLedgerClient({
  baseUrl: env.ledgerBaseUrl,
  token,
  deadlineMs: env.ledgerDeadlineMs,
  originatingService: SERVICE,
})
const policy = httpPolicyClient({
  baseUrl: env.policyBaseUrl,
  token,
  deadlineMs: env.policyDeadlineMs,
})
// No indexer URL is a SUPPORTED mode, and the oracle that results knows nothing rather than
// reporting zero. A zero would demote every token-gated member on the first pass. See gating.ts.
const oracle =
  env.indexerBaseUrl === null
    ? unavailableOracle()
    : indexerOracle({
        baseUrl: env.indexerBaseUrl,
        token,
        deadlineMs: env.indexerDeadlineMs,
        network: env.indexerNetwork,
      })

// 7. The queue.
//
//    `leaseMs` is 120s rather than the package default of 60: `proposal.execute` holds its lease
//    across a policy call and a ledger call, and a lease that can expire mid-execution is a lease
//    that lets a second worker start one. The lease must exceed the sum of both deadlines with
//    room, and `jobs.test.ts` asserts that relationship rather than the number.
const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId, leaseMs: 120_000 })

// 8. Routes. After the Lifecycle so the health handlers report real state.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const refresh = scrapeRefresh({ sql, metrics })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql,
  producer: SERVICE,
  ingestSecrets: env.ingestSecrets,
  queue,
  execute: { ledger, policy },
  // Gauges are sampled at scrape time rather than on a timer. There is no `setInterval` in this
  // repository and CI greps for one — rule 8.
  beforeScrape: async () => {
    await refresh()
    await sampleQueue(sql, metrics)
    await sampleGovernance(sql, metrics)
  },
})

// 9. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving.
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 2,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})
registerHandlers(runner, {
  sql,
  logger,
  metrics,
  queue,
  signingSecret: env.outboxSigningSecret,
  producer: SERVICE,
  execute: { ledger, policy },
  oracle,
  gate: {
    intervalHours: env.gateRecheckIntervalHours,
    batchSize: env.gateRecheckBatchSize,
  },
  idempotencyTtlDays: env.idempotencyTtlDays,
})
await seedRecurring(queue)
runner.start()

// 10. Listen. Last of the construction steps: a socket that accepts before its dependencies exist
//     is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 11. Ready. Only now does `/readyz` start answering 200 and the balancer send traffic.
lifecycle.markReady()

// 12. Signal handlers, last of all. Hooks run in reverse registration order, so the server closes
//     first, then the runner stops claiming and DRAINS, then the pool closes with nothing left.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
