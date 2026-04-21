"use strict";

const tiltState = {
  tabId: null,
  canvas: null,
  status: null,
  renderer: null,
  arcball: null,
  dom: null,
  t: 0,
  sceneMatrix: null,
  hoveredIndex: null,
  sourceView: null,
  sourceTitle: null,
  sourceBody: null,
  refreshBtn: null,
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

  // Hover picking: only when no mouse buttons are held (don't pick while dragging).
  canvas.addEventListener("mousemove", (ev) => {
    if (ev.buttons !== 0) return;
    const [x, y] = localCoords(ev);
    updateHover(x, y);
  });
  canvas.addEventListener("mouseleave", () => {
    if (tiltState.hoveredIndex !== null) {
      tiltState.hoveredIndex = null;
      if (tiltState.dom) setStatus(`${tiltState.dom.nodes.length} nodes loaded`);
    }
  });

  canvas.addEventListener("dblclick", () => {
    const idx = tiltState.hoveredIndex;
    if (idx === null || !tiltState.dom) return;
    inspectNode(tiltState.dom.nodes[idx]);
  });
};

const showSource = (title, body) => {
  tiltState.sourceTitle.textContent = title;
  tiltState.sourceBody.textContent = body;
  tiltState.sourceBody.scrollTop = 0;
  tiltState.sourceView.hidden = false;
};

const hideSource = () => {
  tiltState.sourceView.hidden = true;
};

const inspectNode = async (node) => {
  const label = formatNodeLabel(node);
  if (!browser.devtools?.inspectedWindow) {
    showSource(label, "(no devtools.inspectedWindow available)");
    return;
  }
  const fetchFn = (path) => {
    let el = document.documentElement;
    for (const i of path) {
      if (!el || !el.children[i]) return null;
      el = el.children[i];
    }
    return el ? el.outerHTML : null;
  };
  const expr = `(${fetchFn.toString()})(${JSON.stringify(node.path)})`;
  showSource(label, "loading...");
  try {
    const [html, exceptionInfo] = await browser.devtools.inspectedWindow.eval(expr);
    if (exceptionInfo) {
      showSource(label, `error: ${exceptionInfo.value ?? exceptionInfo.description ?? "unknown"}`);
      return;
    }
    showSource(label, html ?? "(node not found — DOM may have changed since last walk)");
  } catch (err) {
    showSource(label, `eval rejected: ${err?.message ?? err}`);
  }
};

const drawMesh = () => {
  const { dom, renderer: r, arcball, hoveredIndex } = tiltState;
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

  // Snapshot the scene matrix (proj * mv) *before* any per-node pushMatrix
  // so picking can project page-space points to screen-space.
  tiltState.sceneMatrix = mat4.multiply(r.projMatrix, r.mvMatrix, mat4.create());

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const color = DEPTH_PALETTE[n.depth % DEPTH_PALETTE.length];
    const isHovered = i === hoveredIndex;
    r.pushMatrix();
    r.translate(n.x + n.w / 2, n.y + n.h / 2, n.depth * STACK_STEP);
    r.fill(isHovered ? `${color}a6` : `${color}59`);
    r.stroke(isHovered ? "#ffffffff" : `${color}cc`);
    r.box(n.w, n.h, STACK_STEP * 0.9);
    r.popMatrix();
  }
};

const projectToScreen = (x, y, z, mat, canvasW, canvasH) => {
  const out = [0, 0, 0, 0];
  mat4.multiplyVec4(mat, [x, y, z, 1], out);
  if (out[3] === 0) return null;
  const invW = 1 / out[3];
  return [
    (out[0] * invW + 1) * 0.5 * canvasW,
    (1 - out[1] * invW) * 0.5 * canvasH,
  ];
};

