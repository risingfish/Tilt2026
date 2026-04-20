# Plan: Port Tilt to a modern Firefox DevTools panel (initial step)

## Context

Tilt is a 2011-era Firefox extension that renders a 3D WebGL visualization of a webpage's DOM. It is built as a XUL overlay (`chrome.manifest`, `install.rdf`, `browserOverlay.xul`) that was killed by Firefox 57 (Quantum, 2017) when XUL/XPCOM extensions were replaced with WebExtensions. The extension is currently unloadable in any modern Firefox.

The WebGL engine under `src/chrome/content/engine/` is fully portable — it's standard WebGL + gl-matrix. The extension layer (`TiltChrome*`, `browserOverlay.*`, `Tilt-loader.js`) depends on removed APIs: `canvas.drawWindow`, `Cc`/`Ci`/`Services.*`, `InspectorUI`, `gBrowser`, XUL `<panel>`, `mozIJSSubScriptLoader`, `nsIFilePicker`, `nsIPromptService`, preferences service.

**Goal of this step**: Ship a minimal working WebExtension DevTools panel that renders the 3D DOM stack of the inspected tab, with viewport-only page texture and mouse/keyboard arcball controls. Defer: Ace editor popup, color picker, file export, preferences UI, accelerometer/joystick input.

**Key user decisions**:
- Capture strategy: `browser.tabs.captureTab()` for viewport-only. Revisit scroll-stitch later.
- Ace editor popup: deferred.

## Recommended approach

Create a new WebExtension (MV3) inside this repo at `webext/` that reuses the existing engine sources. Do not touch `src/` — leave the legacy XUL tree intact as reference. The new extension has four runtime parts: a trivial devtools bootstrap page, a panel HTML document that owns the canvas and runs the renderer, a content script injected into the inspected tab that walks the DOM and returns geometry, and a background service worker that brokers `browser.tabs.captureTab()` (which is not callable from the devtools context directly).

### New extension layout

```
webext/
  manifest.json
  devtools.html           # calls browser.devtools.panels.create
  devtools.js
  panel.html              # hosts <canvas>, loads engine + panel.js
  panel.js                # visualization controller (replaces TiltChromeVisualization.js)
  content-script.js       # DOM walker, picking HTML lookup
  background.js           # captureTab broker (runs in privileged extension context)
  engine/                 # copy of src/chrome/content/engine/ with privileged bits removed
    ... (unchanged files) ...
    utils/
      WebGL.js            # stripped: remove initDocumentImage / refreshDocumentImage drawWindow paths
      Document.js         # stripped: traverse/getNodeCoordinates now runs in content script
      File.js             # DELETED in v1 (export deferred)
      Preferences.js      # DELETED in v1 (prefs UI deferred)
      Console.js          # replaced with thin wrapper over window.console + alert/confirm
      Components.js       # DELETED (XPCOM shim, not needed)
```

### Component responsibilities

**manifest.json** (MV3)
- `devtools_page: "devtools.html"`
- `background: { service_worker: "background.js" }` — needed because `tabs.captureTab` is not exposed to devtools pages directly; panel asks background to do it
- `permissions: ["activeTab", "scripting"]`; no host permissions at install time beyond activeTab — the panel explicitly requests the inspected tab
- `content_scripts`: none declared; inject on demand via `browser.scripting.executeScript`

**devtools.html / devtools.js** (~15 lines)
- Call `browser.devtools.panels.create("Tilt", "icons/tilt.png", "panel.html")` and forward `browser.devtools.inspectedWindow.tabId` into the panel when it loads (via `panel.onShown` → `postMessage`).

