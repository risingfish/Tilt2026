# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Absolutely must follow rule
Under no circumstances should you guess and/or infer. If you do not know the answer, look up the library, framework, document, or anything else from the web and understand it. If you still cannot figure out a solution, always let me know, and I will help research.

Always uses the latest version of an api, app, or famework when generating code.

## Project context

Tilt is a legacy (circa 2011) Mozilla Firefox extension that renders a 3D WebGL visualization of a webpage's DOM. It predates WebExtensions — it is an XUL/XPI overlay extension (`chrome.manifest`, `install.rdf`, `browserOverlay.xul`) that was eventually superseded by a native implementation inside Firefox's Developer Tools Inspector. Assume targets are old Gecko (Firefox 4–11 era), ECMAScript 5 strict, and WebGL 1 / GLSL ES 1.0.

Upstream Firefox source (for the native devtools port that eventually replaced this extension): https://github.com/mozilla-firefox/firefox

Firefox add-on development guidelines (MDN): https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons

The repo ships two artifacts from one source tree:

1. **Engine** (`src/chrome/content/engine/`) — a standalone WebGL library (`Tilt.*` namespace) usable on its own via `bin/Tilt-engine.js`. Similar in spirit to processing.js but with DOM-visualization primitives.
2. **Extension** (`src/chrome/content/Tilt*.js`, `browserOverlay.*`) — the `TiltChrome.*` namespace that glues the engine to Firefox chrome, the inspector, and the Ace editor popup.

Everything under `src/chrome/content/libs/` (Ace, ColorJack) is third-party and excluded from the JS build.

## Build system

The build is unusual: `src/build` **concatenates every `.js` file** under the target directory into a single output, then optionally runs Google Closure Compiler. There is no module system or dependency graph — load order is whatever `find` produces, and all files share globals via a manually-maintained `Tilt` / `TiltChrome` namespace object pattern (`var Tilt = Tilt || {};` at the top of each file).

Run builds from `src/`:

```
./build engine                   # concat engine → bin/Tilt-engine.js
./build engine minify            # + Closure SIMPLE_OPTIMIZATIONS → Tilt-engine-min.js
./build extension                # concat extension → bin/Tilt-extension.js, then make XPI
./build extension minify         # + Closure SIMPLE
./build extension minify optimize  # Closure ADVANCED — needs bin/google-closure/tilt-externs.jsext
./build all minify               # both
./build all minify optimize install  # also copy into Firefox profile
```

The extension half shells out to `make` (see `src/Makefile` + `Makefile.in`) which zips JAR + manifest files into `bin/Tilt.xpi`. `make install` copies the unpacked build into a Firefox profile directory — **you must edit `profile_dir` in `src/Makefile`** to match your local profile before `install` will work. `OSTYPE` must be exported so the Makefile picks the right profile path (`darwin` / `linux-gnu` / else Windows `APPDATA`).

Closure ADVANCED requires `bin/google-closure/tilt-externs.jsext` so public API names survive renaming — add new public `Tilt.*` / `TiltChrome.*` entry points there if you expose them.

There is a Java dependency for Closure (`java -jar ../bin/google-closure/compiler.jar`). Plain `./build engine` (without `minify`) needs no Java.

## Runtime loading (extension)

Loading is two-stage and worth understanding before editing entry points:

- `src/chrome/content/Tilt-loader.js` is the **only** unconcatenated JS file kept in the XPI. It's loaded via the XUL overlay and uses `mozIJSSubScriptLoader` to pull in the build-time-generated `chrome://tilt/content/Tilt-extension.js` into a sandbox object, then promotes `Tilt` and `TiltChrome` onto `window`.
- `Tilt-extension.js` is therefore not checked in — it is produced by `./build extension` and deleted again after the XPI is zipped. Don't be surprised that it's missing from `src/chrome/content/` at rest.
- Preferences under `options.*` are created in `Tilt-loader.js:setupPreferences` and read through `Tilt.Preferences` / `TiltChrome.Config`.

## Architectural anchors

- **Visualization wiring** lives in `src/chrome/content/browserOverlay.js` — it constructs `new TiltChrome.Visualization(canvas, controller, ui)`. Swapping controller or UI is the intended extension point.
- **Controller interface** (`init`, `update`, `resize`, `destroy`, with access to `this.visualization.setTranslation / setRotation / performMeshPick`): reference implementation in `TiltChromeController.js` (mouse + keyboard + arcball).
- **UI interface** (`init`, `draw`, `resize`, `destroy`, plus optional `domVisualizationMeshNodeCallback`, `meshNodeCallback`, `meshReadyCallback`): reference implementation in `TiltChromeUI.js`.
- **Engine layout** under `src/chrome/content/engine/`:
  - `core/` — `Program`, `Buffer`, `Texture`, `Cache`, `Profiler` (GL object wrappers)
  - `renderer/` — `Renderer.js` plus `geometry/` and `objects/` primitives; `Shaders.js` is generic, visualization-specific shaders live in `TiltChromeVisualizationShaders.js` at the extension layer
  - `cameras/Arcball.js` — Shoemake-style virtual trackball
  - `ui/` — 2D overlay widgets (`containers/`, `elements/`)
  - `utils/` — `Document`, `WebGL`, `Math`, `Xhr`, `Console`, `Preferences`, `Components`, `File`, `Random`, `String`
  - `lib/` — third-party math (`gl-matrix`) / misc code pulled into the concat
- **DOM → 3D strategy**: the extension draws the page off-screen to a canvas (via the privileged `canvas.drawWindow`), walks the DOM for node rectangles, then builds a 3D stack where Z depth ≈ DOM nesting depth. Nodes render as extruded boxes; `performMeshPick` raycasts into that mesh. Double-click opens the Ace editor popup (`libs/ace`) showing the picked node's HTML.

## Engine-only usage

`bin/Tilt-engine.js` works standalone in a plain webpage without any Firefox bits:

```js
var canvas = Tilt.Document.initFullScreenCanvas();
var tilt = new Tilt.Renderer(canvas);
function draw() { tilt.loop(draw); tilt.clear(1,0,0,1); }
draw();
```

Nothing under `TiltChrome.*` will work outside the extension — it depends on `Cc`/`Ci`/`Cu`, `InspectorUI`, `gBrowser`, and other chrome-only globals.

## Tests

`src/testunits/` contains standalone HTML pages (`testInitTilt.html`, `testPrimitivesBox.html`, etc.) that load `bin/Tilt-engine.js` directly. Open them in a browser — there is no automated test runner.

## Utilities

`src/utils/Blimp/` and `src/utils/Img2Tilt/` are independent companion web apps (HTML/JS) that use the engine for their own visualizations; they don't participate in the extension build.

## Conventions worth preserving

- Every source file starts with `var Tilt = Tilt || {};` (or `TiltChrome`) and an `EXPORTED_SYMBOLS` array — required because files are concatenated in arbitrary order and the extension is loadable as a JSM.
- `"use strict";` at the top of every file; the build explicitly targets `ECMASCRIPT5_STRICT`.
- Avoid ES6+ syntax (let/const/arrow/classes/template strings) — Closure is pinned to ES5 and the Gecko target predates ES6.
- Keep public names in `bin/google-closure/tilt-externs.jsext` if you add API surface that must survive `ADVANCED_OPTIMIZATIONS`.
- Namespace discipline matters: the project's README history explicitly notes recent work "avoiding polluting the global namespace" — prefer attaching to `Tilt.*` / `TiltChrome.*` over top-level globals.
