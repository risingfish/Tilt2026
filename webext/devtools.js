"use strict";

browser.devtools.panels.create("Tilt", "", "panel.html").then((panel) => {
  panel.onShown.addListener((panelWindow) => {
    panelWindow.postMessage({
      type: "tilt:init",
      tabId: browser.devtools.inspectedWindow.tabId,
    }, "*");
  });
});
