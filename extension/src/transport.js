import { dispatchOrgProtocol } from "./transport-orgproto.js";
import { sendCapture as dispatchHttp } from "./transport-http.js";

export async function dispatchCapture(payload, cfg = {}) {
  switch (cfg.transport || "org-protocol") {
    case "org-protocol": return dispatchOrgProtocol(payload);
    case "http":         return dispatchHttp(payload, cfg);
    default: throw new Error(`unknown transport: ${cfg.transport}`);
  }
}

// ---------------- self-tests (run: node src/transport.js) ----------------
// NOTE: no top-level `await` — this module is imported by the MV3 background
// service worker, and a top-level-await module fails SW registration
// ("Status code: 3"). Keep awaits inside the async IIFE.
const isMain =
  typeof process !== "undefined" && process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  (async () => {
    let ok = true;
    const check = (c, m) => { if (!c) { ok = false; console.error("FAIL:", m); } else console.log("PASS:", m); };
    const saved = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    check((await dispatchCapture({ url: "u" }, { transport: "http", token: "t" })).ok,
          "http routes to the HTTP transport");
    globalThis.fetch = saved;
    try { await dispatchCapture({ url: "u" }, { transport: "nope" }); check(false, "unknown throws"); }
    catch (e) { check(/unknown transport/.test(e.message), "unknown transport throws"); }
    process.exitCode = ok ? 0 : 1;
  })();
}
