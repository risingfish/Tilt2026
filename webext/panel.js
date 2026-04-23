"use strict";

// Chromium uses chrome.*; Firefox supports both chrome.* and browser.* (promise-based).
if (typeof globalThis.browser === "undefined") globalThis.browser = globalThis.chrome;

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
  selectedIndex: null,
  sourceView: null,
  sourceTitle: null,
  sourceBody: null,
  refreshBtn: null,
  resetBtn: null,
  showHiddenBtn: null,
  // When true, hidden elements (display:none / visibility:hidden) render as ghost
  // boxes at low alpha. They never get a top-face UV texture regardless.
  showHidden: false,
  pageTexture: null,
  // Merged geometry: one draw call per palette bucket (fills), one for wireframe,
  // one textured quad mesh for top faces. Rebuilt on DOM walk / viewport change.
  // Hidden geometry is kept in parallel arrays so it can be drawn at a different alpha.
  fillMeshes: null,
  wireframeMesh: null,
  hiddenFillMeshes: null,
  hiddenWireframeMesh: null,
  texMesh: null,
  // Rotation pivot. `pivot` is a page-space 3D point (null = rotate around page center).
  // `pivotPan` is a screen-space translation that compensates for pivot changes so the
  // view doesn't jump when the pivot moves.
  pivot: null,
  pivotPan: [0, 0, 0],
  // Snapshot of the rotation quat used on the last drawn frame. Needed for the
  // pivot-change compensation because arcball.loop() returns deltaRot * currentRot,
  // which is not the same as $currentRot.
  lastRenderedRot: [0, 0, 0, 1],
};

const resetView = () => {
  const a = tiltState.arcball;
  if (!a) return;
  // Engine's built-in reset(factor) animates via setInterval and fights with the
  // per-frame loop() calls, so reset directly.
  a.$clearInterval();
  a.$rotating = false;
  a.$mouseButton = -1;
  quat4.set([0, 0, 0, 1], a.$lastRot);
  quat4.set([0, 0, 0, 1], a.$deltaRot);
  quat4.set([0, 0, 0, 1], a.$currentRot);
  a.$deltaKeyRot[0] = 0; a.$deltaKeyRot[1] = 0;
  a.$addKeyRot[0] = 0; a.$addKeyRot[1] = 0;
  a.$lastTrans[0] = 0; a.$lastTrans[1] = 0; a.$lastTrans[2] = 0;
  a.$deltaTrans[0] = 0; a.$deltaTrans[1] = 0; a.$deltaTrans[2] = 0;
  a.$currentTrans[0] = 0; a.$currentTrans[1] = 0; a.$currentTrans[2] = 0;
  a.$deltaKeyTrans[0] = 0; a.$deltaKeyTrans[1] = 0; a.$deltaKeyTrans[2] = 0;
  a.$addKeyTrans[0] = 0; a.$addKeyTrans[1] = 0;
  a.$scrollValue = 0;
  // Clear interpolated mouse state so stale positions don't drive rotation on the next frame.
  a.$mouseMove[0] = a.$mouseMove[1] = 0;
  a.$mouseLerp[0] = a.$mouseLerp[1] = 0;
  a.$mousePress[0] = a.$mousePress[1] = 0;
  a.$mouseRelease[0] = a.$mouseRelease[1] = 0;
  a.$startVec[0] = a.$startVec[1] = a.$startVec[2] = 0;
  a.$endVec[0] = a.$endVec[1] = a.$endVec[2] = 0;
  tiltState.pivot = null;
  tiltState.pivotPan[0] = tiltState.pivotPan[1] = tiltState.pivotPan[2] = 0;
};

const toggleShowHidden = () => {
  tiltState.showHidden = !tiltState.showHidden;
  if (tiltState.showHiddenBtn) {
    tiltState.showHiddenBtn.setAttribute("aria-pressed", String(tiltState.showHidden));
  }
  // Rebuild merged geometry so hidden-element ghost boxes appear/disappear.
  // Note: UV textures are already gated on n.hidden in computeNodeUVs, so hidden
  // nodes never get a top-face texture regardless of this toggle.
  if (tiltState.dom) buildMergedGeometry();
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
  if (w === 0 || h === 0) return;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
    const r = tiltState.renderer;
    if (r) {
      // Engine caches width/height on the renderer (used by r.perspective() every
      // frame) and the GL viewport is fixed at context creation — both must be
      // refreshed or the scene stays rendered at the original panel size.
      r.width = w;
      r.height = h;
      r.gl?.viewport(0, 0, w, h);
    }
    tiltState.arcball?.resize(w, h);
  }
};

