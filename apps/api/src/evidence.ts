import {
  HttpError,
  readBody,
  string,
  page,
  nextCursor,
  like,
  uuid,
  rateLimit,
} from "./http.ts";
import { sha256 } from "./pipeline.ts";
import {
  requireRole,
  WRITERS,
  ADMINS,
  mutate,
  membershipGuard,
} from "./workspaces.ts";
import type { Scope } from "./workspaces.ts";
export const MAX_FILE = 5 * 1024 * 1024;
interface Item {
  id: string;
  workspace_id: string;
  user_id: string;
  kind: string;
  title: string;
  note: string;
  source_url: string | null;
  object_key: string | null;
  filename: string | null;
  media_type: string | null;
  byte_size: number;
  content_hash: string;
  status: string;
  created_at: string;
}
function publicItem({ object_key: _key, ...item }: Item) {
  return item;
}
async function bytes(req: Request) {
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "A file is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FILE + 65536) {
      await reader.cancel();
      throw new HttpError(413, "Choose a file up to 5 MiB.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
function fileType(data: Uint8Array, type: string) {
  const sig = (a: number[]) => a.every((b, i) => data[i] === b);
  if (type === "image/png" && sig([137, 80, 78, 71, 13, 10, 26, 10]))
    return type;
  if (type === "image/jpeg" && sig([255, 216, 255])) return type;
  if (type === "application/pdf" && sig([37, 80, 68, 70, 45])) return type;
  if (
    type === "audio/mpeg" &&
    (sig([73, 68, 51]) || (data[0] === 255 && (data[1] & 224) === 224))
  )
    return type;
  if (
    type === "audio/wav" &&
    sig([82, 73, 70, 70]) &&
    new TextDecoder().decode(data.slice(8, 12)) === "WAVE"
  )
    return type;
  if (
    type === "video/mp4" &&
    new TextDecoder().decode(data.slice(4, 8)) === "ftyp"
  )
    return type;
  throw new HttpError(
    400,
    "Supported files: PNG, JPEG, PDF, MP3, WAV or MP4 with matching file signatures.",
  );
}
export async function attachments(
  db: D1Database,
  workspace: string,
  review: string,
) {
  return (
    await db
      .prepare(
        `SELECT a.id,a.note AS attachment_note,a.user_id AS attached_by,a.created_at AS attached_at,
 e.id AS item_id,e.kind,e.title,e.note,e.source_url,e.filename,e.media_type,e.byte_size,e.content_hash,e.status,e.approved_by,e.approved_at
 FROM review_attachments a JOIN evidence_items e ON e.id=a.item_id WHERE a.workspace_id=? AND a.review_id=? ORDER BY a.created_at,a.id`,
      )
      .bind(workspace, review)
      .all()
  ).results;
}
export async function evidenceRoutes(
  req: Request,
  url: URL,
  scope: Scope,
  media?: R2Bucket,
): Promise<unknown | Response | null> {
  const { db, workspace, user } = scope;
  if (url.pathname === "/api/evidence" && req.method === "GET") {
    const p = page(url),
      params: unknown[] = [workspace.id];
    let where = "e.workspace_id=?";
    const kind = url.searchParams.get("kind"),
      status = url.searchParams.get("status");
    if (kind) {
      if (!["link", "media"].includes(kind))
        throw new HttpError(400, "Invalid kind.");
      where += " AND e.kind=?";
      params.push(kind);
    }
    if (status) {
      if (!["draft", "approved", "archived"].includes(status))
        throw new HttpError(400, "Invalid status.");
      where += " AND e.status=?";
      params.push(status);
    }
    if (p.query) {
      where += " AND (e.title LIKE ? ESCAPE '\\' OR e.note LIKE ? ESCAPE '\\')";
      params.push(like(p.query), like(p.query));
    }
    if (p.cursor) {
      where += " AND (e.created_at<? OR (e.created_at=? AND e.id<?))";
      params.push(p.cursor.time, p.cursor.time, p.cursor.id);
    }
    const rows = (
      await db
        .prepare(
          `SELECT e.*,u.email AS author_email FROM evidence_items e JOIN users u ON u.id=e.user_id WHERE ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT ?`,
        )
        .bind(...params, p.limit + 1)
        .all<Item>()
    ).results;
    return {
      items: rows.slice(0, p.limit).map(publicItem),
      nextCursor: nextCursor(rows, p.limit),
      mediaAvailable: !!media,
    };
  }
  if (
    ["/api/evidence/links", "/api/evidence/media"].includes(url.pathname) &&
    req.method === "POST"
  ) {
    requireRole(scope, WRITERS);
    let title: string,
      note: string,
      source: string | null = null,
      key: string | null = null,
      filename: string | null = null,
      type: string | null = null,
      size = 0,
      hash: string,
      data: Uint8Array | undefined;
    const id = crypto.randomUUID(),
      kind = url.pathname.endsWith("links") ? "link" : "media";
    if (kind === "link") {
      const body = await readBody(req);
      title = string(body.title, "Title", 120);
      note = string(body.note, "Context", 2000, 5);
      try {
        const u = new URL(string(body.url, "Link", 2000));
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password
        )
          throw new Error();
        source = u.href;
      } catch {
        throw new HttpError(400, "Use an HTTP(S) link without credentials.");
      }
      hash = await sha256(JSON.stringify({ title, note, url: source }));
    } else {
      if (!media)
        throw new HttpError(
          503,
          "Media uploads are disabled by the free-only policy. Local emulator uploads require LOCAL_MEDIA_DEMO and a local MEDIA binding. Save a link instead.",
          "MEDIA_UNAVAILABLE",
        );
      if (!/^multipart\/form-data;/.test(req.headers.get("content-type") ?? ""))
        throw new HttpError(400, "Send a multipart file upload.");
      if (!(await rateLimit(db, `media:${user.id}`, 10, 60)))
        throw new HttpError(
          429,
          "Upload limit reached. Try again in a minute.",
          "MEDIA_RATE_LIMIT",
        );
      const raw = await bytes(req);
      let form: FormData;
      try {
        form = await new Request(req.url, {
          method: "POST",
          headers: { "content-type": req.headers.get("content-type")! },
          body: raw,
        }).formData();
      } catch {
        throw new HttpError(400, "Invalid multipart upload.");
      }
      title = string(form.get("title"), "Title", 120);
      note = string(form.get("note"), "Context", 2000, 5);
      const file = form.get("file");
      if (!file || typeof file === "string" || !file.size)
        throw new HttpError(400, "Choose one nonempty file.");
      if (file.size > MAX_FILE)
        throw new HttpError(413, "Choose a file up to 5 MiB.");
      if (form.getAll("file").length !== 1)
        throw new HttpError(400, "Upload one file at a time.");
      filename =
        file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "evidence";
      data = new Uint8Array(await file.arrayBuffer());
      type = fileType(data, file.type);
      size = data.length;
      hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
      )
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      key = `${workspace.id}/${id}`;
    }
    // Reserve quota and metadata before R2 IO; draft uploads cannot be approved until bytes exist.
    const created = await mutate(
      scope,
      db
        .prepare(
          `INSERT INTO evidence_items(id,workspace_id,user_id,kind,title,note,source_url,object_key,filename,media_type,byte_size,content_hash)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${membershipGuard()} AND (SELECT COUNT(*) FROM evidence_items WHERE workspace_id=?)<500 AND (SELECT COALESCE(SUM(byte_size),0) FROM evidence_items WHERE workspace_id=?)+?<=104857600`,
        )
        .bind(
          id,
          workspace.id,
          user.id,
          kind,
          title,
          note,
          source,
          key,
          filename,
          type,
          size,
          hash,
          workspace.id,
          user.id,
          workspace.id,
          workspace.id,
          size,
        ),
      "evidence.created",
      id,
      { kind, hash, size },
    );
    if (!created)
      throw new HttpError(
        409,
        "Permissions changed or the 500-item / 100 MiB workspace limit was reached.",
        "EVIDENCE_LIMIT",
      );
    if (key && data && media) {
      try {
        if (
          !(await media.put(key, data, {
            httpMetadata: { contentType: type! },
            customMetadata: { hash },
          }))
        )
          throw new Error("Upload failed");
      } catch {
        try {
          await media.delete(key);
        } catch {
          /* Operator reconciliation handles unavailable object storage. */
        }
        await db
          .prepare(
            "DELETE FROM evidence_items WHERE id=? AND status='draft' AND NOT EXISTS(SELECT 1 FROM review_attachments WHERE item_id=?)",
          )
          .bind(id, id)
          .run();
        throw new HttpError(
          503,
          "Upload failed. Retry the file.",
          "MEDIA_UPLOAD_FAILED",
        );
      }
      // Access may have changed while uploading. Never return the private object to a revoked writer.
      if (
        !(await db
          .prepare(`SELECT 1 WHERE ${membershipGuard()}`)
          .bind(workspace.id, user.id)
          .first())
      )
        throw new HttpError(
          409,
          "Permissions changed during upload. Ask an administrator to inspect the saved item.",
        );
    }
    return { id, status: "draft" };
  }
  const match = url.pathname.match(
    /^\/api\/evidence\/([a-f0-9-]{36})(?:\/(approve|archive|download|attach))?$/,
  );
  if (!match) return null;
  const row = await db
    .prepare("SELECT * FROM evidence_items WHERE id=? AND workspace_id=?")
    .bind(match[1], workspace.id)
    .first<Item>();
  if (!row) throw new HttpError(404, "Evidence item not found.");
  if (!match[2] && req.method === "GET") return { item: publicItem(row) };
  if (match[2] === "download" && req.method === "GET") {
    if (row.kind !== "media") throw new HttpError(400, "This item is a link.");
    if (!media)
      throw new HttpError(
        503,
        "Private media storage is unavailable.",
        "MEDIA_UNAVAILABLE",
      );
    const object = await media.get(row.object_key!);
    if (!object)
      throw new HttpError(
        404,
        "Stored file is unavailable. Contact your administrator.",
      );
    if (
      object.size !== row.byte_size ||
      object.customMetadata?.hash !== row.content_hash
    )
      throw new HttpError(
        409,
        "Stored file differs from the recorded fingerprint. Contact your administrator.",
        "MEDIA_INTEGRITY_ERROR",
      );
    // Re-check after asynchronous object lookup.
    if (
      !(await db
        .prepare(
          "SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?",
        )
        .bind(workspace.id, user.id)
        .first())
    )
      throw new HttpError(404, "Workspace unavailable.");
    return new Response(object.body, {
      headers: {
        "content-type": row.media_type!,
        "content-length": String(row.byte_size),
        "content-disposition": `attachment; filename="${row.filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (req.method !== "POST" || !match[2]) return null;
  if (match[2] === "attach") {
    requireRole(scope, WRITERS);
    const body = await readBody(req);
    if (!uuid(body.reviewId)) throw new HttpError(400, "Choose a review ID.");
    const note = string(body.note, "Attachment explanation", 2000, 5),
      id = crypto.randomUUID();
    if (
      !(await mutate(
        scope,
        db
          .prepare(
            `INSERT OR IGNORE INTO review_attachments(id,workspace_id,review_id,item_id,user_id,note) SELECT ?,?,?,?,?,? WHERE ${membershipGuard()} AND EXISTS(SELECT 1 FROM evidence_items WHERE id=? AND workspace_id=? AND status='approved') AND EXISTS(SELECT 1 FROM support_reviews WHERE id=? AND workspace_id=?) AND (SELECT COUNT(*) FROM review_attachments WHERE review_id=?)<20`,
          )
          .bind(
            id,
            workspace.id,
            body.reviewId,
            row.id,
            user.id,
            note,
            workspace.id,
            user.id,
            row.id,
            workspace.id,
            body.reviewId,
            workspace.id,
            body.reviewId,
          ),
        "evidence.attached",
        id,
        { itemId: row.id, reviewId: body.reviewId },
      ))
    )
      throw new HttpError(
        409,
        "Use an approved item and a review in this workspace. The item may already be attached or the 20-attachment limit reached.",
      );
    return { id, ok: true };
  }
  requireRole(scope, ADMINS);
  if (match[2] === "approve") {
    if (workspace.require_two_person && row.user_id === user.id)
      throw new HttpError(
        403,
        "A different administrator must approve this item.",
        "SEPARATE_APPROVER_REQUIRED",
      );
    const stored =
      row.kind === "media" && media ? await media.head(row.object_key!) : null;
    if (
      row.kind === "media" &&
      (!stored ||
        stored.size !== row.byte_size ||
        stored.customMetadata?.hash !== row.content_hash)
    )
      throw new HttpError(
        409,
        "The uploaded file must be available before approval.",
      );
  }
  const approve = match[2] === "approve";
  if (
    !(await mutate(
      scope,
      db
        .prepare(
          `UPDATE evidence_items SET status=?,approved_by=CASE WHEN ? THEN ? ELSE approved_by END,approved_at=CASE WHEN ? THEN datetime('now') ELSE approved_at END WHERE id=? AND workspace_id=? AND status ${approve ? "='draft'" : "!='archived'"} AND (?=0 OR user_id!=?) AND ${membershipGuard(ADMINS)}`,
        )
        .bind(
          approve ? "approved" : "archived",
          approve ? 1 : 0,
          user.id,
          approve ? 1 : 0,
          row.id,
          workspace.id,
          approve ? workspace.require_two_person : 0,
          user.id,
          workspace.id,
          user.id,
        ),
      `evidence.${approve ? "approved" : "archived"}`,
      row.id,
      { hash: row.content_hash },
    ))
  )
    throw new HttpError(409, "Item or permissions changed. Refresh and retry.");
  return { id: row.id, status: approve ? "approved" : "archived" };
}
