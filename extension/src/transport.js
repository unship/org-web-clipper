import { dispatchOrgProtocol } from "./transport-orgproto.js";
// HTTP transport arrives in Phase 2.
export async function dispatchCapture(payload, cfg = {}) {
  switch (cfg.transport || "org-protocol") {
    case "org-protocol": return dispatchOrgProtocol(payload);
    case "http": throw new Error("HTTP transport not implemented yet (Phase 2)");
    default: throw new Error(`unknown transport: ${cfg.transport}`);
  }
}

const isMain = typeof process !== "undefined" && process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let ok = true; const check = (c, m) => { if (!c) { ok = false; console.error("FAIL:", m); } else console.log("PASS:", m); };
  try { await dispatchCapture({ url: "u" }, { transport: "http" }); check(false, "http throws"); }
  catch (e) { check(/Phase 2/.test(e.message), "http throws Phase-2 error"); }
  try { await dispatchCapture({ url: "u" }, { transport: "nope" }); check(false, "unknown throws"); }
  catch (e) { check(/unknown transport/.test(e.message), "unknown transport throws"); }
  process.exitCode = ok ? 0 : 1;
}
