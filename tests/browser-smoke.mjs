/** Browser → production API → SQLite → receipt rendering, with a controlled AI fixture. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import api from "../apps/api/src/index.ts";
import pages from "../apps/web/_worker.js";
import { fixture } from "./helpers.ts";

const f = await fixture({
  async run(_model, input) {
    const { statement, passages } = JSON.parse(input.messages[1].content);
    if (
      !statement.includes("unlimited") &&
      statement !==
        "Refund requests must be submitted within 30 days of purchase."
    ) {
      return {
        response: JSON.stringify({ notApplicable: false, evidence: [] }),
      };
    }
    const quote = statement.includes("unlimited")
      ? "Starter plans include 100 exports per month."
      : "Refund requests must be submitted within 30 days of purchase.";
    const passage = passages.find((p) => p.text.includes(quote));
    return {
      response: JSON.stringify({
        notApplicable: false,
        evidence: passage
          ? [
              {
                passageId: passage.id,
                stance: statement.includes("unlimited")
                  ? "refutes"
                  : "supports",
                quote,
              },
            ]
          : [],
      }),
    };
  },
});
const root = resolve("apps/web");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await api.fetch(
        new Request(url, {
          method: req.method,
          headers: req.headers,
          ...(body.length ? { body } : {}),
        }),
        f.env,
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }
    const path = resolve(
      root,
      `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
    );
    if (!path.startsWith(`${root}/`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const content = await readFile(path);
    const asset = await pages.fetch(new Request(url), {
      ASSETS: {
        async fetch() {
          return new Response(content, {
            headers: {
              "content-type":
                {
                  ".html": "text/html",
                  ".js": "text/javascript",
                  ".css": "text/css",
                }[extname(path)] || "text/plain",
            },
          });
        },
      },
    });
    res.writeHead(asset.status, Object.fromEntries(asset.headers));
    res.end(Buffer.from(await asset.arrayBuffer()));
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://localhost:${server.address().port}`;
f.env.WEB_ORIGIN = origin;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  assert.match(await page.title(), /support answers/i);
  await page.goto(`${origin}/login.html?mode=signup`);
  await page.getByLabel("Email").fill("browser@example.test");
  await page.getByLabel("Password").fill("pilot-test-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/app.html");
  await page
    .getByRole("button", { name: "Set up sample demo", exact: true })
    .click();
  await page
    .getByText(
      "Sample policy ready. These examples use the actual review engine.",
    )
    .waitFor();
  await page.getByLabel("Demo scenario").selectOption("supported");
  await page
    .getByRole("button", { name: "Load scenario", exact: true })
    .click();
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await page.locator("#results .ready_for_review").waitFor();
  await page
    .getByRole("button", { name: "Give feedback", exact: true })
    .click();
  await page.getByLabel("How useful was this workflow?").selectOption("4");
  await page.getByLabel("Feedback category").selectOption("evidence");
  await page
    .getByLabel("What worked, and what should improve?")
    .fill(
      "<script>window.hacked=true</script> Exact quotes made the policy easy to check.",
    );
  await page
    .getByRole("button", { name: "Save feedback", exact: true })
    .click();
  await page
    .getByText("Feedback saved for your workspace owner and administrators.")
    .waitFor();
  await page
    .getByRole("button", { name: "Pilot feedback", exact: true })
    .click();
  await page
    .locator("#feedback")
    .getByText(
      "<script>window.hacked=true</script> Exact quotes made the policy easy to check.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.locator("#feedback script").count(), 0);
  const feedbackDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export feedback JSON", exact: true })
    .click();
  assert.match(
    (await feedbackDownload).suggestedFilename(),
    /^veriq-pilot-feedback-.*\.json$/,
  );
  await page.getByRole("button", { name: "Review desk", exact: true }).click();
  await page.getByLabel("Demo scenario").selectOption("missing");
  await page
    .getByRole("button", { name: "Load scenario", exact: true })
    .click();
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await page.locator("#results .needs_review").waitFor();
  // Original manual policy flow remains available after the guided demo.
  await page.getByRole("button", { name: "Load example" }).click();
  await page.getByRole("button", { name: "Save draft document" }).click();
  await page.getByRole("button", { name: "Approve this version" }).click();
  await page
    .getByText("Document approved. Select it in Review sources.")
    .waitFor();
  await page.getByRole("button", { name: "Review desk" }).click();
  await page
    .getByLabel("Use [Sample] Export and refund policy, version demo-v1")
    .uncheck();
  await page.getByLabel("Use Example export policy, version pilot-1").check();
  await page.getByRole("button", { name: "Review draft" }).click();
  await page.locator("#results .requires_changes").waitFor();
  assert.equal(await page.locator("#results .receipt").count(), 2);
  assert.equal(await page.locator("#results .contradicted").count(), 1);
  assert.equal(await page.locator("#results .supported").count(), 1);
  assert.match(
    await page.locator("#results").innerText(),
    /Starter plans include 100 exports/,
  );
  await page.locator("#history a").first().click();
  await page.getByText(/^Saved review./).waitFor();
  await page
    .getByLabel("Reply to review")
    .fill("An unsupported promise to the customer.");
  assert.equal(await page.locator("#results .receipt").count(), 0);
  await page.getByRole("button", { name: "Review draft" }).click();
  await page.locator("#results .needs_review").waitFor();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  // Ensure imported text cannot execute markup, and the view fits a mobile screen.
  await page
    .getByLabel("Document title")
    .fill('<img src=x onerror="window.hacked=true">');
  await page.getByLabel("Version", { exact: true }).fill("xss-test");
  await page.locator("#document-file").setInputFiles({
    name: "policy.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "<script>window.hacked=true</script> Policy details remain ordinary text.",
    ),
  });
  await page
    .getByText("Text imported. Check its scope and exceptions before saving.")
    .waitFor();
  await page.getByRole("button", { name: "Save draft document" }).click();
  await page
    .locator("#documents")
    .getByText('<img src=x onerror="window.hacked=true"> · xss-test', {
      exact: true,
    })
    .waitFor();
  await page
    .locator("#documents article")
    .filter({ hasText: "xss-test" })
    .getByRole("button", { name: "Inspect text" })
    .click();
  await page
    .locator("#documents pre")
    .getByText(
      "<script>window.hacked=true</script> Policy details remain ordinary text.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.locator("#documents img, #documents script").count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.hacked), undefined);
  // Team workspaces require a different administrator to approve a policy.
  await page.getByRole("button", { name: "+ New team", exact: true }).click();
  await page.getByLabel("Workspace name").fill("Enterprise support");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByText("Two-person policy approval", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Team & access" }).click();
  await page.getByLabel("Member email").fill("bob@example.test");
  await page.getByLabel("Role", { exact: true }).selectOption("admin");
  await page.getByRole("button", { name: "Add member", exact: true }).click();
  await page.getByText("bob@example.test", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page.getByLabel("Document title").fill("Team refunds");
  await page.getByLabel("Version", { exact: true }).fill("v1");
  await page
    .getByLabel("Approved policy text")
    .fill("Refund requests must be submitted within 30 days of purchase.");
  await page.getByRole("button", { name: "Save draft document" }).click();
  await page.getByText("Awaiting another administrator’s approval.").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Approve this version" }).count(),
    0,
  );
  const bobContext = await browser.newContext();
  await bobContext.addCookies([
    { name: "veriq_session", value: f.bobToken, url: origin },
  ]);
  const bobPage = await bobContext.newPage();
  bobPage.setDefaultTimeout(10000);
  bobPage.on("pageerror", (e) => errors.push(e.message));
  await bobPage.goto(`${origin}/app.html`);
  await bobPage
    .locator("#workspace-name")
    .getByText("Personal workspace", { exact: true })
    .waitFor();
  await bobPage
    .locator("#workspace-select")
    .selectOption({ label: "Enterprise support" });
  await bobPage.getByRole("button", { name: "Documents", exact: true }).click();
  await bobPage.getByRole("button", { name: "Approve this version" }).click();
  await bobPage
    .getByText("Document approved. Select it in Review sources.")
    .waitFor();
  await bobPage.getByRole("button", { name: "Review desk" }).click();
  await bobPage.getByLabel("Use Team refunds, version v1").check();
  await bobPage
    .getByLabel("Reply to review")
    .fill("Refund requests must be submitted within 30 days of purchase.");
  await bobPage.getByRole("button", { name: "Review draft" }).click();
  await bobPage.locator("#results .ready_for_review").waitFor();
  await bobPage
    .getByLabel("Decision note")
    .fill("Checked the approved refund policy.");
  await bobPage
    .getByRole("button", { name: "Approve draft", exact: true })
    .click();
  await bobPage.getByText("Decision: approved · revision 1").waitFor();
  const downloadPromise = bobPage.waitForEvent("download");
  await bobPage.getByRole("link", { name: "Export evidence JSON" }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^veriq-review-.*\.json$/);
  await page.getByRole("button", { name: "Review desk" }).click();
  await page
    .getByRole("button", { name: "Refresh", exact: true })
    .first()
    .click();
  await page.locator("#history a").first().click();
  await page.getByText("Decision: approved · revision 1").waitFor();
  await page.getByRole("button", { name: "Audit trail", exact: true }).click();
  await page.getByText("review · approved", { exact: true }).waitFor();
  // A role downgrade is reflected after reloading the workspace.
  await page.getByRole("button", { name: "Team & access" }).click();
  await page.getByLabel("Role for bob@example.test").selectOption("viewer");
  await page.getByRole("button", { name: "Save role" }).click();
  await page.getByText("Member role updated.").waitFor();
  await bobPage.reload();
  await bobPage.waitForFunction(
    () => document.getElementById("role-chip")?.textContent === "viewer",
  );
  assert.equal(
    await bobPage.getByRole("button", { name: "Review draft" }).isDisabled(),
    true,
  );
  assert.equal(
    await bobPage.getByRole("button", { name: "Team & access" }).isVisible(),
    false,
  );
  assert.equal(
    await bobPage
      .getByRole("button", { name: "Pilot feedback", exact: true })
      .isVisible(),
    false,
  );
  await bobPage
    .getByRole("button", { name: "Give feedback", exact: true })
    .click();
  await bobPage.getByLabel("How useful was this workflow?").selectOption("3");
  await bobPage
    .getByLabel("What worked, and what should improve?")
    .fill(
      "As a viewer, I could inspect evidence but could not change decisions.",
    );
  await bobPage
    .getByRole("button", { name: "Save feedback", exact: true })
    .click();
  await bobPage
    .getByText("Feedback saved for your workspace owner and administrators.")
    .waitFor();
  await page
    .getByRole("button", { name: "Pilot feedback", exact: true })
    .click();
  await page
    .locator("#feedback")
    .getByText(
      "As a viewer, I could inspect evidence but could not change decisions.",
      { exact: true },
    )
    .waitFor();
  await bobContext.close();
  await page.getByRole("button", { name: "Review desk" }).click();
  await page.waitForFunction(
    () => document.getElementById("metric-active").textContent === "1",
  );
  await page.screenshot({ path: "/tmp/veriq-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({ path: "/tmp/veriq-mobile.png", fullPage: true });
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM support_reviews").get().n,
    5,
  );
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page
    .getByText("Document archived. Historical evidence is preserved.")
    .waitFor();
  await page.getByRole("button", { name: "Review desk" }).click();
  await page.locator("#history a").first().click();
  await page
    .getByText(
      "A source policy is no longer active. Run a new review before approving.",
    )
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Approve draft", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(`${origin}/`);
  await page.goto(`${origin}/app.html`);
  await page.waitForURL("**/login.html");
  await page.getByLabel("Email").fill("browser@example.test");
  await page.getByLabel("Password").fill("pilot-test-password");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL("**/app.html");
  await page
    .locator("#workspace-name")
    .getByText("Enterprise support", { exact: true })
    .waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  const staleContext = await browser.newContext();
  const stalePage = await staleContext.newPage();
  await stalePage.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, service: "veriq-api", v: 2 }),
    }),
  );
  await stalePage.goto(`${origin}/app.html`);
  await stalePage
    .getByText(
      "The deployed API is older than this app. Apply migrations and deploy the API and Pages together before the demo.",
    )
    .waitFor();
  assert.equal(
    await stalePage
      .getByRole("button", { name: "Set up sample demo", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await stalePage
      .getByRole("button", { name: "Review draft", exact: true })
      .isDisabled(),
    true,
  );
  await staleContext.close();
  console.log(
    "Browser smoke passed: signup, sample setup/scenarios, feedback collection/export/access, stale-release guard, approved document, contradictory/supported/missing evidence, history, edit invalidation, text import, safe rendering, archival, mobile layout, shared workspace, two-person approval, human decision, export, audit, role downgrade, logout and login.",
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  f.sqlite.close();
}