// DOM buttons (0=L,1=M,2=R) → Arcball buttons (1=L,3=R).
const mapButton = (btn) => (btn === 0 ? 1 : btn === 2 ? 3 : -1);

// Movement above this many CSS px between mousedown and click = treat as a drag, not a click.
const CLICK_DRAG_THRESHOLD = 5;

const refreshHoverStatus = () => {
  const { dom, hoveredIndex, selectedIndex } = tiltState;
  if (!dom) return;
  if (hoveredIndex !== null) {
    const n = dom.nodes[hoveredIndex];
    setStatus(`${formatNodeLabel(n)} (depth ${n.depth})`);
  } else if (selectedIndex !== null) {
    const n = dom.nodes[selectedIndex];
    setStatus(`selected ${formatNodeLabel(n)} (depth ${n.depth})`);
  } else {
    setStatus(`${dom.nodes.length} nodes loaded`);
  }
};

const selectNode = (idx) => {
  if (tiltState.selectedIndex === idx) return;
  tiltState.selectedIndex = idx;
  refreshHoverStatus();
};

// Baseline tilt angle applied before the arcball rotation (matches drawMesh).
const BASE_TILT = -0.3;

// Build a page-space ray from canvas-space (cx, cy) using the last-rendered sceneMatrix.
// Returns { origin, dir } or null.
const pageRayFromCanvas = (cx, cy) => {
  const { sceneMatrix, renderer: r } = tiltState;
  if (!sceneMatrix || !r) return null;
  const inv = mat4.inverse(sceneMatrix, mat4.create());
  if (!inv) return null;
  const ndcX = (2 * cx) / r.width - 1;
  const ndcY = 1 - (2 * cy) / r.height;
  const near = [0, 0, 0, 0];
  const far = [0, 0, 0, 0];
  mat4.multiplyVec4(inv, [ndcX, ndcY, -1, 1], near);
  mat4.multiplyVec4(inv, [ndcX, ndcY,  1, 1], far);
  if (near[3] === 0 || far[3] === 0) return null;
  near[0] /= near[3]; near[1] /= near[3]; near[2] /= near[3];
  far[0]  /= far[3];  far[1]  /= far[3];  far[2]  /= far[3];
  return {
    origin: [near[0], near[1], near[2]],
    dir: [far[0] - near[0], far[1] - near[1], far[2] - near[2]],
  };
};

