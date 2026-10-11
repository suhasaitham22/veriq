#!/usr/bin/env node
/**
 * Offline label evaluator.
 *
 * Compares human-labeled support cases with review outputs that were captured
 * earlier, and reports a confusion matrix, the false-ready rate and citation
 * coverage. It performs no network access and calls no model: it only reads the
 * two files it is given, so it cannot be used to produce a review.
 *
 * Usage:
 *   node apps/api/evaluation/evaluate.mjs --labels <file.jsonl> --reviews <file.jsonl>
 *     [--json] [--allow-unscored]
 *
 * A label file whose header says labelSource is "fictional_fixture" yields a
 * report that explicitly claims no accuracy. Real numbers require real labels
 * from a consenting pilot partner; see docs/EVALUATION.md for the dataset
 * prerequisites, which this tool does not replace.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const STATUSES = [
  "ready_for_review",
  "requires_changes",
  "needs_review",
];
export const LABEL_SOURCES = ["customer_labeled", "fictional_fixture"];

export class EvaluationInputError extends Error {}

/** Every record, with its line number, so a rejection names the offending line. */
export function parseJsonl(text, source) {
  const records = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new EvaluationInputError(`${source} line ${i + 1} is not JSON.`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new EvaluationInputError(
        `${source} line ${i + 1} is not a JSON object.`,
      );
    records.push({ value, line: i + 1 });
  }
  return records;
}

/**
 * First record is the dataset header; every later record is one labeled case.
 * Duplicate or missing ids are rejected rather than silently merged.
 */
export function readLabels(text, source = "labels") {
  const records = parseJsonl(text, source);
  if (!records.length)
    throw new EvaluationInputError(`${source} is empty; a header is required.`);
  const header = records[0].value;
  if (header.datasetVersion !== 1)
    throw new EvaluationInputError(
      `${source} line 1 must be a header with datasetVersion 1.`,
    );
  if (!LABEL_SOURCES.includes(header.labelSource))
    throw new EvaluationInputError(
      `${source} header labelSource must be one of ${LABEL_SOURCES.join(", ")}.`,
    );
  const cases = new Map();
  for (const { value, line } of records.slice(1)) {
    if (typeof value.id !== "string" || !value.id.trim())
      throw new EvaluationInputError(
        `${source} line ${line} has no case id. Every labeled case needs one.`,
      );
    if (cases.has(value.id))
      throw new EvaluationInputError(
        `${source} line ${line} repeats case id ${value.id}.`,
      );
    if (!STATUSES.includes(value.expected))
      throw new EvaluationInputError(
        `${source} line ${line} must label expected as one of ${STATUSES.join(", ")}.`,
      );
    const quotes = value.requiredQuotes ?? [];
    if (
      !Array.isArray(quotes) ||
      quotes.some((q) => typeof q !== "string" || !q.trim())
    )
      throw new EvaluationInputError(
        `${source} line ${line} requiredQuotes must be an array of non-empty strings.`,
      );
    cases.set(value.id, {
      id: value.id,
      expected: value.expected,
      requiredQuotes: quotes,
      note: typeof value.note === "string" ? value.note : null,
    });
  }
  if (!cases.size)
    throw new EvaluationInputError(`${source} contains no labeled cases.`);
  return {
    dataset: typeof header.dataset === "string" ? header.dataset : source,
    labelSource: header.labelSource,
    notes: typeof header.notes === "string" ? header.notes : null,
    cases,
  };
}

/**
 * Captured outcomes. Each record is either a review or a recorded failure, so a
 * case that the API refused stays visible instead of disappearing.
 */
export function readObservations(text, labels, source = "reviews") {
  const observations = new Map();
  for (const { value, line } of parseJsonl(text, source)) {
    if (typeof value.id !== "string" || !value.id.trim())
      throw new EvaluationInputError(
        `${source} line ${line} has no case id. Every captured outcome needs one.`,
      );
    if (observations.has(value.id))
      throw new EvaluationInputError(
        `${source} line ${line} repeats case id ${value.id}.`,
      );
    if (!labels.cases.has(value.id))
      throw new EvaluationInputError(
        `${source} line ${line} refers to unlabeled case id ${value.id}.`,
      );
    const hasReview = value.review !== undefined && value.review !== null;
    const hasError = value.error !== undefined && value.error !== null;
    if (hasReview === hasError)
      throw new EvaluationInputError(
        `${source} line ${line} must carry exactly one of review or error.`,
      );
    if (hasError) {
      const code = value.error.code ?? value.error;
      if (typeof code !== "string" || !code.trim())
        throw new EvaluationInputError(
          `${source} line ${line} error needs a string code.`,
        );
      observations.set(value.id, { id: value.id, error: code });
      continue;
    }
    if (!STATUSES.includes(value.review.status))
      throw new EvaluationInputError(
        `${source} line ${line} review.status must be one of ${STATUSES.join(", ")}.`,
      );
    if (!Array.isArray(value.review.receipts))
      throw new EvaluationInputError(
        `${source} line ${line} review.receipts must be an array.`,
      );
    observations.set(value.id, { id: value.id, review: value.review });
  }
  return observations;
}

/** Every exact quote a review cited, from supporting and contradicting evidence. */
export function citedQuotes(review) {
  const quotes = [];
  for (const receipt of review.receipts)
    for (const evidence of [
      ...(receipt.evidence ?? []),
      ...(receipt.counterEvidence ?? []),
    ])
      if (typeof evidence.quote === "string") quotes.push(evidence.quote);
  return quotes;
}