**panel.html / panel.js**
- Replaces `browserOverlay.js` + `TiltChromeVisualization.js` glue.
- Owns a full-panel `<canvas>` and a tiny DOM overlay for UI status.
- On panel-shown:
  1. Ask background for a captured image of the inspected tab (`runtime.sendMessage({type: "capture", tabId})`). Background calls `browser.tabs.captureVisibleTab` / `browser.tabs.captureTab` and returns a data URL.
  2. Inject `content-script.js` via `browser.scripting.executeScript` on the inspected tab, call its `traverse()` export, receive a serialized array of `{uid, depth, x, y, width, height, tagName, id, className}` entries.
  3. Construct `Tilt.Renderer(canvas)`, build the mesh from the serialized node list (same vertex/index math that lives today in `TiltChromeVisualization.js:444-497`), and load the captured image as a `Tilt.Texture`.
  4. Install `Tilt.Controller.MouseAndKeyboard` (ported from `TiltChromeController.js`) on the canvas.
- On mesh pick (double click): send `{type: "getNodeHTML", uid}` to content script; for v1 just `console.log` the outerHTML (Ace popup deferred).
- Handle panel resize and visibility (`browser.devtools.panels.*` events).

**content-script.js**
- Stateless on load; exports two message handlers:
  - `traverse`: walks `document` using the logic in `engine/utils/Document.js` (traverse + getNodeCoordinates — these already use only standard DOM APIs: `getBoundingClientRect`, `pageXOffset`, `contentDocument` for iframes). Assigns each node a UID, stores a UID→Node map in a module-scoped WeakMap for later lookup, returns the serialized list.
  - `getNodeHTML`: look up UID in the map, return `node.outerHTML`.
- Handles cross-origin iframes by catching the existing try/catch in `Document.js:205-216` — they silently become opaque boxes in the visualization.

**background.js**
- Single message handler: `type: "capture"` → `browser.tabs.captureTab(tabId, {format: "png"})` → return data URL. No other logic.

### Engine modifications

The goal is to keep engine diffs small so future pulls from the legacy tree are easy. Only touch what's broken:

- `engine/utils/WebGL.js` — Delete `initDocumentImage` (lines ~53–101) and `refreshDocumentImage` (lines ~107–150). The panel loads the captured PNG directly via `Tilt.TextureUtils`/`new Image()`. Keep the rest of `WebGL.js` (shader helpers, error translation) intact.
- `engine/utils/Document.js` — `traverse` and `getNodeCoordinates` are already portable. Remove the `window.content.*` references (chrome-only) and replace with `document.defaultView` / `window`. The `contentWindow` iframe descent works unchanged.
- `engine/utils/Console.js` — Replace the XPCOM paths (Console.js:61-91 prompt service, 113-169 console service) with `window.alert`, `window.confirm`, `console.log/warn/error`. Preserve the public API (`Tilt.Console.log`, `.alert`, `.error`, etc.) so the rest of the engine's call sites don't change.
- `engine/utils/File.js`, `engine/utils/Preferences.js`, `engine/utils/Components.js` — Delete for v1. If any other engine file imports them, stub with empty objects.
- Everything else under `engine/` (`core/`, `renderer/`, `cameras/Arcball.js`, `ui/`, `lib/`) copies verbatim.

### Module loading

The legacy build concatenates every `.js` file into one blob and expects `var Tilt = Tilt || {};` at the top of each file to work. Keep that exact pattern for the initial port — do **not** rewrite engine files to ES modules. Simplest loader: `panel.html` includes each engine file with individual `<script>` tags in dependency order, mirroring the concat order. This keeps the engine diff at a minimum. A future step can convert to ES modules.

### Picking and interaction

- Port `TiltChromeController.js` to `webext/controller.js` mostly verbatim. It's already just DOM mouse/key events + arcball math. Strip the `window.content` references; `panel.js` supplies the canvas directly.
- Port a trimmed `TiltChromeUI.js` to `webext/ui.js` — drop menu buttons that depended on legacy dialogs (export, options, about), keep the arcball indicator and basic status text.

### Critical files to modify

