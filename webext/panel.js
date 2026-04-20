"use strict";

const tiltState = {
  tabId: null,
  canvas: null,
  status: null,
  renderer: null,
  arcball: null,
  dom: null,
  t: 0,
};

const STACK_STEP = 10;
const DEPTH_PALETTE = [
  "#4a6fa5", "#5b8ac0", "#6fa8dc", "#93c47d",
  "#e0a96d", "#e06666", "#c27ba0", "#8e7cc3",
];

const setStatus = (text) => {
  if (tiltState.status) {
    tiltState.status.textContent = `Tilt: ${text}`;
  }
  console.log("[tilt]", text);
};

const resizeCanvas = () => {
  const c = tiltState.canvas;
  if (!c) return;
  const w = c.clientWidth | 0;
  const h = c.clientHeight | 0;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
    tiltState.arcball?.resize(w, h);
  }
};

// DOM buttons (0=L,1=M,2=R) → Arcball buttons (1=L,3=R).
const mapButton = (btn) => (btn === 0 ? 1 : btn === 2 ? 3 : -1);

const attachArcballInput = () => {
  const canvas = tiltState.canvas;
  const arcball = tiltState.arcball;

  const localCoords = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  };

  canvas.addEventListener("mousedown", (ev) => {
    canvas.focus?.();
    const [x, y] = localCoords(ev);
    arcball.mouseDown(x, y, mapButton(ev.button));
  });
  window.addEventListener("mouseup", (ev) => {
    const [x, y] = localCoords(ev);
    arcball.mouseUp(x, y, mapButton(ev.button));
  });
  window.addEventListener("mousemove", (ev) => {
    const [x, y] = localCoords(ev);
    arcball.mouseMove(x, y);
  });
  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    arcball.zoom(-ev.deltaY);
  }, { passive: false });
};

const drawMesh = () => {
  const { dom, renderer: r, arcball } = tiltState;
  const { pageWidth: pageW, pageHeight: pageH, nodes } = dom;
  const canvasW = r.width;
  const canvasH = r.height;
  const fit = Math.min(canvasW / pageW, canvasH / pageH) * 0.75;

  const { rotation, translation } = arcball.loop();
  const rotMatrix = quat4.toMat4(rotation);

  r.perspective();
  r.translate(canvasW / 2, canvasH / 2, 0);
  r.translate(translation[0], translation[1], translation[2]);
  r.rotate(-0.3, 1, 0, 0); // baseline forward tilt so stacking reads on first frame
  r.transform(rotMatrix);
  r.scale(fit, fit, fit);
  r.translate(-pageW / 2, -pageH / 2, 0);

  for (const n of nodes) {
    const color = DEPTH_PALETTE[n.depth % DEPTH_PALETTE.length];
    r.pushMatrix();
    r.translate(n.x + n.w / 2, n.y + n.h / 2, n.depth * STACK_STEP);
    r.fill(`${color}59`);
    r.stroke(`${color}cc`);
    r.box(n.w, n.h, STACK_STEP * 0.9);
    r.popMatrix();
  }
};

const startRenderer = () => {
  if (typeof Tilt === "undefined" || !Tilt.Renderer) {
    setStatus("engine did not load (Tilt.Renderer missing)");
    return;
  }
  try {
    tiltState.renderer = new Tilt.Renderer(tiltState.canvas);
    tiltState.arcball = new Tilt.Arcball(tiltState.canvas.width, tiltState.canvas.height);
  } catch (e) {
    setStatus(`renderer init failed: ${e?.message ?? e}`);
    return;
  }
  attachArcballInput();
  setStatus("renderer up, drawing clear loop");

  const draw = () => {
    resizeCanvas();
    tiltState.t += 0.016;
    tiltState.renderer.clear(0.08, 0.08, 0.10, 1);
    if (tiltState.dom) {
      drawMesh();
    }
    tiltState.renderer.loop(draw);
  };
  draw();
};

// Runs inside the inspected page. Must be self-contained (serialized via .toString).
function __tiltCollectDom() {
  const out = [];
  const scrollX = window.scrollX || 0;
  const scrollY = window.scrollY || 0;
  const pageWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0,
  );
  const pageHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
  );

  const walk = (el, depth) => {
    const { left, top, width, height } = el.getBoundingClientRect();
    if (width > 0 && height > 0) {
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === "string" ? (el.className || null) : null,
        depth,
        x: left + scrollX,
        y: top + scrollY,
        w: width,
        h: height,
      });
    }
    for (const child of el.children) {
      walk(child, depth + 1);
    }
  };

  if (document.body) {
    walk(document.documentElement, 0);
  }
  return { pageWidth, pageHeight, nodes: out };
}

const collectDom = async () => {
  if (!browser.devtools?.inspectedWindow) {
    setStatus("no devtools.inspectedWindow; cannot walk DOM");
    return;
  }
  const expr = `(${__tiltCollectDom.toString()})()`;
  try {
    const [value, exceptionInfo] = await browser.devtools.inspectedWindow.eval(expr);
    if (exceptionInfo) {
      setStatus(`DOM walk failed: ${exceptionInfo.value ?? exceptionInfo.description ?? "unknown"}`);
      console.error("[tilt] eval exception", exceptionInfo);
      return;
    }
    tiltState.dom = value;
    setStatus(
      `walked DOM: ${value.nodes.length} nodes, ` +
      `page ${Math.round(value.pageWidth)}x${Math.round(value.pageHeight)}`,
    );
    console.log("[tilt] first 5 nodes:", value.nodes.slice(0, 5));
    console.log("[tilt] full result stored at tiltState.dom");
  } catch (err) {
    setStatus(`eval rejected: ${err?.message ?? err}`);
  }
};

window.addEventListener("DOMContentLoaded", () => {
  tiltState.canvas = document.getElementById("tilt-canvas");
  tiltState.status = document.getElementById("tilt-status");
  resizeCanvas();
  setStatus("panel loaded, starting renderer");
  startRenderer();
});

window.addEventListener("resize", resizeCanvas);

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "tilt:init") return;
  if (tiltState.tabId === msg.tabId) return;
  tiltState.tabId = msg.tabId;
  setStatus(`attached to tab ${msg.tabId}, walking DOM...`);
  collectDom();
});
