// app.js — Veriq dashboard: auth gate, verify, history, shareable receipts.
const API = "https://veriq-api.suhasaitham22.workers.dev";
const $ = (id) => document.getElementById(id);

async function me() {
  const r = await fetch(`${API}/api/auth/me`, { credentials: "include" });
  if (!r.ok) { location.href = "/login.html"; return null; }
  return (await r.json()).user;
}

$("logout").addEventListener("click", async () => {
  await fetch(`${API}/api/auth/logout`, { method: "POST", credentials: "include" });
  location.href = "/";
});

$("go").addEventListener("click", async () => {
  const text = $("input").value.trim();
  if (text.length < 10) { $("status").textContent = "Paste a little more text first."; return; }
  $("go").disabled = true;
  $("status").innerHTML = '<span class="spinner"></span>Splitting claims → searching sources → checking quotes…';
  $("results").innerHTML = "";
  try {
    const res = await fetch(`${API}/api/verify`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "request failed");
    $("status").textContent = data.cached ? "Served from cache — verified before." : "";
    render(data.receipts, data.id);
    loadHistory();
  } catch (e) {
    $("status").textContent = `Error: ${e.message}`;
  } finally {
    $("go").disabled = false;
  }
});

function render(receipts, id) {
  if (!receipts.length) {
    $("status").textContent = "No checkable claims found — try factual statements, not opinions.";
    return;
  }
  const shareUrl = `${location.origin}/app.html#r=${id}`;
  $("results").innerHTML =
    `<div class="share-row"><input id="share-link" readonly value="${shareUrl}"><button class="btn btn-ghost btn-sm" id="copy">Copy link</button></div>` +
    receipts.map(receiptHtml).join("");
  $("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(shareUrl).catch(() => {});
    $("copy").textContent = "Copied!";
    setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
  });
}

function receiptHtml(r) {
  return `<div class="receipt">
    <span class="verdict ${r.verdict}">${r.verdict}</span>
    <span class="conf">${Math.round(r.confidence * 100)}% · ${r.sourcesChecked} sources checked</span>
    <h3>${escapeHtml(r.claim)}</h3>
    ${r.evidence.map(quoteHtml).join("")}
    ${r.counterEvidence.length ? `<div class="counter-h">Counter-evidence</div>${r.counterEvidence.map(quoteHtml).join("")}` : ""}
    <p class="mind">What would change this: ${escapeHtml(r.changeMyMind)}</p>
  </div>`;
}

function quoteHtml(e) {
  return `<blockquote>"${escapeHtml(e.quote)}"<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.title || e.url)}</a></blockquote>`;
}

async function loadHistory() {
  try {
    const res = await fetch(`${API}/api/verify/history`, { credentials: "include" });
    if (!res.ok) return;
    const { history } = await res.json();
    $("history").innerHTML = history.length
      ? history.map((h) => `<a class="hist-item" href="/app.html#r=${h.id}">${escapeHtml(h.preview)}…<small>${new Date(h.created_at + "Z").toLocaleString()}</small></a>`).join("")
      : `<p style="color:var(--dim);font-size:.9rem">Nothing yet — your verifications will appear here.</p>`;
  } catch { /* offline history is non-fatal */ }
}

async function loadShared() {
  const m = location.hash.match(/#r=([a-f0-9-]{36})/);
  if (!m) return;
  $("verify-view").style.display = "none";
  document.querySelector(".hist").style.display = "none";
  $("shared-view").innerHTML = '<div id="status"><span class="spinner"></span>Loading shared receipt…</div>';
  try {
    const res = await fetch(`${API}/api/r/${m[1]}`);
    const data = await res.json();
    if (!res.ok) throw new Error("receipt not found");
    $("shared-view").innerHTML =
      `<p style="color:var(--dim);margin-bottom:1rem">Shared verification · <a href="/app.html" style="color:var(--accent)">verify your own →</a></p>` +
      (data.receipts || []).map(receiptHtml).join("");
  } catch {
    $("shared-view").innerHTML = "<p>Receipt not found.</p>";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

(async () => {
  const user = await me();
  if (!user) return;
  $("who").textContent = user.email;
  loadShared();
  loadHistory();
})();
