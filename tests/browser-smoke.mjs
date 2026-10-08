/** Browser → production API → SQLite → receipt rendering, with a controlled AI fixture. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import api from "../apps/api/src/index.ts";
import { fixture } from "./helpers.ts";

const f = await fixture({ async run(_model, input) {
  const { statement, passages } = JSON.parse(input.messages[1].content);
  if (!statement.includes("unlimited") && statement !== "Refund requests must be submitted within 30 days of purchase.") {
    return { response: JSON.stringify({ notApplicable: false, evidence: [] }) };
  }
  const quote = statement.includes("unlimited")
    ? "Starter plans include 100 exports per month."
    : "Refund requests must be submitted within 30 days of purchase.";
  const passage = passages.find((p) => p.text.includes(quote));
  return { response: JSON.stringify({ notApplicable: false, evidence: passage ? [{ passageId: passage.id, stance: statement.includes("unlimited") ? "refutes" : "supports", quote }] : [] }) };
} });
const root = resolve("apps/web");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await api.fetch(new Request(url, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) }), f.env);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
    }
    const path = resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!path.startsWith(`${root}/`)) { res.writeHead(403); res.end(); return; }
    const content = await readFile(path);
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(path)] || "text/plain");
    res.end(content);
  } catch { res.writeHead(404); res.end("Not found"); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://localhost:${server.address().port}`;
f.env.WEB_ORIGIN = origin;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  assert.match(await page.title(), /support answers/i);
  await page.goto(`${origin}/login.html?mode=signup`);
  await page.getByLabel("Email").fill("browser@example.test");
  await page.getByLabel("Password").fill("pilot-test-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/app.html");
  await page.getByRole("button", { name: "Load pilot example" }).click();
  await page.getByRole("button", { name: "Save draft document" }).click();
  await page.getByRole("button", { name: "Approve this version" }).click();
  await page.getByText("Document approved and selected for review.").waitFor();
  await page.getByRole("button", { name: "Review against selected documents" }).click();
  await page.locator("#results .requires_changes").waitFor();
  assert.equal(await page.locator("#results .receipt").count(), 2);
  assert.equal(await page.locator("#results .contradicted").count(), 1);
  assert.equal(await page.locator("#results .supported").count(), 1);
  assert.match(await page.locator("#results").innerText(), /Starter plans include 100 exports/);
  await page.locator("#history a").first().click();
  await page.getByText(/^Historical review:/).waitFor();
  await page.getByLabel("Reply to review").fill("An unsupported promise to the customer.");
  assert.equal(await page.locator("#results .receipt").count(), 0);
  await page.getByRole("button", { name: "Review against selected documents" }).click();
  await page.locator("#results .needs_review").waitFor();
  // Ensure imported text cannot execute markup, and the view fits a mobile screen.
  await page.getByLabel("Document title").fill('<img src=x onerror="window.hacked=true">');
  await page.getByLabel("Version", { exact: true }).fill("xss-test");
  await page.getByLabel("Approved policy text").fill("<script>window.hacked=true</script> Policy details remain ordinary text.");
  await page.getByRole("button", { name: "Save draft document" }).click();
  await page.locator("#documents").getByText('<img src=x onerror="window.hacked=true"> · xss-test', { exact: true }).waitFor();
  assert.equal(await page.locator("#documents img, #documents script").count(), 0);
  assert.equal(await page.evaluate(() => window.hacked), undefined);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_reviews").get().n, 2);
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(`${origin}/`);
  await page.goto(`${origin}/app.html`); await page.waitForURL("**/login.html");
  console.log("Browser smoke passed: signup, approved document, contradictory/supported/missing evidence, history, edit invalidation, safe rendering, mobile layout, logout.");
} finally {
  await browser?.close(); await new Promise((done) => server.close(done)); f.sqlite.close();
}
