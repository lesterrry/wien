import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Plugin, ProxyOptions } from "vite";

const paths = ["/auth", "/users", "/v1", "/health", "/ready"];

export function sameOriginRequest(headers: IncomingHttpHeaders): boolean {
  const host = headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host))
    return false;
  const site = headers["sec-fetch-site"];
  return (
    (!headers.origin || headers.origin === `http://${host}`) &&
    (!site || site === "same-origin")
  );
}

export function sessionCookies(backend: { url: string; local: boolean }) {
  // A different backend gets a separate local session, including localhost.
  const suffix = createHash("sha256")
    .update(backend.url)
    .digest("hex")
    .slice(0, 16);
  const browserName = `wien_dev_session_${suffix}`;
  const upstreamName = backend.local ? "wien_session" : "__Host-wien_session";
  return {
    request(cookie: string = ""): string {
      return cookie
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${browserName}=`))
        .map((part) => upstreamName + part.slice(browserName.length))
        .join("; ");
    },
    response(cookies: string[]): string[] {
      return cookies
        .filter((cookie) => cookie.startsWith(`${upstreamName}=`))
        .map((cookie) =>
          (browserName + cookie.slice(upstreamName.length))
            .replace(/;\s*Secure\b/gi, "")
            .replace(/;\s*Domain=[^;]*/gi, ""),
        );
    },
  };
}

export function webApiProxy(backend: { url: string; local: boolean }): Plugin {
  const cookies = sessionCookies(backend);
  const options: ProxyOptions = {
    target: backend.url,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (outgoing, incoming) => {
        // The middleware below checks the browser origin before rewriting it.
        if (incoming.headers.origin) outgoing.setHeader("Origin", backend.url);
        const cookie = cookies.request(incoming.headers.cookie);
        outgoing.removeHeader("cookie");
        if (cookie) outgoing.setHeader("Cookie", cookie);
      });
      proxy.on("proxyRes", (response) => {
        const setCookie = response.headers["set-cookie"];
        if (setCookie)
          response.headers["set-cookie"] = cookies.response(setCookie);
      });
    },
  };
  return {
    name: "wien-dev-api",
    apply: "serve",
    config: () => ({
      server: {
        proxy: Object.fromEntries(paths.map((path) => [path, options])),
      },
    }),
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (
          paths.some((path) => request.url?.startsWith(path)) &&
          !sameOriginRequest(request.headers)
        ) {
          response.writeHead(403, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ code: "invalid_session_origin" }));
          return;
        }
        next();
      });
      server.config.logger.info(`Wien API → ${backend.url}`);
    },
  };
}
