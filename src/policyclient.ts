/**
 * The policy service, as this service uses it.
 *
 * `07-dependency-map.md:140` makes policy a **hard, fail-closed** dependency of this service for
 * "Treasury spend approval". That is the correct direction: an unchecked spend from a community
 * treasury is money leaving an account nobody can undo, and SD-10 puts every money-movement
 * control in the fail-closed column. So an unreachable policy service means the execution does
 * **not** happen — the job's lease expires, the proposal stays `timelocked`, and it is retried.
 * Nothing is spent while we do not know whether it should be.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **POLICY CANNOT EXPRESS A COMMUNITY SUBJECT, AND CANNOT NAME THIS ACTION. VERIFIED, NOT ASSUMED.**
 *
 * Two facts about the deployed policy service, read from its source rather than from the
 * dependency map:
 *
 *   1. `policy/src/actions.ts:89-163` is the closed action registry, and it contains no
 *      `community.*` action. `parseRequestAction` (`policy/src/server.ts:651-656`) answers **400**
 *      for an unregistered name — deliberately, so a caller cannot invent an action and receive a
 *      vacuous allow.
 *   2. `SUBJECT_PATTERN` (`policy/src/server.ts:94`) is
 *      `^(?:system|(?:user|service|operator):[A-Za-z0-9._:-]{1,128})$`. There is no `community:`
 *      arm. The subject a community treasury spend is *about* is exactly the one policy has no
 *      grammar for, so `subject: 'community:<id>'` is a **400** too.
 *
 * A client that sent the obvious request would therefore 400 on every single treasury spend. With
 * a fail-closed gate that means **no community could ever spend its treasury**, and the symptom
 * would be a passed vote that silently never executes — the exact shape of the `market` → `policy`
 * defect recorded in 18-build-status.md §3.3, where a misspelled route closed the whole
 * marketplace and read as moderation.
 *
 * **So this client calls the route that exists, with the action that exists.**
 * `ledger.treasury_spend` — "A spend from a platform treasury account rather than a user account",
 * `failMode: closed`, `policy/src/actions.ts:107-111` — is the registered action for precisely
 * this decision, and the subject is `service:community`, which policy's grammar accepts. The
 * community is carried in `resource` as a URN, which policy stores verbatim, so a decision row
 * read months later says which community and which proposal without a lookup table.
 *
 * **What is lost by that, said plainly:** policy's per-subject velocity counters count every
 * community as one subject, so a per-community spend cap cannot be expressed until policy grows a
 * `community:` subject arm and a `community.treasury.spend` action. Recorded in the README and in
 * the report, and NOT fixed here — `micro-policy` is not this repository's to change, and a
 * subject grammar is the kind of edit that changes what every existing rule means.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient, HttpError } from '@cloudsforge/http'

export const POLICY_SCOPES: readonly string[] = Object.freeze(['policy:decide'])

/**
 * The action name, spelled as policy's closed registry spells it.
 *
 * A constant rather than a literal at the call site, so `policyclient.test.ts` can assert it
 * against the registry's actual contents — which are copied into that test as literals, because
 * rule 2 forbids importing another service's source and a check that imported it would not be a
 * contract test anyway.
 */
export const SPEND_ACTION = 'ledger.treasury_spend'

/**
 * The subject policy is told about. See the header: `community:<id>` is not expressible in
 * policy's subject grammar, so the caller is named instead and the community travels in the
 * resource URN.
 */
export const SPEND_SUBJECT = 'service:community'

export type PolicyDecision = 'allow' | 'review' | 'deny'

export interface PolicyVerdict {
  readonly decision: PolicyDecision
  readonly reasons: readonly string[]
}

export interface SpendPolicyInput {
  readonly communityId: string
  readonly proposalId: string
  /** As a decimal string. Policy is a different service; an amount crosses as text. */
  readonly amount: string
  readonly assetCode: string
  readonly recipientSubject: string
  readonly correlationId: string
}

/**
 * Policy could not be reached, or answered in a shape that cannot be read as a decision.
 *
 * A distinct error rather than a `degraded` verdict, because there is no fail-open branch here
 * for it to feed. The caller must abandon the execution attempt and let the job retry — and the
 * type system should not offer it any other option.
 */
export class PolicyUnavailableError extends Error {
  constructor(message: string) {
    super(`the treasury spend gate is unavailable: ${message}`)
    this.name = 'PolicyUnavailableError'
  }
}

export interface PolicyClient {
  evaluateSpend(input: SpendPolicyInput): Promise<PolicyVerdict>
}

export interface PolicyClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

/** The URN a decision row carries. Readable a year later without joining anything. */
export function spendResourceUrn(communityId: string, proposalId: string): string {
  return `cf:community:${communityId}:proposal:${proposalId}`
}

export function httpPolicyClient(options: PolicyClientOptions): PolicyClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'policy',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async evaluateSpend(input) {
      let body: { decision?: { decision?: string; reasons?: readonly string[] } }
      try {
        // `POST /decisions`. Policy has NO `/v1` routes at all (`policy/src/server.ts:337`) and
        // takes the action in the body rather than the path.
        body = await client.request('/decisions', {
          method: 'POST',
          body: {
            subject: SPEND_SUBJECT,
            action: SPEND_ACTION,
            resource: spendResourceUrn(input.communityId, input.proposalId),
            correlationId: input.correlationId,
            context: {
              // A DECIMAL STRING. Policy rejects a JSON number outright rather than coercing it,
              // because a threshold comparison on a float is the bug that service exists not to
              // have (`policy/src/server.ts:658` — `DECIMAL_PATTERN`).
              amount: input.amount,
              asset: input.assetCode,
              // Carried in the context so a rule can be written against them the day policy grows
              // one. Neither is load-bearing today.
              communityId: input.communityId,
              recipient: input.recipientSubject,
            },
          },
        })
      } catch (err) {
        // A 404 or 405 is NOT policy deciding — it is policy not having that route, which is our
        // own misconfiguration and says nothing about this spend. It is still fatal here, because
        // fail-closed means an unanswered question stops the spend; what it must not become is a
        // `deny` recorded against the community, which would read to its members as the platform
        // refusing their vote. 18-build-status.md §3.3: the two failures need opposite fixes, so
        // they are told apart here rather than collapsed.
        if (err instanceof HttpError && err.status !== 404 && err.status !== 405 && err.peerDecided) {
          // A 4xx is policy DECIDING (or refusing our request as malformed). Either way the spend
          // does not happen; the reason is preserved so an operator can tell a rejected spend from
          // a rejected request.
          return { decision: 'deny', reasons: [`policy_${err.status}`] }
        }
        throw new PolicyUnavailableError(err instanceof Error ? err.message : String(err))
      }

      // Policy answers 201 with `{decision: {...}}`. A success whose body cannot be read is not an
      // allow: treating an unparseable 201 as permission would make a response-shape change
      // silently open the gate on the only fail-closed control this service has.
      const verdict = body.decision?.decision
      if (verdict !== 'allow' && verdict !== 'review' && verdict !== 'deny') {
        throw new PolicyUnavailableError('policy answered a body that is not a decision')
      }
      return { decision: verdict, reasons: [...(body.decision?.reasons ?? [])] }
    },
  }
}
