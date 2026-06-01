// Build + dispatch an `org-protocol://org-clipper?…` URL from a capture payload.
export function buildOrgProtocolUrl(payload = {}) {
  if (!payload.url) throw new Error("buildOrgProtocolUrl: 'url' is required");
  const enc = encodeURIComponent;
  const pairs = [
    ["template", payload.template || "w"],
    ["url", payload.url],
    ["title", (payload.title || "(untitled)").replace(/\s+/g, " ").trim()],
  ];
  if (payload.body)        pairs.push(["body", payload.body]);
  if (payload.tags?.length) pairs.push(["tags", payload.tags.join(",")]);
  for (const k of ["author", "published", "description", "created"]) {
    if (payload[k]) pairs.push([k, String(payload[k])]);
  }
  const qs = pairs.map(([k, v]) => `${k}=${enc(v)}`).join("&");
  return `org-protocol://org-clipper?${qs}`;
}

const isMain = typeof process !== "undefined" && process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const dec = (u, k) => decodeURIComponent(u.match(new RegExp(`[?&]${k}=([^&]*)`))[1]);
  const u = buildOrgProtocolUrl({
    url: "https://x/测试", title: "标题 ☕", body: "*** s\n你好",
    tags: ["clippings", "rust"], author: "David Rosa", description: "Desc.",
  });
  let ok = true;
  const check = (c, m) => { if (!c) { ok = false; console.error("FAIL:", m); } else console.log("PASS:", m); };
  check(u.startsWith("org-protocol://org-clipper?template=w&"), "scheme + default template");
  check(dec(u, "url") === "https://x/测试", "url round-trips UTF-8");
  check(dec(u, "title") === "标题 ☕", "title round-trips");
  check(dec(u, "tags") === "clippings,rust", "tags csv");
  check(dec(u, "author") === "David Rosa", "author param");
  check(dec(u, "body") === "*** s\n你好", "body round-trips");
  try { buildOrgProtocolUrl({}); check(false, "missing url throws"); }
  catch { check(true, "missing url throws"); }
  process.exitCode = ok ? 0 : 1;
}

// Dispatch in the background service worker: open the URL in a throwaway tab
// (the OS routes it to the handler before the stub tab finishes loading).
export async function dispatchOrgProtocol(payload) {
  const url = buildOrgProtocolUrl(payload);
  const tab = await chrome.tabs.create({ url, active: false });
  await new Promise((r) => setTimeout(r, 1000));
  try { await chrome.tabs.remove(tab.id); } catch {}
  return { ok: true, urlBytes: url.length };
}
