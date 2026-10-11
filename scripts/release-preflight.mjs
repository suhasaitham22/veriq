export function canonicalOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error(`${name} must be an HTTPS origin without credentials, path, query, or fragment.`);
  return url.origin;
}

export function validateProject(value) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(value))
    throw new Error("pages_project contains unsupported characters or length.");
  return value;
}

export function unappliedMigrations(localNames, remoteNames) {
  const applied = new Set(remoteNames);
  return localNames.filter((name) => !applied.has(name));
}

export function validatePagesMetadata(metadata, pagesOrigin, apiOrigin) {
  if (
    metadata?.success !== true ||
    !metadata.result ||
    typeof metadata.result !== "object"
  )
    throw new Error("Pages project metadata response was not successful.");
  const result = metadata.result;
  const configured = result?.deployment_configs?.production?.env_vars?.API_ORIGIN;
  const configuredOrigin = typeof configured === "object" ? configured.value : configured;
  if (configuredOrigin !== apiOrigin)
    throw new Error("Pages production API_ORIGIN does not match requested API origin.");
  if (result?.production_branch !== "main")
    throw new Error("Pages production branch is not main; refusing release.");
  const hosts = new Set(
    [result?.subdomain, ...(result?.domains || [])]
      .filter(Boolean)
      .map((value) => new URL(value.startsWith("http") ? value : `https://${value}`).hostname),
  );
  if (!hosts.has(new URL(pagesOrigin).hostname))
    throw new Error("Pages origin is not the verified project subdomain or domain.");
}

export function hasSecretMetadata(metadata, secretName) {
  return (
    metadata?.success === true &&
    Array.isArray(metadata.result) &&
    metadata.result.some(
      (entry) => entry && typeof entry === "object" && entry.name === secretName,
    )
  );
}

