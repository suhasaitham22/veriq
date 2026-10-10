import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalOrigin,
  hasSecretMetadata,
  unappliedMigrations,
  validatePagesMetadata,
  validateProject,
} from "../scripts/release-preflight.mjs";

test("release preflight accepts canonical origins and valid project names", () => {
  assert.equal(canonicalOrigin("https://example.pages.dev/", "pages"), "https://example.pages.dev");
  assert.equal(validateProject("veriq-prod"), "veriq-prod");
  for (const value of [
    "http://example.com",
    "https://user@example.com",
    "https://example.com/path",
    "https://example.com?a=1",
  ]) assert.throws(() => canonicalOrigin(value, "origin"));
  assert.throws(() => validateProject("bad/project"));
});

test("release preflight compares exact migration filenames", () => {
  assert.deepEqual(
    unappliedMigrations(["0001.sql", "0002.sql"], ["0001.sql"]),
    ["0002.sql"],
  );
  assert.deepEqual(
    unappliedMigrations(["0001.sql"], ["0001"]),
    ["0001.sql"],
  );
});

test("release preflight refuses wrong Pages binding, branch, and domain", () => {
  const good = {
    success: true,
    result: {
      production_branch: "main",
      subdomain: "veriq.pages.dev",
      domains: [],
      deployment_configs: {
        production: { env_vars: { API_ORIGIN: { value: "https://api.example" } } },
      },
    },
  };
  validatePagesMetadata(good, "https://veriq.pages.dev", "https://api.example");
  assert.throws(() =>
    validatePagesMetadata(
      { ...good, result: { ...good.result, production_branch: "release" } },
      "https://veriq.pages.dev",
      "https://api.example",
    ),
  );
  assert.throws(() =>
    validatePagesMetadata(
      { ...good, result: { ...good.result, subdomain: "other.pages.dev" } },
      "https://veriq.pages.dev",
      "https://api.example",
    ),
  );
  assert.throws(() =>
    validatePagesMetadata(
      {
        ...good,
        result: {
          ...good.result,
          deployment_configs: { production: { env_vars: { API_ORIGIN: { value: "https://wrong.example" } } } },
        },
      },
      "https://veriq.pages.dev",
      "https://api.example",
    ),
  );
});

test("release preflight requires successful exact secret metadata", () => {
  assert.equal(
    hasSecretMetadata(
      { success: true, result: [{ name: "MFA_ENCRYPTION_KEY", type: "secret_text" }] },
      "MFA_ENCRYPTION_KEY",
    ),
    true,
  );
  assert.equal(
    hasSecretMetadata({ success: false, result: [{ name: "MFA_ENCRYPTION_KEY" }] }, "MFA_ENCRYPTION_KEY"),
    false,
  );
  assert.equal(
    hasSecretMetadata({ success: true, result: [{ name: "OTHER_SECRET" }] }, "MFA_ENCRYPTION_KEY"),
    false,
  );
  assert.equal(hasSecretMetadata({ success: true, result: "not-an-array" }, "MFA_ENCRYPTION_KEY"), false);
});
