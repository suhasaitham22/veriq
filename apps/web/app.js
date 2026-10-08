const API = window.VERIQ_API;
const $ = (id) => document.getElementById(id);
let selected = new Set();
const labels = { supported: "Supported", contradicted: "Contradicted", conflicting: "Conflicting evidence", unsupported: "Evidence missing", not_applicable: "Courtesy", ready_for_review: "Ready for human review", requires_changes: "Changes required", needs_review: "Needs human review" };
async function api(path, body) {
  const response = await fetch(`${API}${path}`, {
    credentials: "include", ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (response.status === 401) location.href = "/login.html";
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function message(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle("error", error); }
$("logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout", {}); location.href = "/"; }
  catch (error) { message("status", error.message, true); }
});
$("document-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("save-document").disabled = true;
  try {
    await api("/api/documents", { title: $("doc-title").value, version: $("doc-version").value, sourceUrl: $("doc-url").value, content: $("doc-content").value });
    $("document-form").reset();
    message("doc-status", "Document saved as a draft. Inspect its text, then approve it below.");
    await loadDocuments();
  } catch (error) { message("doc-status", error.message, true); }
  finally { $("save-document").disabled = false; }
});
async function loadDocuments() {
  const { documents } = await api("/api/documents");
  selected = new Set([...selected].filter((id) => documents.some((d) => d.id === id && d.status === "approved")));
  const list = $("documents"); list.replaceChildren();
  if (!documents.length) { list.append(node("p", "Add a policy to start. Only approved documents are used.", "small")); return; }
  for (const doc of documents) {
    const item = node("div", undefined, "document");
    const label = node("label");
    const check = node("input"); check.type = "checkbox"; check.disabled = doc.status !== "approved"; check.checked = selected.has(doc.id);
    check.setAttribute("aria-label", `Use ${doc.title}, version ${doc.version}`);
    check.addEventListener("change", () => { if (check.checked) selected.add(doc.id); else selected.delete(doc.id); });
    label.append(check, node("span", `${doc.title} · ${doc.version}`)); item.append(label, node("span", doc.status, `badge ${doc.status}`));
    const detail = node("details"); detail.append(node("summary", "Inspect document text"), node("pre", doc.content)); item.append(detail);
    if (doc.status !== "archived") {
      const actions = node("div", undefined, "doc-actions");
      for (const action of doc.status === "draft" ? ["approve", "archive"] : ["archive"]) {
        const button = node("button", action === "approve" ? "Approve this version" : "Archive", "btn btn-ghost btn-sm");
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await api(`/api/documents/${doc.id}/${action}`, {});
            if (action === "approve") selected.add(doc.id);
            message("doc-status", action === "approve" ? "Document approved and selected for review." : "Document archived. Historical reviews keep their evidence.");
            // A visible result is historical after the library changes. Clear it before another review.
            $("results").replaceChildren(); message("status", "Document selection changed. Run a new review for the current draft.");
            await loadDocuments();
          } catch (error) { message("doc-status", error.message, true); button.disabled = false; }
        }); actions.append(button);
      } item.append(actions);
    }
    list.append(item);
  }
}
$("go").addEventListener("click", async () => {
  if (!$("input").value.trim()) { message("status", "Paste a support draft first.", true); return; }
  if (!selected.size || selected.size > 10) { message("status", "Select 1–10 approved documents first.", true); return; }
  const draft = $("input").value;
  const documentIds = [...selected];
  $("go").disabled = true; $("input").disabled = true;
  $("load-example").disabled = true;
  $("results").replaceChildren(); message("status", "Reviewing each sentence against your selected documents…");
  try {
    const data = await api("/api/reviews", { draft, documentIds });
    if ($("input").value !== draft || JSON.stringify([...selected].sort()) !== JSON.stringify([...documentIds].sort())) {
      message("status", "Review saved to history. The draft or document selection changed while it was running; run a new review.");
      await loadHistory(); return;
    }
    render(data.review); message("status", "Review saved privately. A person must decide what to send.");
    await loadHistory();
  } catch (error) { message("status", error.message, true); }
  finally { $("go").disabled = false; $("input").disabled = false; $("load-example").disabled = false; }
});
// Prevent a result for an old draft or selection from appearing current.
$("input").addEventListener("input", () => { $("results").replaceChildren(); message("status", "Draft changed. Run a new review."); });
$("documents").addEventListener("change", () => { $("results").replaceChildren(); message("status", "Document selection changed. Run a new review."); });
$("load-example").addEventListener("click", () => {
  $("doc-title").value = "Example export policy"; $("doc-version").value = "pilot-1"; $("doc-url").value = "";
  $("doc-content").value = "Starter plans include 100 exports per month. Unlimited exports are available on the Enterprise plan. Refund requests must be submitted within 30 days of purchase.";
  $("input").value = "All plans include unlimited exports. Refund requests must be submitted within 30 days of purchase.";
  $("results").replaceChildren(); message("doc-status", "Example loaded. Save and approve this sample document, then review the draft."); message("status", "Example draft loaded. This is sample policy data.");
});
function quote(evidence) {
  const block = node("blockquote", evidence.quote);
  const cite = node("cite", `${evidence.title} · version ${evidence.version} · ${evidence.contentHash.slice(0, 12)}`);
  if (evidence.sourceUrl) {
    try {
      const url = new URL(evidence.sourceUrl);
      if (["https:", "http:"].includes(url.protocol)) {
        const link = node("a", " Open source"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; cite.append(link);
      }
    } catch { /* Display evidence without an invalid source link. */ }
  }
  block.append(cite); return block;
}
function render(review) {
  const output = $("results"); output.replaceChildren();
  const summary = node("div", undefined, "review-summary");
  summary.append(node("span", labels[review.status], `badge ${review.status}`), node("p", review.summary));
  const sources = node("details"); sources.append(node("summary", "Document versions used"));
  const list = node("ul", undefined, "source-list");
  for (const doc of review.documents) list.append(node("li", `${doc.title} · ${doc.version} · ${doc.contentHash.slice(0, 12)}`));
  sources.append(list); summary.append(sources); output.append(summary);
  for (const receipt of review.receipts) {
    const card = node("article", undefined, "receipt");
    card.append(node("span", labels[receipt.verdict], `badge ${receipt.verdict}`), node("h3", receipt.statement));
    for (const e of receipt.evidence) card.append(quote(e));
    if (receipt.counterEvidence.length) {
      const counter = node("div", undefined, "counter"); counter.append(node("strong", "Contradicting evidence"));
      for (const e of receipt.counterEvidence) counter.append(quote(e)); card.append(counter);
    }
    card.append(node("p", receipt.reviewNote)); output.append(card);
  }
}
async function loadHistory() {
  const { reviews } = await api("/api/reviews");
  const history = $("history"); history.replaceChildren();
  if (!reviews.length) history.append(node("p", "Your reviewed drafts will appear here.", "small"));
  for (const item of reviews) {
    const link = node("a", item.preview, "hist-item"); link.href = `#review=${item.id}`;
    link.append(node("small", new Date(`${item.created_at}Z`).toLocaleString())); history.append(link);
  }
}
async function loadReview() {
  const id = location.hash.match(/^#review=([a-f0-9-]{36})$/)?.[1];
  if (!id) return;
  try {
    const data = await api(`/api/reviews/${id}`);
    $("input").value = data.draft; render(data.review);
    message("status", "Historical review: these document versions were approved when checked. Run a new review against current policies before sending.");
  } catch (error) { $("results").replaceChildren(); message("status", error.message, true); }
}
addEventListener("hashchange", loadReview);
(async () => {
  try { const { user } = await api("/api/auth/me"); $("who").textContent = user.email;
    await loadDocuments(); await loadHistory(); await loadReview(); }
  catch (error) { message("status", error.message, true); }
})();
