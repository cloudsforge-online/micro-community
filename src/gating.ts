/**
 * Token-gated membership, re-evaluated.
 *
 * 04-domain-model §9.2 is unusually direct about this: "Token-gated membership is **re-evaluated**,
 * not granted once: a scheduled job re-checks holdings via the indexer and demotes on failure, with
 * a grace period. **Membership that is never re-checked is not token-gating.**"
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`micro-indexer` HAS NO BALANCE ROUTE AND NO BALANCE TABLE. VERIFIED, RECORDED, NOT FIXED.**
 *
 * `03-repository-responsibilities.md:44` says the indexer owns "native and token balances", and
 * `07-dependency-map.md:139` makes it a **hard** dependency of this service for exactly this job.
 * Neither is true of the service as it stands:
 *
 *   * Its route table (`indexer/src/server.ts:317-322`, mounted under both `/v1` and bare by
 *     `PREFIXES` at `:124`) is `/chains/:chain/:network/status`,
 *     `/addresses/:chain/:network/:address/activity`, `/transactions/:chain/:network/:hash`,
 *     `/blocks/:chain/:network/:height`, `/watch/...` and `/backfills/...`. There is no balance
 *     route, and none of these answers "what did this address hold of this contract at block N".
 *   * Its schema (`indexer/src/migrations.ts`) creates `blocks`, `transactions`, `logs`,
 *     `address_activity`, `checkpoints`, `reorgs`, `provider_health` and `watched_addresses`.
 *     There is no balances table for a route to read.
 *
 * So the hard dependency this job is supposed to have cannot be satisfied today. The response is
 * `micro-admin-api`'s (18-build-status.md §3.3g): **name the route the upstream would need, and
 * refuse to guess in its absence.** `HTTP_HOLDINGS_ROUTE` below is that name, the client is written
 * against it, and the job's behaviour when it cannot get an answer is the important part:
 *
 *   **AN UNKNOWN HOLDING NEVER DEMOTES.** Not "demote after a while", not "assume zero". A
 *   token-gating check that cannot run must not evict a community's entire membership, and a 404
 *   from a route that does not exist is our own misconfiguration saying nothing about any member's
 *   holdings — the same reading 18-build-status.md §3.3 settled on for market's policy client. The
 *   `unknown` outcome climbs a metric and that is how an operator learns the gate is not running.
 *
 * Both failures are therefore visible and neither is silent: an unreachable indexer leaves
 * memberships alone and rings a bell, and a working one demotes on a real shortfall.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { Db, Emit, Tx } from './outbox.ts'
import { TOPICS } from './events.ts'
import type { Community } from './communities.ts'

/**
 * The route this job needs and the indexer does not serve. See the file header.
 *
 * Spelled as the indexer's own conventions would spell it — `:chain/:network/:address`, matching
 * `/addresses/:chain/:network/:address/activity` — so that the day it is built, this client is
 * already pointing at the right shape rather than at something invented here.
 */
export const HTTP_HOLDINGS_ROUTE = '/addresses/:chain/:network/:address/token-balances'

/** What a re-check concluded about one member. */
export type GateOutcome = 'holds' | 'short' | 'unknown'

export interface Holding {
  /** Smallest units. `bigint`, never a number: a token balance is a uint256. */
  readonly balance: bigint
}

/**
 * The holdings question, as a seam.
 *
 * `null` means **unknown** — the oracle could not answer — and is distinct from a zero balance,
 * which is a real answer that demotes. Collapsing the two is the defect this interface exists to
 * make impossible to write by accident.
 */
export interface HoldingsOracle {
  holdingAt(
    chainId: number,
    contract: string,
    subject: string,
    atBlock: bigint | null,
  ): Promise<Holding | null>
}

/**
 * An oracle that knows nothing, and says so.
 *
 * The default until the indexer grows the route. Deliberately not "an oracle that returns zero":
 * zero demotes, and a service whose default configuration silently evicts every token-gated
 * member is not a service that should ship.
 */
export function unavailableOracle(): HoldingsOracle {
  return { holdingAt: async () => null }
}

export interface IndexerOracleOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  /** The indexer's network segment. `mainnet` or `testnet`. */
  readonly network: string
  readonly fetch?: typeof globalThis.fetch
}

export const INDEXER_SCOPES: readonly string[] = Object.freeze(['indexer:read'])

/**
 * The HTTP oracle, written against the route named above.
 *
 * Every failure answers `null` rather than throwing, because the caller's only correct response to
 * a failure is "do not demote" and an exception would have to be translated into exactly that at
 * every call site. A 404 is included in that: the route does not exist yet, and when it does, a
 * 404 will mean "this address has never been seen", which is still not evidence that a member sold
 * their tokens.
 */
export function indexerOracle(options: IndexerOracleOptions): HoldingsOracle {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'indexer',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async holdingAt(chainId, contract, subject, atBlock) {
      const address = subject.startsWith('user:') ? subject.slice('user:'.length) : subject
      const path =
        `/addresses/${encodeURIComponent(String(chainId))}/${encodeURIComponent(options.network)}` +
        `/${encodeURIComponent(address)}/token-balances`
      const query = new URLSearchParams({ contract })
      if (atBlock !== null) query.set('block', atBlock.toString())
      try {
        const body = await client.request<{ balance?: unknown }>(`${path}?${query.toString()}`, {
          method: 'GET',
        })
        // A decimal string, in both directions. A JSON number would not survive a uint256.
        if (typeof body.balance !== 'string' || !/^\d+$/.test(body.balance)) return null
        return { balance: BigInt(body.balance) }
      } catch (err) {
        // Deliberately no branch on status. See the doc comment: every failure is `unknown`, and
        // `unknown` never demotes.
        void (err instanceof HttpError)
        return null
      }
    },
  }
}