// Point-in-convex-quad via consistent cross-product sign.
// Quad vertices are assumed in order (either CW or CCW).
const pointInQuad = (px, py, q) => {
  const cross = (a, b) => (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
  const s0 = cross(q[0], q[1]);
  const s1 = cross(q[1], q[2]);
  const s2 = cross(q[2], q[3]);
  const s3 = cross(q[3], q[0]);
  const hasNeg = s0 < 0 || s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s0 > 0 || s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
};

const formatNodeLabel = (n) => {
  const id = n.id ? `#${n.id}` : "";
  const cls = n.cls ? `.${n.cls.trim().split(/\s+/).join(".")}` : "";
  return `<${n.tag}${id}${cls}>`;
};

const updateHover = (mouseX, mouseY) => {
  const { dom, sceneMatrix, renderer: r } = tiltState;
  if (!dom || !sceneMatrix) return;
  const canvasW = r.width;
  const canvasH = r.height;
  const nodes = dom.nodes;

  let bestIdx = null;
  let bestDepth = -1;
  let bestArea = Infinity;

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const zTop = n.depth * STACK_STEP + (STACK_STEP * 0.9) / 2;
    const p0 = projectToScreen(n.x, n.y, zTop, sceneMatrix, canvasW, canvasH);
    const p1 = projectToScreen(n.x + n.w, n.y, zTop, sceneMatrix, canvasW, canvasH);
    const p2 = projectToScreen(n.x + n.w, n.y + n.h, zTop, sceneMatrix, canvasW, canvasH);
    const p3 = projectToScreen(n.x, n.y + n.h, zTop, sceneMatrix, canvasW, canvasH);
    if (!p0 || !p1 || !p2 || !p3) continue;

    if (pointInQuad(mouseX, mouseY, [p0, p1, p2, p3])) {
      const area = n.w * n.h;
      if (n.depth > bestDepth || (n.depth === bestDepth && area < bestArea)) {
        bestIdx = i;
        bestDepth = n.depth;
        bestArea = area;
      }
    }
  }

  if (tiltState.hoveredIndex !== bestIdx) {
    tiltState.hoveredIndex = bestIdx;
    if (bestIdx !== null) {
      setStatus(`${formatNodeLabel(nodes[bestIdx])} (depth ${nodes[bestIdx].depth})`);
    } else {
      setStatus(`${nodes.length} nodes loaded`);
    }
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

  const path = [];
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
        path: path.slice(),
      });
    }
    for (let i = 0; i < el.children.length; i++) {
      path.push(i);
      walk(el.children[i], depth + 1);
      path.pop();
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
  if (tiltState.refreshBtn) tiltState.refreshBtn.disabled = true;
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
  } finally {
    if (tiltState.refreshBtn) tiltState.refreshBtn.disabled = false;
  }
};

const refreshDom = () => {
  if (!tiltState.tabId) return;
  tiltState.hoveredIndex = null;
  hideSource();
  collectDom();
};

window.addEventListener("DOMContentLoaded", () => {
  tiltState.canvas = document.getElementById("tilt-canvas");
  tiltState.status = document.getElementById("tilt-status");
  tiltState.sourceView = document.getElementById("tilt-source-view");
  tiltState.sourceTitle = document.getElementById("tilt-source-title");
  tiltState.sourceBody = document.getElementById("tilt-source-body");
  tiltState.refreshBtn = document.getElementById("tilt-refresh");
  document.getElementById("tilt-source-close").addEventListener("click", hideSource);
  tiltState.refreshBtn.addEventListener("click", refreshDom);
  resizeCanvas();
  setStatus("panel loaded, starting renderer");
  startRenderer();
  browser.devtools?.network?.onNavigated.addListener(() => {
    if (tiltState.tabId) refreshDom();
  });
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && tiltState.sourceView && !tiltState.sourceView.hidden) {
    hideSource();
    return;
  }
  if ((ev.key === "r" || ev.key === "R") && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    refreshDom();
  }
});

window.addEventListener("resize", resizeCanvas);

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.type !== "tilt:init") return;
  if (tiltState.tabId === msg.tabId) return;
  tiltState.tabId = msg.tabId;
  if (tiltState.refreshBtn) tiltState.refreshBtn.disabled = false;
  setStatus(`attached to tab ${msg.tabId}, walking DOM...`);
  collectDom();
});
