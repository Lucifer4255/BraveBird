import { createServer } from "node:http";
import { serve } from "inngest/node";
import { config } from "../config.js";
import { functions, inngest } from "./inngest.js";

/**
 * The scale worker process: serves the Inngest functions over HTTP. The Inngest
 * Dev Server (or Inngest Cloud) discovers this endpoint and drives the functions.
 *
 *   npm run worker                     # start this server
 *   npx inngest-cli@latest dev \       # in another terminal: the dev server
 *     -u http://localhost:3939/api/inngest
 *
 * Then send jobs:  npm run enqueue
 */
const port = config.server.port;

createServer(serve({ client: inngest, functions, servePath: "/api/inngest" })).listen(port, () => {
  console.log(`Inngest worker serving ${functions.length} function(s) on http://localhost:${port}/api/inngest`);
  console.log(`Dev server:  npx inngest-cli@latest dev -u http://localhost:${port}/api/inngest`);
});