/**
 * Unlabeled, missing and failed cases are never counted as agreement: they are
 * reported separately so a thin capture cannot look like a good result.
 */
export function evaluate(labels, observations) {
  const confusion = {};
  for (const expected of STATUSES) {
    confusion[expected] = {};
    for (const actual of STATUSES) confusion[expected][actual] = 0;
  }
  const falseReady = [];
  const unscored = [];
  const missingCitations = [];
  let scored = 0;
  let agreed = 0;
  let requiredQuotes = 0;
  let matchedQuotes = 0;
  for (const labeled of labels.cases.values()) {
    const observed = observations.get(labeled.id);
    if (!observed) {
      unscored.push({ id: labeled.id, reason: "missing_review" });
      continue;
    }
    if (observed.error) {
      unscored.push({
        id: labeled.id,
        reason: "review_error",
        code: observed.error,
      });
      continue;
    }
    const actual = observed.review.status;
    scored++;
    confusion[labeled.expected][actual]++;
    if (labeled.expected === actual) agreed++;
    if (actual === "ready_for_review" && labeled.expected !== actual)
      falseReady.push({ id: labeled.id, expected: labeled.expected, actual });
    const quotes = citedQuotes(observed.review);
    for (const required of labeled.requiredQuotes) {
      requiredQuotes++;
      if (quotes.some((quote) => quote.includes(required))) matchedQuotes++;
      else missingCitations.push({ id: labeled.id, quote: required });
    }
  }
  return {
    dataset: labels.dataset,
    labelSource: labels.labelSource,
    notes: labels.notes,
    accuracyClaim:
      labels.labelSource === "customer_labeled"
        ? "Rates describe only these labeled cases. They are not a general model accuracy claim."
        : "None. This dataset is a fictional fixture, so the numbers measure the tool, not model accuracy.",
    totals: {
      labeled: labels.cases.size,
      scored,
      unscored: unscored.length,
      agreed,
    },
    confusion,
    falseReady: {
      count: falseReady.length,
      rate: scored ? falseReady.length / scored : null,
      cases: falseReady,
    },
    citationCoverage: {
      required: requiredQuotes,
      matched: matchedQuotes,
      rate: requiredQuotes ? matchedQuotes / requiredQuotes : null,
      missing: missingCitations,
    },
    unscored,
  };
}

function rate(value) {
  return value === null
    ? "n/a (nothing scored)"
    : `${(value * 100).toFixed(1)}%`;
}

export function formatReport(report) {
  const lines = [
    `Dataset: ${report.dataset} (${report.labelSource})`,
    `Accuracy claim: ${report.accuracyClaim}`,
    report.notes ? `Notes: ${report.notes}` : null,
    `Labeled ${report.totals.labeled}, scored ${report.totals.scored}, unscored ${report.totals.unscored}, agreed ${report.totals.agreed}`,
    "",
    "Confusion (rows: expected, columns: observed)",
    `${"".padEnd(18)}${STATUSES.map((s) => s.padStart(18)).join("")}`,
  ];
  for (const expected of STATUSES)
    lines.push(
      `${expected.padEnd(18)}${STATUSES.map((actual) =>
        String(report.confusion[expected][actual]).padStart(18),
      ).join("")}`,
    );
  lines.push(
    "",
    `False ready: ${report.falseReady.count} of ${report.totals.scored} scored (${rate(report.falseReady.rate)})`,
  );
  for (const item of report.falseReady.cases)
    lines.push(
      `  ${item.id}: expected ${item.expected}, observed ready_for_review`,
    );
  lines.push(
    `Citation coverage: ${report.citationCoverage.matched} of ${report.citationCoverage.required} required quotes (${rate(report.citationCoverage.rate)})`,
  );
  for (const item of report.citationCoverage.missing)
    lines.push(
      `  ${item.id}: no cited quote contains ${JSON.stringify(item.quote)}`,
    );
  lines.push(`Unscored: ${report.unscored.length}`);
  for (const item of report.unscored)
    lines.push(
      `  ${item.id}: ${item.reason}${item.code ? ` (${item.code})` : ""}`,
    );
  return lines.filter((line) => line !== null).join("\n");
}

export function parseArgs(argv) {
  const options = { json: false, allowUnscored: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--allow-unscored") options.allowUnscored = true;
    else if (arg === "--labels" || arg === "--reviews") {
      const value = argv[++i];
      if (!value)
        throw new EvaluationInputError(`${arg} needs a file path.`);
      options[arg === "--labels" ? "labels" : "reviews"] = value;
    } else throw new EvaluationInputError(`Unknown argument ${arg}.`);
  }
  if (!options.labels || !options.reviews)
    throw new EvaluationInputError(
      "Both --labels <file.jsonl> and --reviews <file.jsonl> are required.",
    );
  return options;
}

/** Exit 0 scored cleanly, 1 bad input, 2 cases left unscored. */
export function run(argv, { log = console.log, error = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
    const labels = readLabels(
      readFileSync(options.labels, "utf8"),
      options.labels,
    );
    const observations = readObservations(
      readFileSync(options.reviews, "utf8"),
      labels,
      options.reviews,
    );
    const report = evaluate(labels, observations);
    log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
    if (report.unscored.length && !options.allowUnscored) {
      error(
        `${report.unscored.length} labeled case(s) were never scored. Capture them or pass --allow-unscored to accept a partial run.`,
      );
      return 2;
    }
    return 0;
  } catch (failure) {
    error(
      failure instanceof EvaluationInputError
        ? failure.message
        : `Could not evaluate: ${failure.message}`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(run(process.argv.slice(2)));
