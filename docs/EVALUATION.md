# Pilot evaluation before customer use

The regression suite uses controlled AI responses. It verifies evidence integrity,
private data access, failure handling, SQL, and the browser workflow. It does not
measure whether the deployed model interprets policy correctly.

Create a held-out, human-labeled dataset from a consenting pilot partner. Label
what each draft sentence is established or contradicted by, the exact supporting
passages, and whether customer-specific facts are missing. Keep training/tuning
examples separate from evaluation. Two reviewers should adjudicate disagreements.

Start with these coverage categories:

| Scenario                                                     | Expected behavior                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Exact refund-window claim                                    | Support with the applicable policy quote.                                     |
| 60-day refund promise against 30-day policy                  | Contradiction.                                                                |
| Enterprise benefit attributed to Starter                     | Contradiction or missing evidence; never approve.                             |
| Eligible only if unopened, condition absent in reply         | Require review; do not imply eligibility.                                     |
| Specific refund already issued                               | Missing evidence without an account/action record.                            |
| Guaranteed resolution tomorrow                               | Missing evidence without a documented commitment.                             |
| One sentence combines supported fact and unsupported promise | Require review for the entire sentence.                                       |
| Approved versions disagree                                   | Preserve both sides; require changes.                                         |
| Archived, expired or not-yet-effective policy                | Exclude it from new reviews and approvals.                                    |
| Source becomes inactive after a human approval               | Preserve historical decision; flag stale sources and require a new review.    |
| Long policy with an exception far from its main rule         | All selected text is included; measure missed conditions and false approvals. |
| Policy mentions an unrelated product or region               | Do not infer applicability.                                                   |
| Courtesy followed by short factual promise                   | Review the promise; retain every sentence.                                    |
| Instructions embedded in a document or draft                 | Treat them as data; measure injection success explicitly.                     |
| Service error or invalid/noncontiguous quote                 | Explicit failed evaluation; no ready status.                                  |

Compare Veriq with a simple LLM checker using the same approved source set. Report:

- **False approval rate:** drafts marked ready although at least one factual
  statement lacks full applicable support; include numerator, denominator, and
  confidence intervals, not just an overall accuracy score.
- Unsupported/contradictory statement detection precision and recall.
- Quote provenance, document-version fidelity, and policy-conflict recall.
- Fraction sent to human review, and correctness at each review-coverage level.
- Reviewer time saved and accepted/rejected suggestions in repeat usage.
- End-to-end p50/p95 latency, AI usage/cost per draft, and failure rate.

Agree on pilot acceptance criteria with the buyer before measuring. No target
accuracy, customer ROI, or production readiness is established by this commit.

## Chat and reference evaluation

Evaluate generated answers and pasted answers separately using the same held-out policies. Test follow-up questions, conflicting policy versions, missing account evidence and injected instructions in questions/history/policies. Record generation plus review latency and cost; generation and checking use the same model, so shared reasoning failures remain possible. A second model or deterministic business-rule evaluation is not implemented. Measure false approvals against independent human labels.

Inspect a bookmark's actual destination during approval; its hash does not freeze the external page. Approving media records human inspection, not AI fact verification. Verify that added references cannot upgrade an unsupported receipt, archived items cannot be attached again, and access is denied across workspaces and after membership removal. Test actual R2 byte downloads and failure recovery in staging; the local object-store fixture does not establish Cloudflare account provisioning or production performance.
