import { workspaceTools } from "./workspace-tools.js";
const $ = (id) => document.getElementById(id);
const labels = {
  supported: "Supported",
  contradicted: "Contradicted",
  conflicting: "Conflicting evidence",
  unsupported: "Evidence missing",
  not_applicable: "Courtesy",
  ready_for_review: "Ready for human review",
  requires_changes: "Changes required",
  needs_review: "Needs human review",
};
let scenarios = [],
  feedbackReviewId = null,
  sampleDocumentIds = [];
let user,
  workspace,
  workspaces = [],
  selected = new Set(),
  busy = false,
  epoch = 0,
  current = null,
  overviewSequence = 0,
  memberSequence = 0,
  openSequence = 0,
  retry = null;
const pages = new Map();
const writer = () => ["owner", "admin", "reviewer"].includes(workspace?.role);
const admin = () => ["owner", "admin"].includes(workspace?.role);
const tools = workspaceTools({
  api,
  el,
  msg,
  mutate,
  writer,
  admin,
  openReview,
  controls,
  view,
  workspace: () => workspace,
  user: () => user,
  epoch: () => epoch,
});

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function msg(id, text, error = false) {
  $(id).textContent = text;
  $(id).classList.toggle("error", error);
}
function time(value) {
  return new Date(value.endsWith("Z") ? value : `${value}Z`).toLocaleString();
}
async function api(path, body, key) {
  const headers = {
    ...(workspace ? { "X-Workspace-ID": workspace.id } : {}),
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(key ? { "Idempotency-Key": key } : {}),
  };
  const res = await fetch(`${window.VERIQ_API}${path}`, {
    credentials: "include",
    headers,
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("Your session ended. Sign in again.");
  }
  if (!res.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "The review API did not return JSON. Check the Pages proxy and deploy the API and web app together.",
    );
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      `${data.error || "Request failed."}${res.status >= 500 && data.requestId ? ` Reference: ${data.requestId}` : ""}`,
    );
  return data;
}
function controls() {
  tools.controls(busy);
  $("workspace-select").disabled = busy || !workspace;
  $("give-feedback").disabled = busy || !workspace;
  $("feedback-fields").disabled = busy;
  $("setup-demo").disabled = busy || !workspace?.is_personal;
  $("demo-scenario").disabled = busy || !sampleDocumentIds.length || !writer();
  $("load-scenario").disabled = busy || !sampleDocumentIds.length || !writer();
  $("new-workspace").disabled = busy || !user;
  $("document-fields").disabled = busy || !writer();
  $("member-fields").disabled = busy || !admin() || !!workspace?.is_personal;
  $("input").disabled = busy || !writer();
  $("go").disabled = busy || !writer();
  $("load-example").disabled = busy || !writer();
  document
    .querySelectorAll("[data-admin]")
    .forEach((n) => (n.disabled = busy || !admin()));
  document
    .querySelectorAll("[data-write]")
    .forEach((n) => (n.disabled = busy || !writer()));
  document
    .querySelectorAll("[data-selection]")
    .forEach((n) => (n.disabled = busy || !writer()));
  document
    .querySelectorAll(
      '#workspace-nav [data-view="team"],#workspace-nav [data-view="audit"],#workspace-nav [data-view="feedback"]',
    )
    .forEach((n) => (n.hidden = !admin()));
}
async function mutate(status, action) {
  if (busy) return;
  busy = true;
  controls();
  try {
    await action();
  } catch (error) {
    msg(status, error.message, true);
  } finally {
    busy = false;
    controls();
  }
}
function button(text, fn, permission) {
  const n = el("button", text, "btn btn-ghost btn-sm");
  n.type = "button";
  if (permission) n.dataset[permission] = "";
  n.addEventListener("click", () => mutate("global-status", fn));
  return n;
}
const views = {
  evidence: [
    "Links & media",
    "Save private references and attach approved evidence to review records.",
  ],
  chat: [
    "AI support chat",
    "Draft answers from approved policies, then inspect their claim reviews.",
  ],
  review: [
    "Review desk",
    "Check support answers against the policies your team approves.",
  ],
  documents: [
    "Document library",
    "Manage approved policy versions and their effective dates.",
  ],
  team: [
    "Team & access",
    "Control who can view, review and approve in this workspace.",
  ],
  feedback: [
    "Pilot feedback",
    "Learn what your pilot team finds useful and what needs to improve.",
  ],
  audit: [
    "Audit trail",
    "Trace policy approvals, access changes and review decisions.",
  ],
};
function view(name, refresh = true) {
  if (["team", "audit", "feedback"].includes(name) && !admin()) name = "review";
  for (const key of Object.keys(views)) $(`view-${key}`).hidden = key !== name;
  document
    .querySelectorAll("#workspace-nav button")
    .forEach((n) =>
      n.setAttribute(
        "aria-current",
        n.dataset.view === name ? "page" : "false",
      ),
    );
  $("page-title").textContent = views[name][0];
  $("page-description").textContent = views[name][1];
  if (refresh && workspace) {
    const tasks = [overview()];
    if (name === "review") tasks.push(loadSources(), loadHistory());
    if (name === "documents") tasks.push(loadDocuments());
    Promise.all(tasks).catch((e) => msg("global-status", e.message, true));
  }
  tools.view(name).catch((e) => msg("global-status", e.message, true));
  if (name === "team")
    loadMembers().catch((e) => msg("team-status", e.message, true));
  if (name === "feedback")
    loadFeedback().catch((e) => msg("global-status", e.message, true));
  if (name === "audit")
    loadAudit().catch((e) => msg("global-status", e.message, true));
}
$("workspace-nav").addEventListener("click", (e) => {
  const n = e.target.closest("[data-view]");
  if (n) view(n.dataset.view);
});
$("open-documents").onclick = () => view("documents");
function invalidate(text = "Draft or sources changed. Run a new review.") {
  openSequence++;
  current = null;
  retry = null;
  $("results").replaceChildren();
  msg("status", text);
}
function counts() {
  $("draft-count").textContent =
    `${$("input").value.length.toLocaleString()} / 3,000 characters · up to 12 sentences`;
  $("document-count").textContent =
    `${$("doc-content").value.length.toLocaleString()} / 20,000 characters`;
  $("selected-count").textContent = `${selected.size} selected`;
}
$("input").oninput = () => {
  counts();
  invalidate();
};
$("doc-content").oninput = counts;
async function overview() {
  const version = epoch,
    sequence = ++overviewSequence;
  const data = await api(`/api/workspaces/${workspace.id}/overview`);
  if (version !== epoch || sequence !== overviewSequence) return;
  for (const [id, key] of [
    ["active", "activeDocuments"],
    ["drafts", "draftDocuments"],
    ["pending", "pendingReviews"],
    ["members", "members"],
  ])
    $(`metric-${id}`).textContent = data.counts[key];
}
async function loadWorkspaces(preferred) {
  const data = await api("/api/workspaces");
  workspaces = data.workspaces;
  $("workspace-select").replaceChildren(
    ...workspaces.map((w) => {
      const n = el("option", w.name);
      n.value = w.id;
      return n;
    }),
  );
  let saved;
  try {
    saved = localStorage.getItem("veriq-workspace");
  } catch {
    /* Storage can be unavailable. */
  }
  await switchWorkspace(preferred || saved || workspaces[0]?.id);
}
async function switchWorkspace(id) {
  epoch++;
  tools.reset();
  sampleDocumentIds = [];
  $("demo-status").textContent = "";
  workspace = workspaces.find((w) => w.id === id) || workspaces[0];
  selected.clear();
  pages.clear();
  invalidate("Select current policies and paste a customer reply.");
  $("input").value = "";
  $("document-form").reset();
  $("member-form").reset();
  for (const id of [
    "source-search",
    "document-search",
    "history-search",
    "document-filter",
    "history-filter",
  ])
    $(id).value = "";
  for (const id of [
    "sources",
    "documents",
    "history",
    "members",
    "audit-events",
    "global-status",
    "doc-status",
    "team-status",
  ])
    $(id).replaceChildren();
  history.replaceState(null, "", location.pathname);
  $("workspace-select").value = workspace.id;
  $("demo-panel").hidden = !workspace.is_personal;
  $("demo-help").textContent = workspace.is_personal
    ? "Setup explicitly approves a fictional sample policy in your personal workspace. Real company policies belong in a team workspace."
    : "Switch to your personal workspace for a sample demo. Company policies require approval by a different administrator.";
  $("workspace-name").textContent = workspace.name;
  $("role-chip").textContent = workspace.role;
  $("approval-mode").textContent = workspace.require_two_person
    ? "Two-person policy approval"
    : "Personal workspace";
  $("document-approval-help").textContent = workspace.require_two_person
    ? "Text is immutable. A different administrator must approve each version."
    : "Text and metadata are immutable. Save changes as a new version.";
  $("member-role").querySelector('[value="admin"]').disabled =
    workspace.role !== "owner";
  if (workspace.is_personal)
    msg("team-status", "Create a team workspace to add members.");
  try {
    localStorage.setItem("veriq-workspace", workspace.id);
  } catch {
    /* Optional preference. */
  }
  view("review", false);
  counts();
  controls();
  await Promise.all([
    loadSources(),
    loadDocuments(),
    loadHistory(),
    overview(),
  ]);
}
$("workspace-select").onchange = () =>
  switchWorkspace($("workspace-select").value).catch((e) =>
    msg("global-status", e.message, true),
  );
