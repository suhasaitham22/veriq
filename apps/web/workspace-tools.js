/** Private references and policy-grounded chat. All user/model text uses textContent. */
export function workspaceTools(ctx) {
  const $ = (id) => document.getElementById(id),
    { api, el, msg, mutate, writer, admin, openReview } = ctx;
  let selected = new Set(),
    parent = null,
    retry = null,
    mediaAvailable = false,
    reviewId = null;
  const lists = new Map();
  function controls(busy) {
    $("evidence-fields").disabled = busy || !writer();
    $("chat-fields").disabled = busy || !writer() || !ctx.aiAvailable();
    $("evidence-file").disabled = busy || !writer() || !mediaAvailable;
    $("evidence-kind").querySelector('[value="media"]').disabled =
      !mediaAvailable;
    $("chat-new").disabled = busy;
    document
      .querySelectorAll("[data-chat-source]")
      .forEach((n) => (n.disabled = busy || !writer()));
  }
  function reset() {
    selected.clear();
    parent = null;
    retry = null;
    reviewId = null;
    lists.clear();
    for (const id of [
      "evidence-list",
      "chat-sources",
      "chat-output",
      "chat-history",
      "tools-status",
      "chat-status",
    ])
      $(id).replaceChildren();
    $("evidence-form").reset();
    $("chat-form").reset();
    $("evidence-search").value = "";
    $("evidence-status").value = "";
    $("chat-question").value = "";
    for (const id of [
      "more-evidence-list",
      "more-chat-sources",
      "more-chat-history",
    ])
      $(id).hidden = true;
    toggleKind();
    updateParent();
  }
  async function paginate(id, path, key, render, append = false) {
    let state = lists.get(id) || { seq: 0, cursor: null };
    lists.set(id, state);
    if (append && !state.cursor) return;
    const seq = ++state.seq,
      epoch = ctx.epoch(),
      u = new URL(path, location.origin);
    u.searchParams.set("limit", "25");
    if (append) u.searchParams.set("cursor", state.cursor);
    const data = await api(u.pathname + u.search);
    if (epoch !== ctx.epoch() || seq !== state.seq) return;
    if (!append) $(id).replaceChildren();
    for (const item of data[key]) $(id).append(render(item));
    if (!$(id).children.length)
      $(id).append(el("p", "No records yet.", "empty-state"));
    state.cursor = data.nextCursor;
    $(`more-${id}`).hidden = !state.cursor;
    ctx.controls();
  }
  function action(text, fn, permission) {
    const n = el("button", text, "btn btn-ghost btn-sm");
    n.type = "button";
    if (permission) n.dataset[permission] = "";
    n.onclick = () => mutate("tools-status", fn);
    return n;
  }
  function card(item) {
    const n = el("article", undefined, "document-card");
    n.append(
      el("span", `${item.kind} · ${item.status}`, "badge " + item.status),
      el("h3", item.title),
      el("p", item.note),
      el(
        "small",
        `${item.author_email} · SHA-256 ${item.content_hash.slice(0, 16)}`,
      ),
    );
    const actions = el("div", undefined, "row-actions");
    if (item.kind === "link") {
      const a = el("a", "Open saved link", "btn btn-ghost btn-sm");
      a.href = item.source_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      actions.append(a);
    } else
      actions.append(
        action(
          `Download ${item.filename} (${(item.byte_size / 1024).toFixed(1)} KiB)`,
          () => download(item),
        ),
      );
    if (
      item.status === "draft" &&
      admin() &&
      (!ctx.workspace().require_two_person || item.user_id !== ctx.user().id)
    )
      actions.append(
        action(
          "Approve reference",
          async () => {
            if (
              !confirm(
                "Approve this reference after inspecting its content? Approval does not change AI verdicts or verify every claim.",
              )
            )
              return;
            await api(`/api/evidence/${item.id}/approve`, {});
            await loadEvidence();
          },
          "admin",
        ),
      );
    if (item.status !== "archived" && admin())
      actions.append(
        action(
          "Archive reference",
          async () => {
            await api(`/api/evidence/${item.id}/archive`, {});
            await loadEvidence();
          },
          "admin",
        ),
      );
    if (item.status === "approved" && writer())
      actions.append(
        action(
          "Attach to review",
          async () => {
            if (!reviewId) {
              msg(
                "tools-status",
                "Open a saved review and choose “Add supporting reference” first.",
                true,
              );
              return;
            }
            await api(`/api/evidence/${item.id}/attach`, {
              reviewId,
              note: $("attachment-note").value,
            });
            msg(
              "tools-status",
              "Supporting reference attached. It does not change the model verdict.",
            );
          },
          "write",
        ),
      );
    n.append(actions);
    return n;
  }
  async function download(item) {
    const res = await fetch(
      `${window.VERIQ_API}/api/evidence/${item.id}/download`,
      {
        credentials: "include",
        headers: { "X-Workspace-ID": ctx.workspace().id },
      },
    );
    if (res.status === 401) {
      location.href = "/login.html";
      throw new Error("Sign in again.");
    }
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Download failed.");
    }
    const url = URL.createObjectURL(await res.blob()),
      a = el("a");
    a.href = url;
    a.download = item.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function loadEvidence(append = false) {
    return paginate(
      "evidence-list",
      `/api/evidence?${new URLSearchParams({ q: $("evidence-search").value, status: $("evidence-status").value })}`,
      "items",
      card,
      append,
    );
  }
  function loadChatSources(append = false) {
    return paginate(
      "chat-sources",
      "/api/documents?status=approved",
      "documents",
      (doc) => {
        const n = el("label", undefined, "source-item"),
          check = el("input");
        check.type = "checkbox";
        check.checked = selected.has(doc.id);
        if (doc.eligible) {
          check.dataset.chatSource = "";
          check.onchange = () => {
            if (check.checked) selected.add(doc.id);
            else selected.delete(doc.id);
            retry = null;
          };
        } else {
          check.disabled = true;
          selected.delete(doc.id);
        }
        check.setAttribute(
          "aria-label",
          `Chat policy ${doc.title}, version ${doc.version}`,
        );
        n.append(
          check,
          el(
            "span",
            `${doc.title} · ${doc.version}${doc.eligible ? "" : " · not active"}`,
          ),
        );
        return n;
      },
      append,
    );
  }
  function updateParent() {
    $("chat-context").textContent = parent
      ? "Follow-up in this conversation. Current selected policies are the evidence for the next answer."
      : "New conversation. Select approved policies, then ask a support question.";
  }
  function renderTurn(turn) {
    const n = el("article", undefined, "chat-turn");
    n.append(
      el("h3", turn.question),
      el("p", turn.answer, "chat-answer"),
      el(
        "p",
        "AI draft · not approved for sending. Open the claim review to inspect quotes and decide.",
        "small",
      ),
    );
    const actions = el("div", undefined, "row-actions");
    actions.append(
      action("Open claim review", () => openReview(turn.review_id)),
      action("Continue conversation", async () => {
        parent = turn.id;
        retry = null;
        updateParent();
        $("chat-question").focus();
      }),
    );
    n.append(actions);
    return n;
  }
  function loadChatHistory(append = false) {
    return paginate("chat-history", "/api/chat", "turns", renderTurn, append);
  }
  function toggleKind() {
    const media = $("evidence-kind").value === "media";
    $("evidence-url-field").hidden = media;
    $("evidence-file-field").hidden = !media;
    $("evidence-url").required = !media;
    $("evidence-file").required = media;
  }
  $("evidence-kind").onchange = toggleKind;
  $("evidence-form").onsubmit = (e) => {
    e.preventDefault();
    mutate("tools-status", async () => {
      msg("tools-status", "Saving private reference…");
      if ($("evidence-kind").value === "link")
        await api("/api/evidence/links", {
          title: $("evidence-title").value,
          note: $("evidence-note").value,
          url: $("evidence-url").value,
        });
      else {
        const file = $("evidence-file").files[0];
        if (!file || file.size > 5 * 1024 * 1024)
          throw new Error("Choose one file up to 5 MiB.");
        const form = new FormData();
        form.set("title", $("evidence-title").value);
        form.set("note", $("evidence-note").value);
        form.set("file", file);
        const res = await fetch(`${window.VERIQ_API}/api/evidence/media`, {
          method: "POST",
          credentials: "include",
          headers: { "X-Workspace-ID": ctx.workspace().id },
          body: form,
        });
        if (res.status === 401) {
          location.href = "/login.html";
          throw new Error("Sign in again.");
        }
        if (!res.headers.get("content-type")?.includes("application/json"))
          throw new Error(
            "Media API unavailable. Deploy the matching API and Pages proxy.",
          );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed.");
      }
      $("evidence-form").reset();
      toggleKind();
      msg(
        "tools-status",
        "Reference saved as a draft. Inspect it before approval.",
      );
      await loadEvidence();
    });
  };
  $("chat-question").oninput = () => {
    retry = null;
  };
  $("chat-form").onsubmit = (e) => {
    e.preventDefault();
    mutate("chat-status", async () => {
      if (!selected.size || selected.size > 10)
        throw new Error("Select 1–10 approved policies for chat.");
      const body = {
        question: $("chat-question").value,
        documentIds: [...selected].sort(),
        parentId: parent,
      };
      if (!retry || JSON.stringify(retry.body) !== JSON.stringify(body))
        retry = { body, key: crypto.randomUUID() };
      msg("chat-status", "Generating a draft and checking every claim…");
      const data = await api("/api/chat", retry.body, retry.key);
      $("chat-output").replaceChildren(renderTurn(data.turn));
      parent = data.turn.id;
      retry = null;
      $("chat-question").value = "";
      updateParent();
      msg(
        "chat-status",
        "Draft saved with a claim review. A person still decides whether to send.",
      );
      await loadChatHistory();
    });
  };
  $("chat-new").onclick = () => {
    parent = null;
    retry = null;
    $("chat-output").replaceChildren();
    updateParent();
  };
  for (const id of ["evidence-search", "evidence-status"])
    $(id).onchange = () =>
      loadEvidence().catch((e) => msg("tools-status", e.message, true));
  $("refresh-evidence").onclick = () =>
    loadEvidence().catch((e) => msg("tools-status", e.message, true));
  $("more-evidence-list").onclick = () =>
    loadEvidence(true).catch((e) => msg("tools-status", e.message, true));
  $("more-chat-sources").onclick = () =>
    loadChatSources(true).catch((e) => msg("chat-status", e.message, true));
  $("more-chat-history").onclick = () =>
    loadChatHistory(true).catch((e) => msg("chat-status", e.message, true));
  return {
    controls,
    reset,
    media(value) {
      mediaAvailable = value;
      $("media-availability").textContent = value
        ? "Private file storage available. Up to 5 MiB per file; 100 MiB per workspace."
        : "Production media uploads are disabled under the free-only policy. Save a link to an approved company resource instead. File uploads are available only in the local emulator demo.";
    },
    async view(name) {
      if (name === "evidence") await loadEvidence();
      if (name === "chat")
        await Promise.all([loadChatSources(), loadChatHistory()]);
    },
    attachTarget(id) {
      reviewId = id;
      $("attachment-context").textContent =
        `Attach an approved reference to review ${id}.`;
      $("attachment-note").value = "";
    },
    renderAttachments(data) {
      const section = el("section", undefined, "decision-card");
      section.append(
        el("h3", "Supporting references"),
        el(
          "p",
          "Human-approved attachments supplement this record. They do not change claim verdicts.",
          "small",
        ),
      );
      for (const item of data.attachments || []) {
        const n = el(
          "p",
          `${item.title} · ${item.status} · ${item.attachment_note}`,
        );
        if (item.kind === "link") {
          const a = el("a", " Open link");
          a.href = item.source_url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          n.append(a);
        } else
          n.append(
            action("Download reference", () =>
              download({ ...item, id: item.item_id }),
            ),
          );
        section.append(n);
      }
      if (writer())
        section.append(
          action(
            "Add supporting reference",
            async () => {
              this.attachTarget(data.id);
              ctx.view("evidence");
            },
            "write",
          ),
        );
      return section;
    },
  };
}
