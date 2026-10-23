import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

if (process.env.NODE_ENV === "production") {
  throw new Error("This disposable design prototype must not run in production.");
}

const port = Number(process.env.DEVPOCKET_PROTOTYPE_PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("DEVPOCKET_PROTOTYPE_PORT must be an integer between 0 and 65535.");
}

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/base.css", ["base.css", "text/css; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

const server = createServer(async (request, response) => {
  const entry = files.get((request.url ?? "/").split("?")[0]);
  if (!entry || !["GET", "HEAD"].includes(request.method ?? "")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found. This server serves only the local design prototype.");
    return;
  }
  try {
    const body = await readFile(new URL(entry[0], import.meta.url));
    response.writeHead(200, {
      "Content-Type": entry[1],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    console.error("Unable to load prototype asset:", error);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Prototype asset could not be loaded. Check the server output.");
  }
});

server.on("error", (error) => {
  console.error("Prototype preview failed:", error);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`DevPocket Apple prototype: http://127.0.0.1:${address.port}/`);
  console.log("Local mock data only. Stop this process to close the preview.");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close());
}