// Each list has its own sequence number so slower searches cannot replace newer results.
async function paginate(id, path, key, renderer, append = false) {
  let state = pages.get(id) || { seq: 0, cursor: null };
  pages.set(id, state);
  if (append && !state.cursor) return;
  const seq = ++state.seq,
    version = epoch;
  const url = new URL(path, location.origin);
  url.searchParams.set("limit", "25");
  if (append) url.searchParams.set("cursor", state.cursor);
  const data = await api(url.pathname + url.search);
  if (version !== epoch || seq !== state.seq) return;
  if (!append) $(id).replaceChildren();
  for (const item of data[key]) $(id).append(renderer(item));
  if (!$(id).children.length)
    $(id).append(el("p", "No matching records yet.", "empty-state"));
  if (id === "feedback")
    $("feedback-summary").textContent =
      `${data.summary.count} notes · average usefulness ${data.summary.averageRating ?? "—"}/5`;
  state.cursor = data.nextCursor;
  $(`more-${id}`).hidden = !state.cursor;
  controls();
}
function query(path, filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  return `${path}?${p}`;
}
function loadSources(append = false) {
  return paginate(
    "sources",
    query("/api/documents", {
      status: "approved",
      q: $("source-search").value,
    }),
    "documents",
    sourceCard,
    append,
  );
}
function sourceCard(doc) {
  const item = el("div", undefined, "source-item"),
    label = el("label"),
    check = el("input");
  check.type = "checkbox";
  check.checked = selected.has(doc.id);
  check.dataset.selection = "";
  check.setAttribute("aria-label", `Use ${doc.title}, version ${doc.version}`);
  if (!doc.eligible) {
    check.disabled = true;
    delete check.dataset.selection;
    selected.delete(doc.id);
  }
  check.onchange = () => {
    if (check.checked && selected.size >= 10) {
      check.checked = false;
      msg("status", "Select at most 10 policy versions.", true);
      return;
    }
    if (check.checked) selected.add(doc.id);
    else selected.delete(doc.id);
    invalidate();
    counts();
  };
  label.append(check, el("span", `${doc.title} · ${doc.version}`));
  item.append(
    label,
    el(
      "p",
      doc.eligible ? "Approved · active" : "Approved · outside validity dates",
      "small",
    ),
  );
  item.append(button("Inspect text", () => inspect(doc, item)));
  return item;
}
async function inspect(doc, container) {
  const old = container.querySelector("details");
  if (old) {
    old.open = !old.open;
    return;
  }
  const data = await api(`/api/documents/${doc.id}`);
  const detail = el("details");
  detail.open = true;
  detail.append(
    el("summary", "Document text"),
    el("pre", data.document.content, "document-text"),
  );
  container.append(detail);
}
function loadDocuments(append = false) {
  return paginate(
    "documents",
    query("/api/documents", {
      q: $("document-search").value,
      status: $("document-filter").value,
    }),
    "documents",
    documentCard,
    append,
  );
}
function documentCard(doc) {
  const item = el("article", undefined, "library-row");
  const top = el("div", undefined, "row-top");
  top.append(
    el("h3", `${doc.title} · ${doc.version}`),
    el("span", doc.status, "badge " + doc.status),
  );
  item.append(
    top,
    el("p", doc.preview, "small"),
    el("p", `Added by ${doc.author_email} · ${time(doc.created_at)}`, "small"),
  );
  if (doc.valid_from || doc.valid_until)
    item.append(
      el(
        "p",
        `Effective ${doc.valid_from || "immediately"} · expires ${doc.valid_until || "never"} (UTC)`,
        "small",
      ),
    );
  const actions = el("div", undefined, "row-actions");
  actions.append(button("Inspect text", () => inspect(doc, item)));
  if (admin() && doc.status !== "archived") {
    if (doc.status === "draft") {
      if (workspace.require_two_person && doc.user_id === user.id)
        item.append(
          el("p", "Awaiting another administrator’s approval.", "small"),
        );
      else
        actions.append(
          button(
            "Approve this version",
            async () => {
              await api(`/api/documents/${doc.id}/approve`, {});
              invalidate("Policy library changed. Run a new review.");
              msg(
                "doc-status",
                "Document approved. Select it in Review sources.",
              );
              await Promise.all([loadDocuments(), loadSources(), overview()]);
            },
            "admin",
          ),
        );
    }
    actions.append(
      button(
        "Archive",
        async () => {
          if (
            !confirm(
              `Archive ${doc.title}, version ${doc.version}? It will be unavailable for new reviews.`,
            )
          )
            return;
          await api(`/api/documents/${doc.id}/archive`, {});
          selected.delete(doc.id);
          invalidate("Policy archived. Historical evidence is preserved.");
          msg(
            "doc-status",
            "Document archived. Historical evidence is preserved.",
          );
          counts();
          await Promise.all([loadDocuments(), loadSources(), overview()]);
        },
        "admin",
      ),
    );
  }
  item.append(actions);
  return item;
}
$("document-form").onsubmit = (e) => {
  e.preventDefault();
  mutate("doc-status", async () => {
    await api("/api/documents", {
      title: $("doc-title").value,
      version: $("doc-version").value,
      content: $("doc-content").value,
      sourceUrl: $("doc-url").value,
      validFrom: $("doc-from").value,
      validUntil: $("doc-until").value,
    });
    $("document-form").reset();
    counts();
    msg(
      "doc-status",
      "Document saved as a draft. Inspect its text before approval.",
    );
    await Promise.all([loadDocuments(), overview()]);
  });
};
$("document-file").onchange = async () => {
  const file = $("document-file").files[0];
  if (!file) return;
  try {
    if (!/\.(txt|md)$/i.test(file.name) || file.size > 80000)
      throw new Error("Choose a text or Markdown file under 80 KB.");
    const text = await file.text();
    if (text.length > 20000)
      throw new Error("Document exceeds 20,000 characters.");
    $("doc-content").value = text;
    if (!$("doc-title").value)
      $("doc-title").value = file.name
        .replace(/\.(txt|md)$/i, "")
        .slice(0, 120);
    counts();
    msg(
      "doc-status",
      "Text imported. Check its scope and exceptions before saving.",
    );
  } catch (e) {
    msg("doc-status", e.message, true);
  }
};
$("load-example").onclick = () => {
  $("input").value =
    "All plans include unlimited exports. Refund requests must be submitted within 30 days of purchase.";
  $("doc-title").value = "Example export policy";
  $("doc-version").value = "pilot-1";
  $("doc-content").value =
    "Starter plans include 100 exports per month. Unlimited exports are available on the Enterprise plan. Refund requests must be submitted within 30 days of purchase.";
  counts();
  invalidate(
    "Example loaded. Save the sample policy in Documents, approve it and select it as a source.",
  );
  view("documents");
};
function loadHistory(append = false) {
  return paginate(
    "history",
    query("/api/reviews", {
      q: $("history-search").value,
      decision: $("history-filter").value,
    }),
    "reviews",
    reviewCard,
    append,
  );
}
function reviewCard(item) {
  const n = el("a", undefined, "queue-row");
  n.href = `#review=${item.id}`;
  n.addEventListener("click", (event) => {
    event.preventDefault();
    if (busy) return;
    history.pushState(null, "", n.href);
    openReview(item.id).catch((e) => msg("status", e.message, true));
  });
  n.append(
    el("p", item.preview),
    el("span", item.decision, "badge " + item.decision),
    el(
      "small",
      `${labels[item.status]} · ${item.author_email} · ${time(item.created_at)}`,
    ),
  );
  return n;
}
function quote(e) {
  const n = el("blockquote", e.quote),
    cite = el(
      "cite",
      `${e.title} · ${e.version} · ${e.contentHash.slice(0, 12)}`,
    );
  if (e.sourceUrl) {
    try {
      const u = new URL(e.sourceUrl);
      if (["https:", "http:"].includes(u.protocol)) {
        const a = el("a", " Open source");
        a.href = u.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        cite.append(a);
      }
    } catch {
      /* Ignore malformed legacy URLs. */
    }
  }
  n.append(cite);
  return n;
}
function render(data) {
  current = data;
  const output = $("results");
  output.replaceChildren();
  const summary = el("div", undefined, "review-summary");
  summary.append(
    el("span", labels[data.review.status], "badge " + data.review.status),
    el("p", data.review.summary),
  );
  const sources = el("details");
  sources.append(el("summary", "Document versions used"));
  const list = el("ul", undefined, "source-list");
  for (const d of data.review.documents)
    list.append(
      el("li", `${d.title} · ${d.version} · ${d.contentHash.slice(0, 12)}`),
    );
  sources.append(list);
  summary.append(sources);
  output.append(summary);
  for (const r of data.review.receipts) {
    const card = el("article", undefined, "receipt");
    card.append(
      el("span", labels[r.verdict], "badge " + r.verdict),
      el("h3", r.statement),
    );
    for (const e of r.evidence) card.append(quote(e));
    if (r.counterEvidence.length) {
      const n = el("div", undefined, "counter");
      n.append(el("strong", "Contradicting evidence"));
      for (const e of r.counterEvidence) n.append(quote(e));
      card.append(n);
    }
    card.append(el("p", r.reviewNote));
    output.append(card);
  }
  output.append(tools.renderAttachments(data));
  const decision = el("section", undefined, "decision-card");
  decision.append(
    el("h3", "Human decision"),
    el("p", `Decision: ${data.decision} · revision ${data.revision}`),
  );
  if (data.decisionNote) decision.append(el("p", data.decisionNote));
  if (!data.policiesCurrent)
    decision.append(
      el(
        "p",
        "A source policy is no longer active. Run a new review before approving.",
        "error",
      ),
    );
  const download = el("a", "Export evidence JSON", "btn btn-ghost btn-sm");
  download.href = "#";
  download.onclick = async (e) => {
    e.preventDefault();
    try {
      const record = await api(`/api/reviews/${data.id}/export`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(record, null, 2)], {
          type: "application/json",
        }),
      );
      const a = el("a");
      a.href = url;
      a.download = `veriq-review-${data.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      msg("status", e.message, true);
    }
  };
  decision.append(download);
  if (writer()) {
    const note = el("textarea");
    note.id = "decision-note";
    note.maxLength = 2000;
    note.placeholder =
      "Record why this draft is approved or rejected (at least 5 characters).";
    const label = el("label", "Decision note");
    label.htmlFor = note.id;
    decision.append(label, note);
    for (const value of ["approved", "rejected"]) {
      if (
        value === "approved" &&
        (data.review.status !== "ready_for_review" || !data.policiesCurrent)
      )
        continue;
      decision.append(
        button(
          value === "approved" ? "Approve draft" : "Reject draft",
          async () => {
            await api(`/api/reviews/${data.id}/decision`, {
              decision: value,
              note: note.value,
              expectedRevision: data.revision,
            });
            await openReview(data.id);
            await Promise.all([loadHistory(), overview()]);
          },
          "write",
        ),
      );
    }
  }
  output.append(decision);
  controls();
}
async function openReview(id) {
  const version = epoch,
    sequence = ++openSequence;
  const data = await api(`/api/reviews/${id}`);
  if (version !== epoch || sequence !== openSequence) return;
  view("review", false);
  $("input").value = data.draft;
  counts();
  render(data);
  msg(
    "status",
    "Saved review. Evidence reflects the document versions checked; the decision is recorded separately.",
  );
}
addEventListener("hashchange", () => {
  const id = location.hash.match(/^#review=([a-f0-9-]{36})$/)?.[1];
  if (id && !busy) openReview(id).catch((e) => msg("status", e.message, true));
});
$("go").onclick = () =>
  mutate("status", async () => {
    openSequence++;
    if (!$("input").value.trim())
      throw new Error("Paste a customer reply first.");
    if (!selected.size)
      throw new Error("Select current approved documents first.");
    const payload = {
        draft: $("input").value,
        documentIds: [...selected].sort(),
      },
      fingerprint = JSON.stringify(payload);
    if (retry?.fingerprint !== fingerprint)
      retry = { fingerprint, key: crypto.randomUUID() };
    $("results").replaceChildren();
    current = null;
    msg(
      "status",
      "Reviewing each sentence against the full selected policies…",
    );
    const data = await api("/api/reviews", payload, retry.key);
    await openReview(data.id);
    retry = null;
    await Promise.all([loadHistory(), overview()]);
  });
async function loadMembers() {
  const sequence = ++memberSequence;
  $("members").replaceChildren(el("p", "Loading members…", "small"));
  const version = epoch;
  const data = await api(`/api/workspaces/${workspace.id}/members`);
  if (version !== epoch || sequence !== memberSequence) return;
  $("members").replaceChildren();
  for (const m of data.members) {
    const row = el("div", undefined, "member-row");
    row.append(el("strong", m.email), el("span", m.role, "badge"));
    if (
      !workspace.is_personal &&
      m.user_id !== user.id &&
      m.role !== "owner" &&
      (workspace.role === "owner" || m.role !== "admin")
    ) {
      const select = el("select");
      select.setAttribute("aria-label", `Role for ${m.email}`);
      for (const role of workspace.role === "owner"
        ? ["admin", "reviewer", "viewer"]
        : ["reviewer", "viewer"]) {
        const o = el("option", role);
        o.value = role;
        select.append(o);
      }
      select.value = m.role;
      row.append(
        select,
        button(
          "Save role",
          async () => {
            await api(`/api/workspaces/${workspace.id}/members/${m.user_id}`, {
              role: select.value,
            });
            await loadMembers();
            msg("team-status", "Member role updated.");
          },
          "admin",
        ),
        button(
          "Remove",
          async () => {
            if (!confirm(`Remove ${m.email} from this workspace?`)) return;
            await api(`/api/workspaces/${workspace.id}/members/${m.user_id}`, {
              remove: true,
            });
            await Promise.all([loadMembers(), overview()]);
          },
          "admin",
        ),
      );
    }
    $("members").append(row);
  }
  controls();
}
$("member-form").onsubmit = (e) => {
  e.preventDefault();
  mutate("team-status", async () => {
    await api(`/api/workspaces/${workspace.id}/members`, {
      email: $("member-email").value,
      role: $("member-role").value,
    });
    $("member-form").reset();
    msg(
      "team-status",
      "Member added. They can select this workspace after signing in.",
    );
    await Promise.all([loadMembers(), overview()]);
  });
};
function loadAudit(append = false) {
  return paginate(
    "audit-events",
    `/api/workspaces/${workspace.id}/audit`,
    "events",
    (item) => {
      const n = el("article", undefined, "event-row");
      n.append(
        el("strong", item.action.replaceAll(".", " · ")),
        el("p", `${item.actor_email} · ${time(item.created_at)}`, "small"),
        el("p", `Object: ${item.object_id}`, "small"),
      );
      const d = el("details");
      d.append(
        el("summary", "Event details"),
        el("pre", JSON.stringify(JSON.parse(item.metadata_json), null, 2)),
      );
      n.append(d);
      return n;
    },
    append,
  );
}
for (const [id, loader] of [
  ["sources", loadSources],
  ["documents", loadDocuments],
  ["history", loadHistory],
  ["audit-events", loadAudit],
  ["feedback", loadFeedback],
])
  $(`more-${id}`).onclick = () =>
    loader(true).catch((e) => msg("global-status", e.message, true));
function debounce(id, fn) {
  let timer;
  $(id).addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => fn().catch((e) => msg("global-status", e.message, true)),
      250,
    );
  });
}
for (const [id, fn] of [
  ["source-search", loadSources],
  ["document-search", loadDocuments],
  ["history-search", loadHistory],
])
  debounce(id, fn);
$("document-filter").onchange = () =>
  loadDocuments().catch((e) => msg("global-status", e.message, true));
$("history-filter").onchange = () =>
  loadHistory().catch((e) => msg("global-status", e.message, true));
$("refresh-history").onclick = () =>
  loadHistory().catch((e) => msg("global-status", e.message, true));
$("refresh-audit").onclick = () =>
  loadAudit().catch((e) => msg("global-status", e.message, true));
$("new-workspace").onclick = () => {
  $("workspace-status").textContent = "";
  $("workspace-dialog").showModal();
};
$("close-workspace").onclick = () => $("workspace-dialog").close();
$("workspace-form").onsubmit = (e) => {
  e.preventDefault();
  mutate("workspace-status", async () => {
    const data = await api("/api/workspaces", {
      name: $("new-workspace-name").value,
    });
    await loadWorkspaces(data.id);
    $("workspace-dialog").close();
    $("workspace-form").reset();
  });
};

$("setup-demo").onclick = () =>
  mutate("demo-status", async () => {
    const data = await api("/api/demo/setup", { confirmSamplePolicies: true });
    sampleDocumentIds = data.documentIds;
    selected = new Set(data.documentIds);
    invalidate(
      "Fictional sample policy selected. Choose a scenario, then run the review.",
    );
    counts();
    await Promise.all([loadSources(), loadDocuments(), overview()]);
    msg(
      "demo-status",
      "Sample policy ready. These examples use the actual review engine.",
    );
  });
$("load-scenario").onclick = () => {
  const scenario = scenarios.find((s) => s.id === $("demo-scenario").value);
  if (!scenario) return;
  $("input").value = scenario.draft;
  selected = new Set(sampleDocumentIds);
  invalidate(`Sample scenario: ${scenario.expectation}`);
  counts();
  loadSources().catch((e) => msg("demo-status", e.message, true));
};
$("give-feedback").onclick = () => {
  feedbackReviewId = current?.id ?? null;
  $("feedback-form").reset();
  msg("feedback-status", "");
  $("feedback-context").textContent =
    `${workspace.name} · ${feedbackReviewId ? "Linked to the review currently shown." : "General workspace feedback."}`;
  $("feedback-dialog").showModal();
};
$("close-feedback").onclick = () => $("feedback-dialog").close();
$("feedback-form").onsubmit = (e) => {
  e.preventDefault();
  mutate("feedback-status", async () => {
    await api("/api/feedback", {
      rating: Number($("feedback-rating").value),
      kind: $("feedback-kind").value,
      note: $("feedback-note").value,
      reviewId: feedbackReviewId,
    });
    $("feedback-dialog").close();
    msg(
      "global-status",
      "Feedback saved for your workspace owner and administrators.",
    );
    if (admin()) await loadFeedback();
  });
};
function loadFeedback(append = false) {
  return paginate(
    "feedback",
    "/api/feedback",
    "feedback",
    (item) => {
      const row = el("article", undefined, "event-row");
      row.append(
        el(
          "strong",
          `${item.rating}/5 usefulness · ${item.kind.replace("_", " ")}`,
        ),
        el("p", item.note),
        el("p", `${item.author_email} · ${time(item.created_at)}`, "small"),
      );
      if (item.review_id) {
        const a = el("a", "Open related review");
        a.href = `#review=${item.review_id}`;
        a.onclick = (e) => {
          e.preventDefault();
          if (busy) return;
          history.pushState(null, "", a.href);
          openReview(item.review_id).catch((e) =>
            msg("global-status", e.message, true),
          );
        };
        row.append(a);
      }
      return row;
    },
    append,
  );
}
$("refresh-feedback").onclick = () =>
  loadFeedback().catch((e) => msg("global-status", e.message, true));
