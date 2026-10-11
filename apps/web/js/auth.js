// auth.js — login, signup and offline recovery-code client.
import { requestJSON } from "../request.js";
const API = window.VERIQ_API;
const $ = (id) => document.getElementById(id);
const mode = new URLSearchParams(location.search).get("mode") || "login";
const recovery = mode === "recover";
let submitting = false;
if (mode !== "login") $("mfa-code-field").hidden = true;

if (mode === "signup") {
  $("title").textContent = "Create your account";
  $("subtitle").textContent =
    "Review customer replies in your personal or team workspace.";
  $("submit").textContent = "Create account";
  $("password").setAttribute("autocomplete", "new-password");
  $("password").minLength = 12;
  $("password").maxLength = 128;
  $("switch").innerHTML =
    'Already have an account? <a href="/login.html">Log in</a> · <a href="/login.html?mode=recover">Recover access</a>';
} else if (recovery) {
  $("title").textContent = "Recover access";
  $("subtitle").textContent =
    "Recovery resets your password, rotates the recovery code, disables MFA and ends existing sessions. Re-enroll MFA before team access.";
  $("submit").textContent = "Reset password";
  $("password-label").textContent = "New password";
  $("password").setAttribute("autocomplete", "new-password");
  $("password").minLength = 12;
  $("recovery-code-field").hidden = false;
  $("recovery-code").required = true;
  $("switch").innerHTML =
    'Remember your password? <a href="/login.html">Log in</a>';
}

async function api(path, body) {
  return requestJSON(`${API}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function ensureReady() {
  const health = await requestJSON(`${API}/api/health`);
  if (
    health.mode !== "support_review" ||
    health.v < 9 ||
    health.mfaAvailable !== true ||
    !health.features?.includes("totp_mfa")
  )
    throw new Error("This deployment is not ready for the current authentication release.");
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  submitting = true;
  const email = $("email").value.trim();
  const password = $("password").value;
  $("err").textContent = "";
  $("submit").disabled = true;
  try {
    const minimum = mode === "signup" || recovery ? 12 : 8;
    if (password.length < minimum)
      throw new Error(`Password must be at least ${minimum} characters.`);
    let result;
    await ensureReady();
    if (mode === "signup")
      result = await api("/api/auth/signup", { email, password });
    else if (recovery)
      result = await api("/api/auth/recover", {
        email,
        recoveryCode: $("recovery-code").value.trim(),
        password,
      });
    else
      result = await api("/api/auth/login", {
        email,
        password,
        ...($("mfa-code").value.trim()
          ? { code: $("mfa-code").value.trim() }
          : {}),
      });
    if (["signup", "recover"].includes(mode) && result.recoveryCode) {
      $("recovery-display").textContent = result.recoveryCode;
      if (recovery)
        $("signup-result").querySelector("h2").textContent =
          "Save your replacement recovery code";
      if (recovery)
        $("signup-result").querySelector("p").textContent =
          "Your old recovery code is invalid now. MFA is cleared if it was enabled. Store this replacement offline; it is shown once.";
      $("signup-result").hidden = false;
      $("signup-result").focus();
      $("form").hidden = true;
      $("password").value = "";
      $("recovery-code").value = "";
      $("submit").disabled = true;
      $("continue").onclick = () =>
        (location.href = recovery ? "/login.html" : "/app.html");
    } else if (recovery) {
      throw new Error("Recovery did not return a replacement code.");
    } else location.href = "/app.html";
  } catch (err) {
    $("err").textContent = err.message;
  } finally {
    $("submit").disabled = false;
  }
});

if (!recovery)
  requestJSON(`${API}/api/auth/me`)
    .then(() => {
      if (!submitting) location.href = "/app.html";
    })
    .catch(() => {});
