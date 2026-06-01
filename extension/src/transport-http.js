// HTTP transport: POST the capture payload to the local Emacs endpoint.
// No URL-length limit (super-long documents survive); UTF-8 is explicit via
// the Content-Type charset. Requires `host_permissions` for http://127.0.0.1/*.

export async function sendCapture(payload, cfg = {}) {
  const endpoint = (cfg.endpoint || "127.0.0.1:17654").replace(/^https?:\/\//, "");
  const url = `http://${endpoint}/capture`;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Org-Clipper-Token": cfg.token || "",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(
      `cannot reach Emacs at ${url} — is the daemon running and 'M-x org-clipper-start' done? (${e.message || e})`,
    );
  }
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error || ""; } catch {}
    throw new Error(`Emacs returned HTTP ${resp.status}${detail ? ": " + detail : ""}`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  return { ok: true, urlBytes: bytes };
}

// ---------------- self-tests (run: node src/transport-http.js) ----------------
const isMain =
  typeof process !== "undefined" && process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  (async () => {
    let ok = true;
    const check = (c, m) => { if (!c) { ok = false; console.error("FAIL:", m); } else console.log("PASS:", m); };
    const saved = globalThis.fetch;

    globalThis.fetch = async (u, opts) => {
      check(u === "http://127.0.0.1:17654/capture", "default endpoint URL");
      check(opts.headers["X-Org-Clipper-Token"] === "secret", "token header sent");
      check(JSON.parse(opts.body).url === "https://x", "payload serialized");
      return { ok: true, json: async () => ({}) };
    };
    const r = await sendCapture({ url: "https://x", body: "b" }, { token: "secret" });
    check(r.ok === true, "returns ok on 200");

    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: "bad token" }) });
    try { await sendCapture({ url: "u" }, {}); check(false, "403 throws"); }
    catch (e) { check(/HTTP 403/.test(e.message) && /bad token/.test(e.message), "403 -> error with detail"); }

    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    try { await sendCapture({ url: "u" }, {}); check(false, "refused throws"); }
    catch (e) { check(/cannot reach Emacs/.test(e.message), "connection refused -> friendly error"); }

    globalThis.fetch = saved;
    process.exitCode = ok ? 0 : 1;
  })();
}