$("export-feedback").onclick = () =>
  mutate("global-status", async () => {
    const data = await api("/api/feedback/export");
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = el("a");
    a.href = url;
    a.download = `veriq-pilot-feedback-${workspace.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
$("logout").onclick = () =>
  mutate("global-status", async () => {
    await api("/api/auth/logout", {});
    location.href = "/";
  });
$("revoke-sessions").onclick = () =>
  mutate("global-status", async () => {
    if (!confirm("Sign out of all sessions on every device?")) return;
    await api("/api/auth/revoke-sessions", {});
    location.href = "/login.html";
  });
controls();
(async () => {
  try {
    const hash = location.hash;
    const health = await api("/api/health");
    if (
      health.mode !== "support_review" ||
      health.v < 6 ||
      !["pilot_feedback", "evidence_store", "ai_chat"].every((f) =>
        health.features?.includes(f),
      )
    )
      throw new Error(
        "The deployed API is older than this app. Apply migrations and deploy the API and Pages together before the demo.",
      );

    tools.media(health.mediaAvailable);
    user = (await api("/api/auth/me")).user;
    $("who").textContent = user.email;
    $("avatar").textContent = user.email[0].toUpperCase();
    await loadWorkspaces();
    const demo = await api("/api/demo");
    scenarios = demo.scenarios;
    $("demo-scenario").replaceChildren(
      ...scenarios.map((item) => {
        const o = el("option", item.label);
        o.value = item.id;
        return o;
      }),
    );
    const id = hash.match(/^#review=([a-f0-9-]{36})$/)?.[1];
    if (id) await openReview(id);
  } catch (e) {
    msg("global-status", e.message, true);
  }
})();
