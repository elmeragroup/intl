// The bootstrap revision's server (Dockerfile beside it), run by Node as TypeScript: 404 for every request on PORT, and
// a clean exit on the SIGTERM Container Apps sends when it stops a replica. As PID 1 in the container, Node would
// otherwise ignore it.
import { createServer } from "node:http";

const server = createServer((_request, response) => {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
});

server.listen(Number(process.env.PORT ?? "3000"), "0.0.0.0");
process.once("SIGTERM", () => server.close());
