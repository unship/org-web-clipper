// org-clipper options page controller — persists settings to
// chrome.storage.sync. The schema mirrors DEFAULTS in background.js.

const DEFAULTS = {
  defaultTags:     "",
  captureTemplate: "w",
  transport:       "org-protocol",
  endpoint:        "127.0.0.1:17654",
  token:           "",
};

const FIELDS = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);

function setStatus(kind, text) {
  const el = $("status");
  el.className = "status " + kind;
  el.textContent = text;
}

function readForm() {
  const v = {};
  for (const k of FIELDS) {
    const el = $(k);
    if (!el) continue;
    v[k] = el.type === "number" ? Number(el.value) : el.value;
  }
  v.captureTemplate = (v.captureTemplate || "").trim() || DEFAULTS.captureTemplate;
  v.transport       = (v.transport       || "").trim() || DEFAULTS.transport;
  return v;
}

async function load() {
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  for (const k of FIELDS) {
    const el = $(k);
    if (el) el.value = cfg[k];
  }
}

async function save() {
  const cfg = readForm();
  await chrome.storage.sync.set(cfg);
  setStatus("ok", "Saved.");
}

$("save").addEventListener("click", save);

load().catch((e) => setStatus("err", String(e)));
