// auth.js — login/signup client. Talks to the Worker API with cookies.
const API = window.VERIQ_API;

const $ = (id) => document.getElementById(id);
const mode =
  new URLSearchParams(location.search).get("mode") === "signup"
    ? "signup"
    : "login";

if (mode === "signup") {
  $("title").textContent = "Create your account";
  $("subtitle").textContent =
    "Review customer replies in your personal or team workspace.";
  $("submit").textContent = "Create account";
  $("password").setAttribute("autocomplete", "new-password");
  $("password").minLength = 12;
  $("password").maxLength = 128;
  $("switch").innerHTML =
    'Already have an account? <a href="/login.html">Log in</a>';
}

async function api(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "request failed");
  return data;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  $("err").textContent = "";
  $("submit").disabled = true;
  try {
    const minimum = mode === "signup" ? 12 : 8;
    if (password.length < minimum)
      throw new Error(`Password must be at least ${minimum} characters.`);
    await api(mode === "signup" ? "/api/auth/signup" : "/api/auth/login", {
      email,
      password,
    });
    location.href = "/app.html";
  } catch (err) {
    $("err").textContent = err.message;
  } finally {
    $("submit").disabled = false;
  }
});

fetch(`${API}/api/auth/me`, { credentials: "include" })
  .then((r) => {
    if (r.ok) location.href = "/app.html";
  })
  .catch(() => {});
