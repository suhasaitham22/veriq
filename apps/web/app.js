// app.js — Veriq web client. One job: POST text, render receipts.
const API = ""; // same origin in production; "http://localhost:8787" for local dev

const $ = (id) => document.getElementById(id);

$("go").addEventListener("click", async () => {
  const text = $("input").value.trim();
  if (text.length < 10) return;
  $("go").disabled = true;
  $("status").textContent = "Splitting claims → searching → checking sources…";
  $("results").innerHTML = "";
  try {
    const res = await fetch(`${API}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "request failed");
    $("status").textContent = data.cached ? "Served from cache." : "";
    render(data.receipts);
  } catch (e) {
    $("status").textContent = `Error: ${e.message}`;
  } finally {
    $("go").disabled = false;
  }
});

function render(receipts) {
  if (!receipts.length) {
    $("status").textContent = "No checkable claims found — try factual statements.";
    return;
  }
  $("results").innerHTML = receipts.map((r) => `
    <div class="receipt">
      <span class="verdict ${r.verdict}">${r.verdict}</span>
      <span class="conf">${Math.round(r.confidence * 100)}% · ${r.sourcesChecked} sources checked</span>
      <p><strong>${escapeHtml(r.claim)}</strong></p>
      ${r.evidence.map(quoteHtml).join("")}
      ${r.counterEvidence.length ? `<p style="color:var(--dim);font-size:.85rem">Counter-evidence:</p>${r.counterEvidence.map(quoteHtml).join("")}` : ""}
      <p class="mind">What would change this: ${escapeHtml(r.changeMyMind)}</p>
    </div>`).join("");
}

function quoteHtml(e) {
  return `<blockquote>"${escapeHtml(e.quote)}"<a href="${e.url}" target="_blank" rel="noopener">${escapeHtml(e.title || e.url)}</a></blockquote>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
