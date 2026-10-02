// popup.js — shared by Chrome + Firefox. Extracts page text, calls Veriq API.
const API = "https://veriq-api.workers.dev"; // TODO: point at your deployed Worker

document.getElementById("verify").addEventListener("click", async () => {
  const status = document.getElementById("status");
  const results = document.getElementById("results");
  status.textContent = "Extracting claims…";
  results.innerHTML = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result: text }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body.innerText.slice(0, 4000),
    });
    status.textContent = "Verifying…";
    const res = await fetch(`${API}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "request failed");
    status.textContent = "";
    results.innerHTML = data.receipts.map((r) => `
      <div class="r"><span class="v ${r.verdict}">${r.verdict}</span>
      <div style="margin-top:4px">${escapeHtml(r.claim)}</div></div>`).join("")
      || "No checkable claims on this page.";
  } catch (e) { status.textContent = `Error: ${e.message}`; }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
