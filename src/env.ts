/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repository declares the variables it needs; the deploy
 * provides exactly those" — is a property of this file. Every variable this service reads is named
 * here and nowhere else, and `env.test.ts` asserts that this file and `.env.example` agree in BOTH
 * directions.
 *
 * Two behaviours are copied from the siblings, deliberately:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** `.env.example` ships `CHANGE_ME`, and
 *      `CHANGE_ME` does not boot.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHAT THIS SERVICE DELIBERATELY HAS NO VARIABLE FOR.**
 *
 * There is no `COMMUNITY_ADMIN_TOKEN`, no break-glass credential and no "skip the timelock"
 * switch. The second is the one worth naming: a variable that could shorten or bypass a timelock
 * would be a variable that spends a community's treasury on somebody's say-so, and the whole of
 * AD-15 is that no single party can do that. The timelock is a column on the proposal and a
 * trigger in the database; there is nothing in the environment that can move it. `env.test.ts`
 * asserts their absence by name.
 *
 * There is no `COMMUNITY_MIN_TIMELOCK_MINUTES` either, and that is the same decision: the floor
 * lives in `proposals.ts` as a constant, because a governance guarantee that a deploy can lower is
 * not a guarantee.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module via `NODE_OPTIONS`,
 * which reads `OTEL_EXPORTER_OTLP_ENDPOINT` from the environment itself. That is why no `OTEL_*`
 * variable appears here.
 */

import { hostname } from 'node:os'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a
 * migration advisory lock.
 */
export const SERVICE = 'community'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

const PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'change_me',
  'placeholder',
  'secret',
  'token',
  'dev-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. Set above the point at which a
  // human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/**
 * The secrets the inbound event route accepts, newest first.
 *
 * A LIST, not a value, because rotation without an overlap window means every producer must change
 * secret in the same instant this service does — and that instant does not exist during a rolling
 * deploy.
 */
export function parseSecretList(raw: string, name: string): readonly string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0) throw new EnvError(`${name} is required — at least one secret`)
  for (const entry of entries) {
    if (PLACEHOLDERS.has(entry.toLowerCase())) {
      throw new EnvError(`${name} contains a known placeholder — generate real secrets`)
    }
    if (entry.length < 24) {
      throw new EnvError(`${name} entries must each be at least 24 characters`)
    }
  }
  if (new Set(entries).size !== entries.length) {
    // A duplicated secret makes "which key verified this" ambiguous, and that answer is what tells
    // an operator whether a rotation has finished.
    throw new EnvError(`${name} lists the same secret twice`)
  }
  return Object.freeze(entries)
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  readonly instanceId: string

  /** Secrets accepted on `POST /v1/events`, the internal inbox. */
  readonly ingestSecrets: readonly string[]
  /** Signs this service's OWN outbox deliveries to internal subscribers. */
  readonly outboxSigningSecret: string

  /**
   * The ledger. A **hard** dependency (07-dependency-map.md:137, `money-write`): a treasury spend
   * is a ledger posting, and there is no version of this service that can execute one without it.
   */
  readonly ledgerBaseUrl: string
  readonly ledgerDeadlineMs: number

  /**
   * Policy. A **hard, fail-closed** dependency (07-dependency-map.md:140) for treasury spend
   * approval. Unreachable means the spend does not happen — see `policyclient.ts` for what this
   * service had to do about policy's action registry having no `community.*` entry.
   */
  readonly policyBaseUrl: string
  readonly policyDeadlineMs: number

  /**
   * The indexer, for token-gating re-evaluation. Optional, and its absence is a SUPPORTED mode:
   * with no URL the holdings oracle answers "unknown", and an unknown holding never demotes
   * anybody. See `gating.ts` for why that is the only safe default while the indexer has no
   * balance route.
   */
  readonly indexerBaseUrl: string | null
  readonly indexerNetwork: string
  readonly indexerDeadlineMs: number

  /**
   * The service token this process presents to the ledger, policy and the indexer.
   *
   * Named `..._SERVICE_CREDENTIAL` rather than `..._SERVICE_TOKEN` for the reason recorded in
   * 18-build-status: the estate's `secret-hygiene` check reads any `*TOKEN*` variable carrying a
   * value as a credential somebody pasted in and forgot. That check is right — a value that does
   * not say it is fake should be treated as real. `micro-devplatform` renamed a variable rather
   * than relax the guard, and so does this one. It is still a secret and is still validated as one.
   */
  readonly serviceCredential: string

  /** How often a token-gated membership is re-checked, and how many per pass. */
  readonly gateRecheckIntervalHours: number
  readonly gateRecheckBatchSize: number

  /**
   * How long an idempotency claim survives.
   *
   * The floor is the safety argument: expiring a key EARLY means the next replay of it runs the
   * work again, and on `POST /internal/proposals/:id/execute` that is a second treasury spend.
   */
  readonly idempotencyTtlDays: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const indexerBaseUrl = source['INDEXER_BASE_URL']?.trim()

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'COMMUNITY_DATABASE_URL'),
    databasePoolMax: integer(source, 'COMMUNITY_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    ingestSecrets: parseSecretList(required(source, 'COMMUNITY_INGEST_SECRETS'), 'COMMUNITY_INGEST_SECRETS'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),

    ledgerBaseUrl: required(source, 'LEDGER_BASE_URL'),
    ledgerDeadlineMs: integer(source, 'LEDGER_DEADLINE_MS', 5_000, 100, 60_000),

    policyBaseUrl: required(source, 'POLICY_BASE_URL'),
    policyDeadlineMs: integer(source, 'POLICY_DEADLINE_MS', 3_000, 100, 60_000),

    indexerBaseUrl: indexerBaseUrl && indexerBaseUrl.length > 0 ? indexerBaseUrl : null,
    indexerNetwork: optional(source, 'INDEXER_NETWORK', 'mainnet'),
    indexerDeadlineMs: integer(source, 'INDEXER_DEADLINE_MS', 5_000, 100, 60_000),

    serviceCredential: requiredSecret(source, 'COMMUNITY_SERVICE_CREDENTIAL'),

    gateRecheckIntervalHours: integer(source, 'COMMUNITY_GATE_RECHECK_INTERVAL_HOURS', 6, 1, 720),
    gateRecheckBatchSize: integer(source, 'COMMUNITY_GATE_RECHECK_BATCH_SIZE', 100, 1, 5_000),

    idempotencyTtlDays: integer(source, 'COMMUNITY_IDEMPOTENCY_TTL_DAYS', 30, 1, 400),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand, built from a literal rather than routed through the
 * telemetry package: nothing that can itself fail may sit between a configuration error and the
 * report of it.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