| Path | Action |
|------|--------|
| `webext/manifest.json` | create |
| `webext/devtools.html`, `webext/devtools.js` | create |
| `webext/panel.html`, `webext/panel.js` | create (replaces `browserOverlay.js` + `TiltChromeVisualization.js` setup/draw wiring) |
| `webext/content-script.js` | create (uses logic from `src/chrome/content/engine/utils/Document.js` traverse/getNodeCoordinates) |
| `webext/background.js` | create (captureTab broker) |
| `webext/controller.js` | port `src/chrome/content/TiltChromeController.js` (drop chrome globals) |
| `webext/ui.js` | port trimmed `src/chrome/content/TiltChromeUI.js` |
| `webext/engine/` | copy `src/chrome/content/engine/` verbatim, then apply the surgical edits listed above to `utils/WebGL.js`, `utils/Document.js`, `utils/Console.js`; delete `utils/File.js`, `utils/Preferences.js`, `utils/Components.js` |
| `CLAUDE.md` | add a short section pointing future Claude at the new `webext/` tree and the build model difference |

### Files to reuse as-is (or near-as-is)

- `src/chrome/content/engine/core/*.js` — all 8 files (Buffer, Cache, Object, Profiler, Program, ProgramUtils, Texture, TextureUtils)
- `src/chrome/content/engine/renderer/*` — Renderer.js, RequestAnimFrame.js, Shaders.js, plus `geometry/` and `objects/` subtrees
- `src/chrome/content/engine/cameras/Arcball.js`
- `src/chrome/content/engine/ui/**` — 2D overlay widgets
- `src/chrome/content/engine/lib/math/**` — gl-matrix
- `src/chrome/content/engine/utils/Math.js`, `Random.js`, `String.js`, `Xhr.js`
- `src/chrome/content/TiltChromeVisualizationShaders.js` — visualization-specific shaders; copy as-is

The mesh-building logic inside `TiltChromeVisualization.js:setupVisualization` (roughly lines 380–500) is the one piece of the extension layer that's worth preserving and porting carefully — the vertex/index/uv construction is nontrivial and depends on the traversal callback shape from `Document.js`. Keep the traversal callback contract identical across the content-script / panel boundary so this code ports with zero logic changes, only replacing the direct `Tilt.Document.traverse` call with an `await` on the content-script response.

## Out of scope for v1 (explicit deferrals)

- Ace editor popup on node pick (user deferred). Stub: log `outerHTML` to console.
- ColorJack color picker overlay (UI option, rarely needed).
- Export-to-image / export-to-OBJ (`engine/utils/File.js`).
- Preferences UI / `TiltChromeOptions.*`. Use hard-coded defaults.
- MozAfterPaint incremental texture updates — on mutation, the user can reopen the panel.
- Native accelerometer and joystick input.
- Full-page capture (scroll-stitch) — revisit once v1 is shipped.
- Chrome/Edge compatibility — Firefox-only for now (MV3 devtools panels work cross-browser, but `browser.*` → `chrome.*` shim and capture-API differences are a separate step).

## Verification

End-to-end smoke test:
1. `web-ext run --source-dir webext/` (add `web-ext` as a dev dependency or install globally) — launches Firefox with the extension loaded.
2. Open any content-rich page (e.g., the project's own `README.md` rendered on GitHub, or https://en.wikipedia.org/wiki/DOM).
3. Open DevTools → "Tilt" panel. Expect: within ~1s the canvas shows the familiar 3D stack of boxes textured with the current viewport.
4. Click and drag: arcball rotation. Arrow keys: translation. `wasd`: rotation. Matches the legacy control scheme.
5. Double-click a node: check DevTools console — panel logs the `outerHTML` of the picked node.
6. Resize the devtools pane: canvas resizes without visual artifacts.
7. Navigate the inspected tab to a different URL with the panel open: visualization should reset and re-render for the new page (hook `browser.devtools.network.onNavigated` or re-run setup on panel re-show).

Regression check against legacy: load `src/testunits/testInitTilt.html` directly in a browser (it uses `bin/Tilt-engine.js` standalone) — should still work, confirming we didn't break the standalone engine build.

No automated tests exist in this repo. If time allows, add one headless smoke test using Playwright that loads the extension via `web-ext` and asserts the canvas renders non-blank pixels, but this is a stretch goal, not required for acceptance.
