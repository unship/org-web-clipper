// org-clipper options page controller — persists settings to
// chrome.storage.sync. The schema mirrors DEFAULTS in background.js.

const DEFAULTS = {
  defaultTags:     "",
  captureTemplate: "w",
  headingMin:      3,
  transport:       "org-protocol",
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
  v.headingMin = Number.isFinite(v.headingMin)
    ? Math.max(1, Math.min(8, v.headingMin))
    : DEFAULTS.headingMin;
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
