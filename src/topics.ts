/**
 * The producer half of the bus contract: what this service puts on the wire, and whether the
 * estate can read it.
 *
 * ## The defect this file exists to close
 *
 * Every consumer in the estate is pinned to `@cloudsforge/contracts-events`. `activity` declares
 * its classifier table `satisfies Readonly<Record<TopicName, _>>`; `notify` asserts it has a rule
 * for every registry topic. **The producer was pinned to nothing at all** — not to the topic names
 * and, worse, not to the shape of the envelope it wrote them into.
 *
 * Two instances of that one class have already cost the estate every event it ever relayed:
 *
 *   - **A version stamped wrong.** `EventEnvelope.version` is `` `${number}.${number}` `` in the
 *     contract — a "major.minor" STRING. Six producers typed it `number` end to end and sent `1`,
 *     and `validateEnvelope` refuses that with "version: missing". The signature verified, the
 *     delivery arrived, and the consumer threw it away at the envelope before anything looked at
 *     a payload. Each service's own suite stayed green throughout, because each tested against
 *     its own fake of the other side. **This service was one of them.**
 *   - **A topic renamed on the wire.** `wallet` emitted `wallet.deposit.credited` while the
 *     registry, `notify` and `activity` all spell it `wallet.deposit.confirmed`. Nothing could
 *     ever match it.
 *
 * These are the same defect wearing two hats: **the producer is free and the consumer is pinned.**
 * So this file pins the producer, in both directions and two ways:
 *
 *   1. **At compile time.** `EventEnvelope.version` in `outbox.ts` is the contract's
 *      `EventVersion`, imported rather than restated. Assigning the stored integer to it is a type
 *      error, which is `pnpm typecheck`, which is the build.
 *   2. **At test time, against the source rather than against this list.** `topics.test.ts` reads
 *      every topic literal out of `src/` and reconciles that set with the registry, and it builds
 *      a real envelope through the relay's own `buildEnvelope` and hands it to the contract's own
 *      `validateEnvelope`.
 *
 * ## Why the reconciliation matters more here than in most services
 *
 * `events.ts` carried a boxed paragraph asserting that the registry named no `community.*` topic
 * at all. It named three. A prose claim about another repository's state is a claim that goes
 * stale the moment somebody acts on it, and the whole point of the list below is that it cannot:
 * `adoptedProposals()` fails the build the day contracts registers a fourth.
 */

import {
  isRegisteredTopic,
  isValidTopicName,
  topicsProducedBy,
  validateEnvelope,
  type TopicName,
  type TopicSpec,
} from '@cloudsforge/contracts-events'
import { TOPIC_NAMES as EMITTED } from './events.ts'

/** This service's own name, and the namespace it is the only permitted producer under. */
export const SERVICE = 'community'

/**
 * Every topic this service emits.
 *
 * Taken from `events.ts` rather than retyped, so this list cannot name a topic whose spelling has
 * since changed under it. `topics.test.ts` additionally reads the literals back out of `src/`, so
 * `events.ts` cannot name one that no emit site produces either.
 */
export const EMITTED_TOPICS: readonly string[] = EMITTED

export interface ProposedTopic {
  /** Why the fact belongs on the bus at all. Read by a human reviewing the contracts change. */
  readonly reason: string
  /** The entry to add to `TOPICS` in `@cloudsforge/contracts-events`, verbatim. */
  readonly spec: TopicSpec
}

/**
 * Topics this service emits that the shared registry does not yet name.
 *
 * A quarantine, not an exemption, with the three properties that keep identity's honest:
 *
 *   - An entry carries the exact `TopicSpec` it is asking for, so adopting it into
 *     `contracts/packages/events/src/index.ts` is a copy rather than a fresh design.
 *   - `topics.test.ts` asserts every entry is **genuinely absent** from the registry. The moment
 *     contracts registers one, this file fails until the entry is deleted — so the quarantine
 *     empties itself rather than rotting into a permanent allow-list. That is exactly what the
 *     boxed paragraph in `events.ts` could not do.
 *   - An emit site whose topic is in neither the registry nor here fails the test.
 *
 * `keyedBy` on each is read off the emit site, never chosen here: the key is the ordering
 * partition, so it is contract rather than a producer's private preference. Note that the three
 * ALREADY registered proposal/vote topics are keyed by `proposal_id` while
 * `community.proposal.executed` is keyed by `community_id` — the family does not share a key, and
 * a consumer that assumed it did would mis-order two of the three.
 */
