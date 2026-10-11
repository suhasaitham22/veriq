# Pilot evaluation before customer use

The regression suite and browser harness use controlled AI responses. They verify
provenance, private access, failure handling, SQL and the consumer workflow—not
the deployed model's semantic accuracy. The separate workerd/local-D1 smoke kept
AI disabled and had no AI binding. Neither is a live-model benchmark.

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
| Long policy with an exception far from its main rule         | The full active workspace corpus reaches the model; measure missed conditions and unsafe ready findings. |
| Policy mentions an unrelated product or region               | Do not infer applicability.                                                   |
| Courtesy followed by short factual promise                   | Review the promise; retain every sentence.                                    |
| Instructions embedded in a document or draft                 | Treat them as data; measure injection success explicitly.                     |
| Service error or invalid/noncontiguous quote                 | Explicit failed evaluation; no ready status.                                  |

Compare Veriq with a simple LLM checker using the same **complete active policy
set in the same bounded workspace domain**. Report:

- **Unsafe model-ready findings:** drafts marked ready although a factual
  statement lacks full applicable support. Distinguish the share of all scored
  cases, the false-positive rate among human-unsafe cases, and the unsafe share
  of model-ready results. Include numerator, denominator and confidence intervals,
  not just overall agreement. A model-ready finding is not a human approval.
- Unsupported/contradictory statement detection precision and recall.
- Quote provenance, document-version fidelity, and policy-conflict recall.
- Fraction sent to human review, and correctness at each review-coverage level.
- Reviewer time saved and accepted/rejected suggestions in repeat usage.
- End-to-end p50/p95 latency, AI usage/cost per draft, and failure rate.

Agree on pilot acceptance criteria with the buyer before measuring. No target
accuracy, customer ROI, or production readiness follows from passing the offline
tool or the application regression suite.

## Offline scoring tool

The delivered runner is **`apps/api/evaluation/evaluate.mjs`**, not a deployment
script. It reads local files only, makes no network/model calls, and accepts
actual exported review records. It does not generate missing results or invent
labels.

```sh
node apps/api/evaluation/evaluate.mjs \
  --labels labels.jsonl \
  --reviews captured-reviews.jsonl \
  --json
```

The label file is JSONL: one header, then one independently labeled case per
line. The header requires `datasetVersion:1`, a `dataset` name, and `labelSource`
of `customer_labeled` or `fictional_fixture`. Do not label synthetic data as
customer evidence. Each case requires a unique `id`, an `expected` status
(`ready_for_review`, `requires_changes` or `needs_review`), and optional
`requiredQuotes` and `note`.

Capture each result through `GET /api/reviews/:id/export` or the application's
review download, while retaining the exact policy versions and case mapping.
Place each complete export object on one line of `captured-reviews.jsonl`; its
`id` must match the corresponding label. Whole application exports already have
the required `{id,review}` fields; no fabricated response shape is needed.
For example, local `jq -c . exports/*.json > captured-reviews.jsonl` compacts
downloaded files into JSONL. Use a fresh output path and protect these private
files. If case IDs were assigned before a blinded evaluation, wrap the actual
exported `review` value as `{id:<case ID>,review:<exported review>}` and keep the
mapping. Record refused calls as `{id:<case ID>,error:{code:<actual API code>}}`;
do not silently omit timeouts, quotas or unavailable-policy cases.

The report contains expected/observed confusion counts, `falseReady` cases,
literal required-quote coverage, and explicit `missing_review`/`review_error`
unscored cases. **`falseReady.rate = falseReady.count / totals.scored`**: it is
the unsafe-ready share of all scored cases, not the conditional false-positive
rate or a human-approval rate. Derive conditional rates from the confusion
matrix and report their denominators. Quote coverage only checks whether a
returned quote contains required text; it does not assess entailment.

Exit codes are `0` for a completely scored input, `1` for invalid input, and
`2` when unscored cases remain. `--allow-unscored` explicitly permits a partial
capture to exit0 but still reports every omission. Exit0 does **not** mean the
model passed a buyer's quality gate. Duplicate case IDs, missing IDs, unlabeled
observations and malformed status/envelope data are rejected.

### Reproducible tool checks—not model accuracy

```sh
node apps/api/evaluation/evaluate.mjs \
  --labels apps/api/evaluation/examples/cases.example.jsonl \
  --reviews apps/api/evaluation/examples/reviews.example.jsonl \
  --json
```

The bundled fictional example deliberately has five labels, three captured
reviews, one recorded quota refusal and one missing capture, so this command
exits2 with two unscored cases. The report explicitly says `accuracyClaim:
None`; its unsafe-ready and quote-coverage numbers exercise the scorer only.

An additional local smoke generated and downloaded two records through the
actual production API handler and passed those exports unchanged to this CLI.
A deliberately wrong model fixture assigned an exact but irrelevant policy
quote to an already-issued-refund claim. The scorer correctly counted one
unsafe-ready finding among the two fictional labels and made **no accuracy
claim**. This demonstrates usable export/scoring integration and the remaining
semantic boundary, not a failure frequency of the real model.

Real evaluation remains gated on consenting customer labels, independently
adjudicated applicability/account facts, a held-out policy/case set, and explicit
operator permission after checking the Free plan's available shared capacity.
Keep that dataset separate from the fictional examples, record the model and
engine versions, and measure end-to-end latency/provider usage separately.
The application counters reserve UTF-8 input bytes and requested output tokens;
they are not observed provider billing or neuron consumption.


## Chat and reference evaluation

Evaluate generated answers and pasted answers separately using the same held-out policies. Test follow-up questions, conflicting policy versions, missing account evidence and injected instructions in questions/history/policies. Record generation plus review latency and cost; generation and checking use the same model, so shared reasoning failures remain possible. A second model or deterministic business-rule evaluation is not implemented. Measure false approvals against independent human labels.

Inspect a bookmark's actual destination during approval; its hash does not freeze the external page. Approving media records human inspection, not AI fact verification. Verify that added references cannot upgrade an unsupported receipt, archived items cannot be attached again, and access is denied across workspaces and after membership removal. Test R2 byte downloads and failure recovery in the local emulator; hosted media is disabled by the free-only policy, and the local object-store fixture does not establish Cloudflare account provisioning or production performance.
