/** One bounded attempt. Never retry a mutation automatically or log request data. */
export class RequestError extends Error {
  constructor(
    message,
    {
      status = 0,
      code = "REQUEST_FAILED",
      requestId = null,
      retryAfter = null,
    } = {},
  ) {
    super(message);
    this.name = "RequestError";
    Object.assign(this, { status, code, requestId, retryAfter });
  }
}

function retrySeconds(response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - Date.now()) / 1000))
    : null;
}

function recovery(options) {
  if (!options.method || options.method === "GET")
    return "Try again when the connection recovers.";
  if (new Headers(options.headers).has("idempotency-key"))
    return "The request may have completed. Retry without changing the draft, question or policies to recover the saved result.";
  return "The request may have completed. Check the saved records before submitting again.";
}

async function parseJSON(response) {
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new RequestError(
      "The API did not return JSON. Check the Pages proxy and deploy the matching API and web app.",
      { status: response.status, code: "API_RESPONSE_INVALID" },
    );
  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new RequestError(
      "The API returned incomplete or invalid JSON. Refresh and check saved records before submitting again.",
      { status: response.status, code: "API_RESPONSE_INVALID" },
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new RequestError(
      "The API returned an invalid response. Deploy the matching API and web app.",
      { status: response.status, code: "API_RESPONSE_INVALID" },
    );
  return data;
}

async function failure(response, options) {
  let data;
  try {
    data = await parseJSON(response);
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new RequestError(`${error.message} ${recovery(options)}`, {
      status: response.status,
      code: error.code,
    });
  }
  const requestId =
    typeof data.requestId === "string"
      ? data.requestId
      : response.headers.get("x-request-id");
  const retryAfter = retrySeconds(response);
  let message =
    typeof data.error === "string"
      ? data.error
      : "Request could not be completed.";
  if (response.status === 429 && retryAfter !== null)
    message += ` Try again after ${new Date(Date.now() + retryAfter * 1000).toLocaleString()}.`;
  if (response.status >= 500 && requestId)
    message += ` Reference: ${requestId}`;
  throw new RequestError(message, {
    status: response.status,
    code: typeof data.code === "string" ? data.code : "REQUEST_FAILED",
    requestId,
    retryAfter,
  });
}

async function request(url, options, consume, fetcher) {
  const { timeoutMs = 30000, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      credentials: "include",
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) await failure(response, init);
    return await consume(response);
  } catch (error) {
    if (controller.signal.aborted)
      throw new RequestError(`The response timed out. ${recovery(init)}`, {
        code: "REQUEST_TIMEOUT",
      });
    if (error instanceof RequestError) throw error;
    throw new RequestError(
      `The connection was interrupted. ${recovery(init)}`,
      { code: "NETWORK_ERROR" },
    );
  } finally {
    clearTimeout(timer);
  }
}

export function requestJSON(url, options = {}, fetcher = fetch) {
  return request(url, options, parseJSON, fetcher);
}
export function requestBlob(url, options = {}, fetcher = fetch) {
  return request(url, options, (response) => response.blob(), fetcher);
}