export const AWAITING_REGISTRATION: Readonly<Record<string, ProposedTopic>> = Object.freeze({
  'community.community.created': {
    reason:
      'A community exists, with a treasury account behind it. ledger and activity both have a reason to hear it and neither can today.',
    spec: {
      producer: 'community',
      payloadType: 'CommunityCreated',
      version: '1.0',
      keyedBy: 'community_id',
      description: 'A community was created, with its governance model and treasury account.',
    },
  },
  'community.membership.joined': {
    reason:
      "Membership is what decides who notify fans a proposal out to. Without the event, every consumer's idea of the membership is a query it has to remember to make.",
    spec: {
      producer: 'community',
      payloadType: 'MemberJoined',
      version: '1.0',
      keyedBy: 'community_id',
      description: 'A subject joined a community, with the role it joined at.',
    },
  },
  'community.membership.role_changed': {
    reason:
      'A role change is an authority change. An audit trail that has to be reconstructed from rows is not an audit trail.',
    spec: {
      producer: 'community',
      payloadType: 'MemberRoleChanged',
      version: '1.0',
      keyedBy: 'community_id',
      description: "A member's role changed, carrying the previous role and the new one.",
    },
  },
  'community.membership.demoted': {
    reason:
      'A token gate found a member no longer holds what the community requires, and demoted them WITHOUT anybody asking. The member is entitled to be told, and only notify can tell them.',
    spec: {
      producer: 'community',
      payloadType: 'MemberDemoted',
      version: '1.0',
      keyedBy: 'community_id',
      description: 'A token gate demoted a member whose holding fell short after the grace window.',
    },
  },
  'community.proposal.created': {
    reason:
      'The start of the lifecycle whose other three stages ARE registered. A registry that names opened, executed and vote.cast but not created gives activity a narrative that begins in the middle.',
    spec: {
      producer: 'community',
      payloadType: 'ProposalCreated',
      version: '1.0',
      keyedBy: 'proposal_id',
      description: 'A proposal was drafted into discussion, with its kind and voting model.',
    },
  },
  'community.proposal.closed': {
    reason:
      'The tally landed and the proposal passed or was rejected. This is the ONLY event carrying the outcome for a proposal that did not pass — a rejected proposal never reaches proposal.executed, so without this its authors learn nothing.',
    spec: {
      producer: 'community',
      payloadType: 'ProposalClosed',
      version: '1.0',
      keyedBy: 'proposal_id',
      description: 'A voting window closed and the proposal was recorded as passed or rejected.',
    },
  },
  'community.delegation.created': {
    reason:
      'Somebody handed their voting power to somebody else. A governance record nobody outside this service can see is a governance record that cannot be audited.',
    spec: {
      producer: 'community',
      payloadType: 'DelegationCreated',
      version: '1.0',
      keyedBy: 'community_id',
      description: 'A member delegated their voting power to another subject.',
    },
  },
  'community.delegation.revoked': {
    reason: 'The other half. Without it a consumer believes a delegation stands for ever.',
    spec: {
      producer: 'community',
      payloadType: 'DelegationRevoked',
      version: '1.0',
      keyedBy: 'community_id',
      description: 'A delegation was withdrawn.',
    },
  },
})

/* ------------------------------------------------------------------ reconciliation */

/** Topics this service emits that no registry names and no proposal explains — always a defect. */
export function undeclaredTopics(emitted: readonly string[]): readonly string[] {
  return emitted
    .filter((topic) => !isRegisteredTopic(topic) && !Object.hasOwn(AWAITING_REGISTRATION, topic))
    .sort()
}

/**
 * Registry topics this service owns and never emits — a feature that can never fire.
 *
 * The direction that is easiest to miss, because nothing breaks and nothing logs: consumers
 * classify the topic, the code path renders it, and nothing ever arrives.
 */
export function unemittedOwnedTopics(emitted: readonly string[]): readonly TopicName[] {
  const seen = new Set(emitted)
  return topicsProducedBy(SERVICE).filter((topic) => !seen.has(topic))
}

/** Proposals the registry has since adopted. Non-empty means delete the entry from the quarantine. */
export function adoptedProposals(): readonly string[] {
  return Object.keys(AWAITING_REGISTRATION).filter(isRegisteredTopic).sort()
}

/** A proposal that could not be pasted into the registry as it stands. */
export function malformedProposals(): readonly string[] {
  return Object.entries(AWAITING_REGISTRATION)
    .filter(([topic, proposal]) => {
      if (!isValidTopicName(topic) || !topic.startsWith(`${SERVICE}.`)) return true
      if (proposal.spec.producer !== SERVICE) return true
      if (proposal.spec.keyedBy.trim() === '') return true
      if (proposal.reason.trim().length < 20) return true
      return false
    })
    .map(([topic]) => topic)
    .sort()
}

/* ------------------------------------------------------------------ the envelope */

/**
 * Every reason a contract-following consumer would refuse this envelope.
 *
 * `validateEnvelope` is the contract's own function and is the exact check that `activity` and
 * `notify` run on a delivered body. Running it here, on an envelope this service's relay actually
 * built, is the only way a producer finds out it is unreadable without waiting for two services to
 * be composed — which is how this was found the first time, months late.
 *
 * **One error is tolerated and only one:** "not in this registry", and only for a topic the
 * quarantine above explains. That is a consumer being behind its producers, which is a normal
 * consequence of deploying twenty-two services independently and which `activity` handles by
 * quarantining rather than dropping. Every other error — a version in the wrong shape, a missing
 * correlation id, an id that is not a UUID, a producer that does not own its topic — is this
 * service emitting something nobody can read, and is returned.
 */
export function envelopeDefects(envelope: unknown): readonly string[] {
  const verdict = validateEnvelope(envelope)
  if (verdict.ok) return []
  const topic =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as Record<string, unknown>)['topic']
      : undefined
  const excused =
    typeof topic === 'string' && Object.hasOwn(AWAITING_REGISTRATION, topic)
      ? `topic: "${topic}" is not in this registry; contracts-events may be behind`
      : null
  return verdict.errors.filter((error) => error !== excused)
}
