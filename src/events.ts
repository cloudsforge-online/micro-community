/**
 * The topics this service produces.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`community.*` IS NOT REGISTERED IN `@cloudsforge/contracts-events`. RECORDED, NOT FIXED.**
 *
 * `07-dependency-map.md:180` names `community.proposal.executed`, keyed by `proposal_id`, with
 * ledger, activity and notify as its consumers. `contracts/packages/events/src/index.ts` registers
 * no `community.*` topic — though `'community'` IS a valid `ProducerService` in that file's union,
 * so the gap is an omission from `TOPICS` rather than a decision that this service produces
 * nothing.
 *
 * The consequence is the same one `micro-devplatform` hit and recorded (18-build-status.md §3.3h,
 * final paragraph): the topic names cannot be taken from the contract package, so they are spelled
 * here. The contracts repository is not this repository's to change, and adding a topic to a
 * frozen contract package from a consumer is exactly the drift that package exists to prevent.
 *
 * What that costs: a consumer of `community.proposal.executed` has no versioned payload type to
 * compile against, so the wire shape below is a promise made in prose. It is kept deliberately
 * flat and additive, and `outbox.test.ts` pins it — a change to these payloads breaks a test in
 * this repository, which is the only gate available until the topic is registered.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Naming follows the estate's rule: `<service>.<aggregate>.<past-tense-verb>`, keyed by the
 * aggregate id so that ordering per `(topic, key)` means what a consumer expects.
 */

export const TOPICS = Object.freeze({
  communityCreated: 'community.community.created',
  memberJoined: 'community.membership.joined',
  memberRoleChanged: 'community.membership.role_changed',
  memberDemoted: 'community.membership.demoted',
  proposalCreated: 'community.proposal.created',
  proposalOpened: 'community.proposal.opened',
  proposalClosed: 'community.proposal.closed',
  /**
   * The one 07-dependency-map.md:180 names. Keyed by `proposal_id`, consumed by ledger, activity
   * and notify.
   *
   * It carries `ledgerEntryId` because that is the only thing a consumer can reconcile against:
   * "a spend happened" without naming the entry leaves activity and notify unable to tell a
   * replayed event from a second spend.
   */
  proposalExecuted: 'community.proposal.executed',
  delegationCreated: 'community.delegation.created',
  delegationRevoked: 'community.delegation.revoked',
  voteCast: 'community.vote.cast',
} as const)

export type Topic = (typeof TOPICS)[keyof typeof TOPICS]

export const TOPIC_NAMES: readonly Topic[] = Object.freeze(Object.values(TOPICS))

/* ------------------------------------------------------------------ consumed */

/**
 * `identity.user.deleted` — the GDPR erasure path, and not optional for any service storing a
 * `user_id` (17-definition-of-done.md §2).
 *
 * **What erasure means HERE is not "delete the rows", and that is a decision rather than a
 * shortcut.** A recorded vote is part of a governance record that other people relied on when
 * they decided how to vote; deleting it silently changes a historical tally and can retroactively
 * un-pass a proposal that has already spent money. So the subject is *pseudonymised*: memberships
 * and delegations for the subject are revoked, discussion posts are redacted, and vote rows keep
 * their weight and choice while the subject becomes an opaque erasure token. The tally is
 * unchanged and the person is no longer identifiable from it.
 */
export const USER_DELETED_TOPIC = 'identity.user.deleted'

/**
 * `billing.entitlement.granted` / `.revoked` — 07-dependency-map.md:174-175 names community as a
 * consumer of both. A community plan buys capacity, never governance (15-monetisation §3.10:
 * "a community that cannot vote until it pays is not a community"), so acting on these must never
 * touch a proposal, a vote or a treasury.
 */
export const ENTITLEMENT_GRANTED_TOPIC = 'billing.entitlement.granted'
export const ENTITLEMENT_REVOKED_TOPIC = 'billing.entitlement.revoked'

export const CONSUMED_TOPICS: readonly string[] = Object.freeze([
  USER_DELETED_TOPIC,
  ENTITLEMENT_GRANTED_TOPIC,
  ENTITLEMENT_REVOKED_TOPIC,
])
