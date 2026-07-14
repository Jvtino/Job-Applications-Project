// src/cli/dashboard-api.ts
//
// `npm run dashboard:api` — starts the local API the Sunrise dashboard reads from.
// Pair with `cd dashboard && npm run dev` (Vite proxies /api -> 127.0.0.1:5179).

import { startApiServer } from "../server/api";

const port = Number(process.env.APPLYPILOT_API_PORT) || 5179;
startApiServer(port);
