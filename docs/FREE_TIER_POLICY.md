# Free-only deployment policy

Veriq must use free services with hard provider limits. Do not enable paid plans,
automatic overages, paid fallbacks, trials that convert to paid subscriptions,
prepaid AI credits or new billable resources. Keep the existing Cloudflare
account and project; do not create a replacement tenant or URL. The repository
does not verify the account's plan itself; an owner must verify it before any
hosted AI release.

## Allowed production services

| Service | Requirement and behavior at the limit |
| --- | --- |
| Cloudflare Pages / Workers | Verify the existing account is on Workers Free before publishing. Limits may stop service; never upgrade to restore capacity. |
| Workers AI | Retain the direct `@cf/openai/gpt-oss-20b` binding. Provider free allocation can stop requests at its account-wide limit; no paid fallback, AI Gateway credits or alternate provider is allowed. |
| D1 | Use the existing Free-plan database and accept provider-enforced read/write/storage limits. Account limits may be shared with other applications. |
| MFA encryption secret | `MFA_ENCRYPTION_KEY` is a zero-cost Worker secret: an operator provisions a base64 encoding of 32 random bytes, keeps an encrypted backup and plans deliberate rotation. Missing or changed key material fails closed; never commit or print the value. |
| R2 | **Excluded from production.** Its allowance permits billable overages. Use simulated local storage only. |

Sources checked October 9, 2026: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and
[R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## What the code enforces

`WORKERS_FREE_PLAN_CONFIRMED` defaults to `"false"`. New AI reviews and chat
generation return `503 FREE_PLAN_UNCONFIRMED` before any model call or generation
quota reservation unless it is exactly `"true"`. Authenticated policy/bookmark
operations, saved history and human decisions remain available. The UI disables
generation and explains the pause.

The app also reports shared application ceilings through `/api/usage.sharedAi`:
50 calls/day, 1,000,000 UTF-8 input bytes/day and 100,000 requested output
tokens/day, with used/remaining values and reset time. Requested output tokens
are a conservative reservation ceiling, not a measurement of model tokens.
Failed and timed-out attempts remain counted. These limits are separate from
per-account review/chat allowances and from the provider's free allocation;
none guarantees that AI is available.

An operator may set `WORKERS_FREE_PLAN_CONFIRMED=true` only after verifying the
existing account's current Workers Free plan and direct AI binding. This is an
attestation, not billing detection. The Worker cannot inspect account upgrades,
shared provider usage or other applications. Recheck the plan and secret
metadata for each deployment; reset the flag if the plan or key changes. Do not
claim that the account is verified from application health alone.

Production ignores any `MEDIA` binding, even if added accidentally. Media
operations require `LOCAL_MEDIA_DEMO="true"` and an HTTP loopback request
(localhost, 127.0.0.1 or ::1). Local configuration must use simulated storage,
never a remote binding. See [local media setup](EVIDENCE_CHAT.md).

`GET /api/health` reports coordinated version 9, `billingMode:free_only`,
`aiAvailable`, `mfaAvailable`, `mediaAvailable`, and capabilities including
`free_tier_policy`, `shared_ai_capacity`, `full_policy_scope`, `totp_mfa`,
`invitation_admission`, `offline_recovery`, and `workspace_lifecycle`. These
describe application configuration, not proof of account subscription,
provider capacity, model quality or continuous availability. The release check
still requires operator plan/secret verification and a signed-in smoke.

## Pilot scope under this constraint

The hosted pilot can check drafts against the full active bounded workspace
policy set, generate checked AI chat replies, store approved policy versions and
bookmarks, attach approved links, record human decisions and collect feedback.
Media upload/download is a local demonstration only. Do not advertise hosted
file storage or promise always-on AI.

Hitting a free limit is an availability failure, not permission to spend. App
quotas and shared ceilings control abuse; they do not translate into an exact
provider budget. A long policy set or several claims may exhaust provider
capacity earlier. Do not report unsupported machine findings as supported when
model evaluation fails.
