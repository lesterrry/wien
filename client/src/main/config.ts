import config from "../../config.json";

export function backendConfig(env: NodeJS.ProcessEnv = process.env) {
  const address = env.WIEN_BACKEND_URL ?? config.backendUrl;
  const invalid = () =>
    new Error(
      "Invalid backend URL. Set backendUrl in client/config.json or WIEN_BACKEND_URL to an HTTPS origin (HTTP is allowed for localhost), without a path, credentials, query or fragment.",
    );
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw invalid();
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw invalid();
  // Preserve the local-port override without replacing a configured remote backend.
  if (
    local &&
    env.WIEN_BACKEND_URL === undefined &&
    env.WIEN_SERVER_PORT !== undefined
  ) {
    const port = env.WIEN_SERVER_PORT;
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error("Invalid WIEN_SERVER_PORT.");
    url.port = port;
  }
  return { url: url.origin, local };
}