// Ray-AABB intersection (slab method). Returns tNear > 0 on hit or null.
const rayAabb = (origin, dir, minB, maxB) => {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = dir[i];
    if (Math.abs(d) < 1e-9) {
      if (origin[i] < minB[i] || origin[i] > maxB[i]) return null;
    } else {
      const inv = 1 / d;
      let t1 = (minB[i] - origin[i]) * inv;
      let t2 = (maxB[i] - origin[i]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin >= 0 ? tmin : (tmax >= 0 ? tmax : null);
};

// Raycast the cursor against every box; return the closest hit point on any face,
// or null if the ray misses the mesh entirely. This picks the exact visible 3D point
// under the cursor (top face, side face — whichever the ray hits first).
const pickMeshPoint = (cx, cy) => {
  const { dom } = tiltState;
  if (!dom) return null;
  const ray = pageRayFromCanvas(cx, cy);
  if (!ray) return null;
  const boxD = STACK_STEP * 0.9;
  const half = boxD / 2;
  let bestT = Infinity;
  let bestNodeIdx = -1;
  for (let i = 0; i < dom.nodes.length; i++) {
    const n = dom.nodes[i];
    const cz = n.depth * STACK_STEP;
    const minB = [n.x,       n.y,       cz - half];
    const maxB = [n.x + n.w, n.y + n.h, cz + half];
    const t = rayAabb(ray.origin, ray.dir, minB, maxB);
    if (t !== null && t < bestT) { bestT = t; bestNodeIdx = i; }
  }
  if (!Number.isFinite(bestT)) return null;
  return [
    ray.origin[0] + bestT * ray.dir[0],
    ray.origin[1] + bestT * ray.dir[1],
    ray.origin[2] + bestT * ray.dir[2],
  ];
};

// Pivot in the "rotation space" — i.e. after S(fit) * T(-pageCenter). Null pivot = [0,0,0].
const getPivotRotSpace = () => {
  const { pivot, dom, renderer: r } = tiltState;
  if (!pivot || !dom || !r) return [0, 0, 0];
  const fit = Math.min(r.width / dom.pageWidth, r.height / dom.pageHeight) * 0.75;
  return [
    fit * (pivot[0] - dom.pageWidth / 2),
    fit * (pivot[1] - dom.pageHeight / 2),
    fit * pivot[2],
  ];
};

// Move the rotation pivot while keeping the rendered view stable. Derivation:
//   pivotPan_new = pivotPan_old + Rx(-0.3) * (I - R) * (pR_old - pR_new)
// where pR = fit * (pivot - pageCenter).
const setPivot = (newPivot) => {
  const { arcball } = tiltState;
  if (!arcball) return;
  const pROld = getPivotRotSpace();
  tiltState.pivot = newPivot;
  const pRNew = getPivotRotSpace();

  const dx = pROld[0] - pRNew[0];
  const dy = pROld[1] - pRNew[1];
  const dz = pROld[2] - pRNew[2];

  // The engine's quat4.toMat4 (used in drawMesh for r.transform(rotMatrix)) stores the
  // matrix so that column-major `M * v` rotates v by q^-1, not q. So the rotation
  // visually applied to vertices is by the conjugate of lastRenderedRot. Compensation
  // must use that same conjugate, or the further from identity the view is rotated,
  // the more the mousedown jumps.
  const lr = tiltState.lastRenderedRot;
  const invRot = [-lr[0], -lr[1], -lr[2], lr[3]];
  const rd = [0, 0, 0];
  quat4.multiplyVec3(invRot, [dx, dy, dz], rd);
  const ix = dx - rd[0];
  const iy = dy - rd[1];
  const iz = dz - rd[2];

  // Apply Rx(BASE_TILT) to (I - R) * delta.
  const c = Math.cos(BASE_TILT);
  const s = Math.sin(BASE_TILT);
  const compX = ix;
  const compY = c * iy - s * iz;
  const compZ = s * iy + c * iz;

  tiltState.pivotPan[0] += compX;
  tiltState.pivotPan[1] += compY;
  tiltState.pivotPan[2] += compZ;
};

const attachArcballInput = () => {
  const canvas = tiltState.canvas;
  const arcball = tiltState.arcball;
  let downX = 0;
  let downY = 0;

  const localCoords = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  };

  canvas.addEventListener("mousedown", (ev) => {
    canvas.focus?.();
    downX = ev.clientX;
    downY = ev.clientY;
    const [x, y] = localCoords(ev);
    // Left-button drag rotates around the exact 3D point on the mesh under the cursor.
    // Ray-AABB cast against every box; pick the closest face hit. Miss = page-center pivot.
    if (ev.button === 0) {
      setPivot(pickMeshPoint(x, y));
    }
    arcball.mouseDown(x, y, mapButton(ev.button));
    // Engine's mouseMove only records while a button is held, so $mouseMove/$mouseLerp
    // hold the position where the previous drag ended. Reset them to the press point
    // so loop()'s startVec/endVec match on frame 1 and no spurious rotation fires.
    arcball.$mouseMove[0] = x; arcball.$mouseMove[1] = y;
    arcball.$mouseLerp[0] = x; arcball.$mouseLerp[1] = y;
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
      refreshHoverStatus();
    }
  });

  // Left-click (no drag) selects the hovered node, or clears selection on a miss.
  canvas.addEventListener("click", (ev) => {
    if (ev.button !== 0) return;
    const moved = Math.abs(ev.clientX - downX) + Math.abs(ev.clientY - downY);
    if (moved > CLICK_DRAG_THRESHOLD) return;
    selectNode(tiltState.hoveredIndex);
  });

  canvas.addEventListener("dblclick", () => {
    const idx = tiltState.hoveredIndex;
    if (idx === null || !tiltState.dom) return;
    selectNode(idx);
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

const SELECTED_STROKE = "#ffcc33ff";

// Unit cube (24 verts, 6 faces × 4 corners) matching Tilt.Cube's layout.
const CUBE_VERTS = [
  -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
  -0.5,  0.5,  0.5,  0.5,  0.5,  0.5,  0.5,  0.5, -0.5, -0.5,  0.5, -0.5,
   0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5,  0.5, -0.5,  0.5,  0.5, -0.5,
  -0.5, -0.5, -0.5,  0.5, -0.5, -0.5,  0.5, -0.5,  0.5, -0.5, -0.5,  0.5,
   0.5, -0.5,  0.5,  0.5, -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,
  -0.5, -0.5, -0.5, -0.5, -0.5,  0.5, -0.5,  0.5,  0.5, -0.5,  0.5, -0.5,
];
const CUBE_INDICES = [
  0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7,
  8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14, 15,
  16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23,
];
// Unit cube wireframe (8 corners, 12 edges as LINES pairs).
const WIRE_VERTS = [
  -0.5, -0.5,  0.5,  0.5, -0.5,  0.5,  0.5,  0.5,  0.5, -0.5,  0.5,  0.5,
   0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5,  0.5, -0.5,  0.5,  0.5, -0.5,
];
const WIRE_INDICES = [
  0, 1, 1, 2, 2, 3, 3, 0,
  4, 5, 5, 6, 6, 7, 7, 4,
  0, 5, 1, 4, 2, 7, 3, 6,
];
const MERGED_STROKE = "#2a2a33aa";
const MERGED_TINT = "#ffffffe6";
// Uint16 index buffer ceiling (WebGL 1). Cap bucket box counts below this.
const MAX_BOXES_PER_FILL_BUCKET = Math.floor(65000 / 24);
const MAX_BOXES_PER_WIRE_MESH  = Math.floor(65000 / 8);
const MAX_QUADS_PER_TEX_MESH   = Math.floor(65000 / 4);

const disposeBuffers = (mesh, keys) => {
  if (!mesh) return;
  for (const k of keys) {
    try { mesh[k]?.destroy(); } catch { /* ignore */ }
  }
};

const disposeMergedGeometry = () => {
  if (tiltState.fillMeshes) {
    for (const m of tiltState.fillMeshes) disposeBuffers(m, ["vertices", "indices"]);
    tiltState.fillMeshes = null;
  }
  disposeBuffers(tiltState.wireframeMesh, ["vertices", "indices"]);
  tiltState.wireframeMesh = null;
  if (tiltState.hiddenFillMeshes) {
    for (const m of tiltState.hiddenFillMeshes) disposeBuffers(m, ["vertices", "indices"]);
    tiltState.hiddenFillMeshes = null;
  }
  disposeBuffers(tiltState.hiddenWireframeMesh, ["vertices", "indices"]);
  tiltState.hiddenWireframeMesh = null;
};

const disposeTextureMesh = () => {
  disposeBuffers(tiltState.texMesh, ["vertices", "texCoord", "indices"]);
  tiltState.texMesh = null;
};

const buildMergedGeometry = () => {
  disposeMergedGeometry();
  const { dom, renderer: r } = tiltState;
  if (!dom || !r) return;
  const { nodes } = dom;
  const boxD = STACK_STEP * 0.9;
  const bucketCount = DEPTH_PALETTE.length;

  // Two parallel batches: visible + hidden. Hidden is only populated when the user
  // has toggled "show hidden" on; it renders at lower alpha and never gets UVs.
  const makeBatch = () => ({
    fillVerts: Array.from({ length: bucketCount }, () => []),
    fillIdx: Array.from({ length: bucketCount }, () => []),
    fillBoxes: new Array(bucketCount).fill(0),
    wireVerts: [],
    wireIdx: [],
    wireBoxes: 0,
  });
  const visible = makeBatch();
  const hidden = makeBatch();
  let skipped = 0;

  const pushNode = (n, batch) => {
    const bucket = n.depth % bucketCount;
    if (batch.fillBoxes[bucket] >= MAX_BOXES_PER_FILL_BUCKET || batch.wireBoxes >= MAX_BOXES_PER_WIRE_MESH) {
      skipped++;
      return;
    }
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2, cz = n.depth * STACK_STEP;
    const sx = n.w, sy = n.h, sz = boxD;

    const fv = batch.fillVerts[bucket];
    const fi = batch.fillIdx[bucket];
    const base = batch.fillBoxes[bucket] * 24;
    for (let i = 0; i < CUBE_VERTS.length; i += 3) {
      fv.push(CUBE_VERTS[i] * sx + cx, CUBE_VERTS[i + 1] * sy + cy, CUBE_VERTS[i + 2] * sz + cz);
    }
    for (let i = 0; i < CUBE_INDICES.length; i++) fi.push(CUBE_INDICES[i] + base);
    batch.fillBoxes[bucket]++;

    const wBase = batch.wireBoxes * 8;
    for (let i = 0; i < WIRE_VERTS.length; i += 3) {
      batch.wireVerts.push(WIRE_VERTS[i] * sx + cx, WIRE_VERTS[i + 1] * sy + cy, WIRE_VERTS[i + 2] * sz + cz);
    }
    for (let i = 0; i < WIRE_INDICES.length; i++) batch.wireIdx.push(WIRE_INDICES[i] + wBase);
    batch.wireBoxes++;
  };

  for (const n of nodes) {
    if (n.hidden) {
      // Hidden nodes stay in dom.nodes so picking and the highlight overlay still
      // work; when showHidden is off, we skip them from the merged mesh so they
      // don't occlude the top-face UV textures of their visible ancestors.
      if (tiltState.showHidden) pushNode(n, hidden);
    } else {
      pushNode(n, visible);
    }
  }
  if (skipped > 0) console.warn(`[tilt] merged mesh skipped ${skipped} nodes (Uint16 limit)`);

  const buildBatch = (batch, alphaHex) => {
    const meshes = [];
    for (let b = 0; b < bucketCount; b++) {
      if (!batch.fillVerts[b].length) { meshes.push(null); continue; }
      meshes.push(new Tilt.Mesh({
        vertices: new Tilt.VertexBuffer(batch.fillVerts[b], 3),
        indices: new Tilt.IndexBuffer(batch.fillIdx[b]),
        color: Tilt.Math.hex2rgba(`${DEPTH_PALETTE[b]}${alphaHex}`),
        drawMode: r.TRIANGLES,
      }));
    }
    const wire = batch.wireVerts.length ? new Tilt.Mesh({
      vertices: new Tilt.VertexBuffer(batch.wireVerts, 3),
      indices: new Tilt.IndexBuffer(batch.wireIdx),
      color: Tilt.Math.hex2rgba(MERGED_STROKE),
      drawMode: r.LINES,
    }) : null;
    return { meshes, wire };
  };

  const vis = buildBatch(visible, "59");
  tiltState.fillMeshes = vis.meshes;
  tiltState.wireframeMesh = vis.wire;

  const hid = buildBatch(hidden, "33");
  tiltState.hiddenFillMeshes = hid.meshes;
  tiltState.hiddenWireframeMesh = hid.wire;
};

const buildTextureMesh = () => {
  disposeTextureMesh();
  const { dom, pageTexture, renderer: r } = tiltState;
  if (!dom || !pageTexture || !r) return;
  const boxD = STACK_STEP * 0.9;
  const topFaceZ = boxD / 2 + 0.5;

  const verts = [];
  const uvs = [];
  const idxs = [];
  let quads = 0;
  for (const n of dom.nodes) {
    if (!n.uvBuffer) continue;
    if (quads >= MAX_QUADS_PER_TEX_MESH) break;
    const z = n.depth * STACK_STEP + topFaceZ;
    const x0 = n.x + n.texDx, y0 = n.y + n.texDy;
    const x1 = x0 + n.texW,   y1 = y0 + n.texH;
    verts.push(x0, y0, z,  x1, y0, z,  x0, y1, z,  x1, y1, z);
    const c = n.uvBuffer.components; // [u0,v0, u1,v0, u0,v1, u1,v1]
    for (let i = 0; i < c.length; i++) uvs.push(c[i]);
    const base = quads * 4;
    // Two CCW triangles: TL,TR,BL  and  TR,BR,BL
    idxs.push(base, base + 1, base + 2,  base + 1, base + 3, base + 2);
    quads++;
  }
  if (!verts.length) return;
  tiltState.texMesh = new Tilt.Mesh({
    vertices: new Tilt.VertexBuffer(verts, 3),
    texCoord: new Tilt.VertexBuffer(uvs, 2),
    indices: new Tilt.IndexBuffer(idxs),
    color: Tilt.Math.hex2rgba(MERGED_TINT),
    texture: pageTexture,
    drawMode: r.TRIANGLES,
  });
};

const drawMesh = () => {
  const { dom, renderer: r, arcball, hoveredIndex, selectedIndex } = tiltState;
  const { pageWidth: pageW, pageHeight: pageH, nodes } = dom;
  const canvasW = r.width;
  const canvasH = r.height;
  const fit = Math.min(canvasW / pageW, canvasH / pageH) * 0.75;

  const { rotation, translation } = arcball.loop();
  const rotMatrix = quat4.toMat4(rotation);
  // Snapshot the actual rendered rotation (not $currentRot — loop() composes with
  // deltaRot from mouse/keyboard input) so setPivot can compensate against it.
  quat4.set(rotation, tiltState.lastRenderedRot);
  const pR = getPivotRotSpace();
  const pp = tiltState.pivotPan;

  r.perspective();
  r.translate(canvasW / 2, canvasH / 2, 0);
  r.translate(translation[0], translation[1], translation[2]);
  r.translate(pp[0], pp[1], pp[2]); // compensation keeping the view stable when pivot moves
  r.rotate(BASE_TILT, 1, 0, 0); // baseline forward tilt so stacking reads on first frame
  r.translate(pR[0], pR[1], pR[2]);
  r.transform(rotMatrix);
  r.translate(-pR[0], -pR[1], -pR[2]);
  r.scale(fit, fit, fit);
  r.translate(-pageW / 2, -pageH / 2, 0);

  // Snapshot the scene matrix (proj * mv) *before* any per-node pushMatrix
  // so picking can project page-space points to screen-space.
  tiltState.sceneMatrix = mat4.multiply(r.projMatrix, r.mvMatrix, mat4.create());

  const { pageTexture, fillMeshes, wireframeMesh, texMesh, hiddenFillMeshes, hiddenWireframeMesh } = tiltState;
  const texReady = pageTexture?.loaded;
  const boxD = STACK_STEP * 0.9;
  const topFaceZ = boxD / 2 + 0.5;

  // Merged batches: 8 bucket fills + 1 wireframe + 1 textured quad = ~10 draw calls
  // regardless of node count. (Previously ~3N.)
  if (fillMeshes) {
    for (const m of fillMeshes) if (m) m.draw();
  }
  if (wireframeMesh) wireframeMesh.draw();
  if (texMesh) texMesh.draw();
  // Hidden-element ghost geometry (only populated when showHidden is on). Drawn
  // after the textured top faces so its low alpha blends on top without hiding
  // texture data behind it.
  if (hiddenFillMeshes) {
    for (const m of hiddenFillMeshes) if (m) m.draw();
  }
  if (hiddenWireframeMesh) hiddenWireframeMesh.draw();

  // Highlight overlay: at most hovered + selected, drawn as individual boxes
  // with a small +z nudge so they paint on top of the merged geometry.
  const highlights = [];
  if (selectedIndex !== null) highlights.push({ idx: selectedIndex, kind: "selected" });
  if (hoveredIndex !== null && hoveredIndex !== selectedIndex) {
    highlights.push({ idx: hoveredIndex, kind: "hovered" });
  }
  for (const h of highlights) {
    const n = nodes[h.idx];
    const color = DEPTH_PALETTE[n.depth % DEPTH_PALETTE.length];
    const fillAlpha = n.hidden ? "33" : "a6";
    r.pushMatrix();
    // +0.5 along z nudges highlight box in front of its merged twin, avoiding z-fight.
    r.translate(n.x + n.w / 2, n.y + n.h / 2, n.depth * STACK_STEP + 0.5);
    r.fill(`${color}${fillAlpha}`);
    r.stroke(h.kind === "selected" ? SELECTED_STROKE : "#ffffffff");
    r.box(n.w, n.h, boxD);
    if (texReady && n.uvBuffer) {
      r.tint("#ffffffff");
      r.pushMatrix();
      r.translate(-n.w / 2 + n.texDx, -n.h / 2 + n.texDy, topFaceZ);
      r.image(pageTexture, 0, 0, n.texW, n.texH, n.uvBuffer);
      r.popMatrix();
    }
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
    refreshHoverStatus();
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
      const style = window.getComputedStyle(el);
      out.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        cls: typeof el.className === "string" ? (el.className || null) : null,
        depth,
        x: left + scrollX,
        y: top + scrollY,
        w: width,
        h: height,
        hidden: style.display === "none" || style.visibility === "hidden",
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
  return {
    pageWidth,
    pageHeight,
    viewportX: scrollX,
    viewportY: scrollY,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    nodes: out,
  };
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
    buildMergedGeometry();
    setStatus(
      `walked DOM: ${value.nodes.length} nodes, ` +
      `page ${Math.round(value.pageWidth)}x${Math.round(value.pageHeight)}`,
    );
    console.log("[tilt] first 5 nodes:", value.nodes.slice(0, 5));
    console.log("[tilt] full result stored at tiltState.dom");
    capturePage();
  } catch (err) {
    setStatus(`eval rejected: ${err?.message ?? err}`);
  } finally {
    if (tiltState.refreshBtn) tiltState.refreshBtn.disabled = false;
  }
};

// Adaptive polling: fast (FAST_MS) while the page is actively changing,
// slow (SLOW_MS) after IDLE_MS of no change. Resets to fast on any detected change.
const POLL_FAST_MS = 400;
const POLL_SLOW_MS = 1000;
const POLL_IDLE_MS = 10_000;

let pollingActive = false;
let pollTimeoutId = null;
let pollInFlight = false;
let lastChangeAt = 0;

const pollScroll = async () => {
  pollTimeoutId = null;
  if (!pollingActive) return;
  if (!pollInFlight && tiltState.tabId && tiltState.dom && browser.devtools?.inspectedWindow) {
    pollInFlight = true;
    try {
      const [value, exc] = await browser.devtools.inspectedWindow.eval(
        "[window.scrollX||0, window.scrollY||0, window.innerWidth, window.innerHeight]",
      );
      if (!exc && value) {
        const [sx, sy, vw, vh] = value;
        const { dom } = tiltState;
        if (
          sx !== dom.viewportX || sy !== dom.viewportY ||
          vw !== dom.viewportW || vh !== dom.viewportH
        ) {
          dom.viewportX = sx;
          dom.viewportY = sy;
          dom.viewportW = vw;
          dom.viewportH = vh;
          lastChangeAt = Date.now();
          await capturePage();
        }
      }
    } finally {
      pollInFlight = false;
    }
  }
  if (!pollingActive) return;
  const interval = Date.now() - lastChangeAt > POLL_IDLE_MS ? POLL_SLOW_MS : POLL_FAST_MS;
  pollTimeoutId = setTimeout(pollScroll, interval);
};

const startPolling = () => {
  if (pollingActive) return;
  pollingActive = true;
  lastChangeAt = Date.now();
  pollTimeoutId = setTimeout(pollScroll, POLL_FAST_MS);
};

const stopPolling = () => {
  pollingActive = false;
  if (pollTimeoutId !== null) {
    clearTimeout(pollTimeoutId);
    pollTimeoutId = null;
  }
};

const refreshDom = () => {
  if (!tiltState.tabId) return;
  tiltState.hoveredIndex = null;
  tiltState.selectedIndex = null;
  tiltState.pageTexture = null;
  tiltState.pivot = null;
  tiltState.pivotPan[0] = tiltState.pivotPan[1] = tiltState.pivotPan[2] = 0;
  disposeTextureMesh();
  disposeMergedGeometry();
  hideSource();
  collectDom();
};

// Clip each node's page rect to the viewport, then build a UV buffer that samples
// only that clipped region. The drawn quad is also shrunk to match, which prevents
// clamp-to-edge smearing when a node extends past the viewport bounds.
const computeNodeUVs = () => {
  const { dom } = tiltState;
  if (!dom) return;
  const { viewportX: vpX, viewportY: vpY, viewportW: vpW, viewportH: vpH, nodes } = dom;
  const vpR = vpX + vpW;
  const vpB = vpY + vpH;
  for (const n of nodes) {
    if (n.hidden) {
      n.uvBuffer = null;
      continue;
    }
    const cx0 = Math.max(n.x, vpX);
    const cy0 = Math.max(n.y, vpY);
    const cx1 = Math.min(n.x + n.w, vpR);
    const cy1 = Math.min(n.y + n.h, vpB);
    if (cx1 <= cx0 || cy1 <= cy0) {
      n.uvBuffer = null;
      continue;
    }
    n.texDx = cx0 - n.x;
    n.texDy = cy0 - n.y;
    n.texW = cx1 - cx0;
    n.texH = cy1 - cy0;
    const u0 = (cx0 - vpX) / vpW;
    const u1 = (cx1 - vpX) / vpW;
    const v0 = (cy0 - vpY) / vpH;
    const v1 = (cy1 - vpY) / vpH;
    n.uvBuffer = new Tilt.VertexBuffer([u0, v0, u1, v0, u0, v1, u1, v1], 2);
  }
  buildTextureMesh();
};

const capturePage = async () => {
  if (!tiltState.tabId) return;
  try {
    const resp = await browser.runtime.sendMessage({
      type: "tilt:capture",
      tabId: tiltState.tabId,
    });
    if (!resp?.ok) {
      console.warn("[tilt] capture failed:", resp?.error);
      return;
    }
    const img = new Image();
    img.addEventListener("load", () => {
      tiltState.pageTexture = new Tilt.Texture(img);
      computeNodeUVs();
    });
    img.addEventListener("error", () => {
      console.warn("[tilt] capture image failed to decode");
    });
    img.src = resp.dataUrl;
  } catch (err) {
    console.warn("[tilt] capture error:", err);
  }
};

window.addEventListener("DOMContentLoaded", () => {
  tiltState.canvas = document.getElementById("tilt-canvas");
  tiltState.status = document.getElementById("tilt-status");
  tiltState.sourceView = document.getElementById("tilt-source-view");
  tiltState.sourceTitle = document.getElementById("tilt-source-title");
  tiltState.sourceBody = document.getElementById("tilt-source-body");
  tiltState.refreshBtn = document.getElementById("tilt-refresh");
  tiltState.resetBtn = document.getElementById("tilt-reset");
  tiltState.showHiddenBtn = document.getElementById("tilt-show-hidden");
  document.getElementById("tilt-source-close").addEventListener("click", hideSource);
  tiltState.refreshBtn.addEventListener("click", refreshDom);
  tiltState.resetBtn.addEventListener("click", resetView);
  tiltState.showHiddenBtn.addEventListener("click", toggleShowHidden);
  resizeCanvas();
  setStatus("panel loaded, starting renderer");
  startRenderer();
  browser.devtools?.network?.onNavigated.addListener(() => {
    if (tiltState.tabId) refreshDom();
  });
  // Pause polling while the panel isn't visible to the user — saves CPU/battery.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else if (tiltState.tabId) startPolling();
  });
});

// Arcball's built-in nav keys: WASD rotate, arrows translate. Handled by the
// engine's Arcball.loop() reading from its $keyCode table.
// W/S are swapped so W tilts the top of the mesh away from the viewer.
const ARCBALL_KEYS = new Set([65, 68, 87, 83, 37, 38, 39, 40]);
const remapArcballKey = (code) => (code === 87 ? 83 : code === 83 ? 87 : code);

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (tiltState.sourceView && !tiltState.sourceView.hidden) {
      hideSource();
      return;
    }
    if (tiltState.selectedIndex !== null) {
      selectNode(null);
      return;
    }
  }
  // Don't hijack keys while the source overlay is open — the user may be scrolling/selecting.
  const sourceOpen = tiltState.sourceView && !tiltState.sourceView.hidden;
  if (!sourceOpen && tiltState.arcball && ARCBALL_KEYS.has(ev.keyCode)) {
    tiltState.arcball.keyDown(remapArcballKey(ev.keyCode));
    ev.preventDefault();
    return;
  }
  if ((ev.key === "r" || ev.key === "R") && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    refreshDom();
  }
  if (ev.key === "Home") {
    resetView();
  }
});

window.addEventListener("keyup", (ev) => {
  if (tiltState.arcball && ARCBALL_KEYS.has(ev.keyCode)) {
    tiltState.arcball.keyUp(remapArcballKey(ev.keyCode));
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
  if (!document.hidden) startPolling();
});
