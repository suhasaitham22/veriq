# Free-only deployment policy

Veriq must use free services with hard provider limits. Do not enable paid plans, automatic overages, paid fallbacks, trials that convert to paid subscriptions, prepaid AI credits or new billable resources. Keep the existing Cloudflare account and project; do not create a replacement tenant or URL to work around account access.

## Allowed production services

| Service                    | Requirement and behavior at the limit                                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Pages / Workers | Verify the current Workers plan is **Free** in the existing account before publishing. Free limits may stop service; do not upgrade to restore capacity.                                                                                                                                      |
| Workers AI                 | Retain the direct `@cf/openai/gpt-oss-20b` binding. Workers Free includes 10,000 neurons/account/day and fails further requests at the limit, resetting at 00:00 UTC. Workers Paid can charge for excess use, so it is excluded. No AI Gateway credits or other paid model/provider fallback. |
| D1                         | Use the Free plan with provider-enforced read/write/storage limits. Queries or inserts may fail when the applicable limits are reached. Account limits are shared with other apps.                                                                                                            |
| KV                         | Not required by current authentication; if retained, use only the Free plan and its hard daily limits.                                                                                                                                                                                        |
| R2                         | **Excluded from production.** Its free storage/operation allowance permits billable overages. The app's per-workspace size and upload limits do not cap account-wide operations or charges.                                                                                                   |

Sources checked October 8, 2026: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## What the code enforces

`WORKERS_FREE_PLAN_CONFIRMED` defaults to `"false"`. New AI reviews and chat generation return `503 FREE_PLAN_UNCONFIRMED` before any model call or generation quota reservation unless it is exactly `"true"`. Authenticated policy/bookmark operations, saved history and human decisions remain available. The UI disables generation and explains the pause.

An operator may set this variable to `"true"` **only after verifying the existing account's current Workers Free plan and direct AI binding**. It is an attestation, not a billing API integration. The Worker cannot detect account upgrades, inspect shared account usage or guarantee that other apps incur no charges. Recheck the account plan for each deployment; reset the flag immediately if the plan changes. Do not enable AI on a paid account simply because estimated usage is small.

Production ignores any `MEDIA` binding, even if added accidentally. Media operations require `LOCAL_MEDIA_DEMO="true"` and an HTTP loopback request (localhost, 127.0.0.1 or ::1). This preserves emulator demonstrations without enabling remote media operations. Local configuration must use simulated R2, never a remote binding. See [local media setup](EVIDENCE_CHAT.md).

`GET /api/health` reports version 8, `billingMode:free_only`, `aiAvailable` and `mediaAvailable`. These describe application configuration; they are not proof of the account's actual subscription. The company-demo release check requires enabled AI and disabled production media, then still requires a signed-in live-AI workflow and dashboard billing verification.

## Pilot scope under this constraint

The hosted pilot can check drafts, generate checked AI chat replies, store approved policy versions and bookmarks, attach approved links, record human decisions and collect feedback. Media upload/download is a local demonstration only. Hosted media needs a different storage service with a verified hard zero-cost cap before it can be added. Do not advertise hosted file storage as working.

Hitting a free limit is an availability failure, not permission to spend. App request quotas control abuse; they do not translate into an exact neuron budget. A long policy set or several claims may exhaust the free daily allocation before the app's per-user quota. Do not report unsupported machine findings as supported when model evaluation fails.
