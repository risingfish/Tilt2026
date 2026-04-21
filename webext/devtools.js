"use strict";

// Chromium uses chrome.*; Firefox supports both chrome.* and browser.* (promise-based).
// This lets the same source work in either browser.
if (typeof globalThis.browser === "undefined") globalThis.browser = globalThis.chrome;

browser.devtools.panels.create("Tilt", "", "panel.html").then((panel) => {
  panel.onShown.addListener((panelWindow) => {
    panelWindow.postMessage({
      type: "tilt:init",
      tabId: browser.devtools.inspectedWindow.tabId,
    }, "*");
  });
});
