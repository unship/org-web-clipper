// org-clipper popup controller.
// Renders current tab info, lets the user add tags + an optional
// selection-only flag, then asks the background service worker to perform
// the clip. Status is rendered back into the popup.

const $ = (id) => document.getElementById(id);

const els = {
  title:  $("page-title"),
  url:    $("page-url"),
  tags:   $("tags"),
  selOnly:$("selection-only"),
  clip:   $("clip-btn"),
  cancel: $("cancel-btn"),
  status: $("status"),
  opts:   $("open-options"),
  dispatcher: $("dispatcher"),
};

function setStatus(kind, text) {
  els.status.className = "status " + kind;
  els.status.textContent = text;
}

async function init() {
  // Defaults from storage
  const cfg = await chrome.storage.sync.get(["defaultTags"]);
  if (cfg.defaultTags) els.tags.value = cfg.defaultTags;

  // Show current tab title/url
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus("err", "No active tab found.");
    els.clip.disabled = true;
    return;
  }
  els.title.textContent = tab.title || "(untitled)";
  els.url.textContent   = tab.url   || "";
  els.clip.dataset.tabId = String(tab.id);
}

async function clip() {
  const tabId = Number(els.clip.dataset.tabId);
  if (!Number.isFinite(tabId)) {
    setStatus("err", "Lost reference to the active tab.");
    return;
  }
  els.clip.disabled = true;
  els.cancel.disabled = true;
  setStatus("info", "Extracting…");

  try {
    const tags = els.tags.value
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const resp = await chrome.runtime.sendMessage({
      type: "CLIP_TAB",
      tabId,
      tags,
      selectionOnly: els.selOnly.checked,
    });

    if (resp && resp.ok && resp.url) {
      // Dispatch from popup context via a hidden iframe: same origin across
      // every clip, so Chrome's "Always allow" sticks; no tab/window flash;
      // OS handler is triggered without disrupting any visible tab.
      els.dispatcher.src = resp.url;
      const size = resp.urlBytes ? `${resp.urlBytes.toLocaleString()} byte` : "";
      const title = resp.title ? ` "${resp.title.slice(0, 60)}${resp.title.length > 60 ? "…" : ""}"` : "";
      setStatus(
        "ok",
        `Dispatched ${size} URL to Emacs${title}.\n` +
        `If this is the first clip ever, Chrome will ask whether to open ` +
        `Emacs Client — tick "Always allow" and click Open. ` +
        `Verify the heading appeared in your Org file.`,
      );
      // Keep popup open briefly so the iframe load can fire the OS handler
      // before the popup closes (which would tear down the iframe).
      setTimeout(() => { /* let user see status; they can close manually */ }, 100);
    } else {
      setStatus("err", (resp && resp.error) || "Unknown error.");
    }
  } catch (e) {
    setStatus("err", String(e && e.message ? e.message : e));
  } finally {
    els.clip.disabled = false;
    els.cancel.disabled = false;
  }
}

els.clip.addEventListener("click", clip);
els.cancel.addEventListener("click", () => window.close());
els.opts.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init().catch((e) => setStatus("err", String(e)));
