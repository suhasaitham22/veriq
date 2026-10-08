// Pages proxies /api/* to the Worker so sessions use first-party cookies.
// Set window.VERIQ_API before this script only when testing a separate API.
window.VERIQ_API ||= location.origin;
