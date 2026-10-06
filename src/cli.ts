#!/usr/bin/env node
/**
 * cli.ts - the executable entry point behind the `agent-trace` bin.
 *
 * It is a separate file so that proxy.ts stays importable: the tests pull
 * pure functions like upstreamConnection out of it, and importing a module
 * must never start the interactive wizard or bind a port.
 */

import { main } from "./proxy.js";

main().catch((err) => {
  console.error(`[agent-trace] ${(err as Error).message}`);
  process.exit(1);
});
