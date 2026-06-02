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
  reader: $("reader-btn"),
  cancel: $("cancel-btn"),
  status: $("status"),
  opts:   $("open-options"),
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

    if (resp && resp.ok) {
      // The background service worker already performed the dispatch (it opens
      // the org-protocol:// URL in a throwaway tab). The popup only renders
      // status. The first clip ever will prompt Chrome to confirm opening
      // Emacs Client — tick "Always allow".
      setStatus("ok", `Sent to Emacs (${resp.urlBytes ?? ""} bytes).`);
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

async function toggleReader() {
  const tabId = Number(els.clip.dataset.tabId);
  if (!Number.isFinite(tabId)) {
    setStatus("err", "Lost reference to the active tab.");
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: "TOGGLE_READER", tabId });
    window.close();
  } catch (e) {
    setStatus("err", String(e && e.message ? e.message : e));
  }
}

els.reader.addEventListener("click", toggleReader);
els.clip.addEventListener("click", clip);
els.cancel.addEventListener("click", () => window.close());
els.opts.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init().catch((e) => setStatus("err", String(e)));
