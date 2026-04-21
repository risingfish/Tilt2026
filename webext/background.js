"use strict";

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "tilt:capture") return;
  return (async () => {
    try {
      const tab = await browser.tabs.get(message.tabId);
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { ok: true, dataUrl };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  })();
});