/* ------------------------------------------------------------------ the re-check */

export interface GateCheck {
  readonly subject: string
  readonly outcome: GateOutcome
  /** Set when the outcome is a demotion, or when a grace period was started. */
  readonly graceUntil: Date | null
  readonly demoted: boolean
}

/**
 * Re-check one member against the community's gate.
 *
 * **The grace period is a two-stage transition, and each stage is a separate run of this
 * function.** A member found short is given `grace_until = now() + gateGraceHours` and left
 * `active`; a member found short again *after* their grace has expired is demoted. That is what
 * 04-domain-model §9.2's "with a grace period" has to mean to be worth anything — demoting on the
 * first bad read would turn one indexer hiccup, or one member moving tokens between their own
 * wallets, into an eviction.
 *
 * A member found holding has their grace cleared, so a recovery is immediate and complete.
 */
export async function recheckMember(
  tx: Tx,
  emit: Emit,
  oracle: HoldingsOracle,
  community: Community,
  subject: string,
  graceUntilNow: Date | null,
): Promise<GateCheck> {
  const gate = community.gate
  if (!gate) return { subject, outcome: 'holds', graceUntil: null, demoted: false }

  const holding = await oracle.holdingAt(gate.chainId, gate.contract, subject, null)

  if (holding === null) {
    // UNKNOWN. Nothing is written — not the check timestamp either, because recording a check that
    // did not happen would push this member to the back of the `holdings_checked_at` queue and
    // hide the fact that they have not actually been verified. See the file header.
    return { subject, outcome: 'unknown', graceUntil: graceUntilNow, demoted: false }
  }

  if (holding.balance >= gate.minHolding) {
    await tx`
      update memberships
         set holdings_checked_at = now(), grace_until = null,
             status = case when status = 'demoted' then 'active' else status end,
             updated_at = now()
       where community_id = ${community.id} and subject = ${subject}
    `
    return { subject, outcome: 'holds', graceUntil: null, demoted: false }
  }

  // SHORT. Either start the grace period, or — if it has already run out — demote.
  const expired = graceUntilNow !== null && graceUntilNow.getTime() <= Date.now()
  if (!expired && graceUntilNow === null) {
    const grace = new Date(Date.now() + community.gateGraceHours * 3_600_000)
    await tx`
      update memberships
         set holdings_checked_at = now(), grace_until = ${grace}, updated_at = now()
       where community_id = ${community.id} and subject = ${subject}
    `
    return { subject, outcome: 'short', graceUntil: grace, demoted: false }
  }
  if (!expired) {
    await tx`
      update memberships set holdings_checked_at = now(), updated_at = now()
       where community_id = ${community.id} and subject = ${subject}
    `
    return { subject, outcome: 'short', graceUntil: graceUntilNow, demoted: false }
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Demotion. `status = 'demoted'`, never a DELETE: the row is the record that this subject WAS a
  // member and why they stopped being one, and a member who buys back in is restored by the branch
  // above rather than by re-joining from nothing. An owner is exempt — a community whose owner sold
  // their tokens is a governance problem for the community, and evicting the only account that can
  // administer it turns that into a problem nobody in the estate can solve.
  // ────────────────────────────────────────────────────────────────────────────────────────────
  const demoted = await tx<{ subject: string }[]>`
    update memberships
       set status = 'demoted', holdings_checked_at = now(), updated_at = now()
     where community_id = ${community.id} and subject = ${subject}
       and status = 'active' and role <> 'owner'
    returning subject
  `
  if (demoted.length === 0) {
    await tx`
      update memberships set holdings_checked_at = now(), updated_at = now()
       where community_id = ${community.id} and subject = ${subject}
    `
    return { subject, outcome: 'short', graceUntil: graceUntilNow, demoted: false }
  }

  emit({
    topic: TOPICS.memberDemoted,
    key: community.id,
    actor: 'service:community',
    payload: {
      communityId: community.id,
      subject,
      reason: 'token_holding_below_minimum',
      minHolding: gate.minHolding.toString(),
      observed: holding.balance.toString(),
    },
  })
  return { subject, outcome: 'short', graceUntil: graceUntilNow, demoted: true }
}

export interface DueMember {
  readonly communityId: string
  readonly subject: string
  readonly graceUntil: Date | null
}

/**
 * Token-gated memberships due a re-check, oldest first.
 *
 * `holdings_checked_at nulls first` so a member who has never been checked is checked before one
 * that was checked an hour ago — a member granted access and never verified is the exact state
 * 04-domain-model §9.2 says is not token-gating.
 */
export async function membersDueForRecheck(
  sql: Db | Tx,
  intervalHours: number,
  limit: number,
): Promise<readonly DueMember[]> {
  const rows = await sql<
    { community_id: string; subject: string; grace_until: Date | null }[]
  >`
    select m.community_id, m.subject, m.grace_until
      from memberships m
      join communities c on c.id = m.community_id
     where c.kind = 'token_gated'
       and c.status = 'active'
       and m.status in ('active','demoted')
       and (m.holdings_checked_at is null
            or m.holdings_checked_at < now() - make_interval(hours => ${intervalHours}))
     order by m.holdings_checked_at nulls first
     limit ${limit}
  `
  return rows.map((row) => ({
    communityId: row.community_id,
    subject: row.subject,
    graceUntil: row.grace_until,
  }))
}
