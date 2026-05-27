// Floating window manager: drag-by-header with snapping, corner resize,
// persistent layout. Also handles the detached circular listen button.

const SNAP = 10;          // px snap threshold
const MIN_W = 280;
const MIN_H = 140;
const LS_LAYOUT = "stochastic-jue:layout";
const LS_LISTEN = "stochastic-jue:listenpos";

let topZ = 10;

// ---------- persistence ----------

function loadLayout() {
  try { return JSON.parse(localStorage.getItem(LS_LAYOUT) || "{}"); }
  catch { return {}; }
}
function saveLayout(layout) {
  localStorage.setItem(LS_LAYOUT, JSON.stringify(layout));
}
function patchNodeLayout(id, patch) {
  const layout = loadLayout();
  layout[id] = { ...(layout[id] || {}), ...patch };
  saveLayout(layout);
}

// ---------- initial positions ----------

function applyDefaultLayout(nodes, workspace) {
  const W = workspace.clientWidth;
  const H = workspace.clientHeight;
  const gap = 12;
  const colW = Math.floor((W - gap * 3) / 2);
  const configH = 240;
  const promptH = Math.max(MIN_H, H - gap * 3 - configH);
  const rightH = Math.floor((H - gap * 3) / 2);

  const positions = {
    config: { x: gap, y: gap, w: colW, h: configH },
    prompt: { x: gap, y: gap * 2 + configH, w: colW, h: promptH },
    stt:    { x: gap * 2 + colW, y: gap, w: colW, h: rightH },
    llm:    { x: gap * 2 + colW, y: gap * 2 + rightH, w: colW, h: rightH },
  };

  nodes.forEach(node => {
    const p = positions[node.dataset.node];
    if (!p) return;
    applyRect(node, p);
  });
}

function applyRect(node, r) {
  node.style.left   = r.x + "px";
  node.style.top    = r.y + "px";
  node.style.width  = r.w + "px";
  node.style.height = r.h + "px";
}

// ---------- snapping ----------

function snap(value, target) {
  return Math.abs(value - target) < SNAP ? target : value;
}

function snapNode(rect, others, workspaceRect) {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  let nx = rect.x;
  let ny = rect.y;

  // workspace edges
  nx = snap(nx, 0);
  ny = snap(ny, 0);
  if (Math.abs(right - workspaceRect.w) < SNAP)  nx = workspaceRect.w - rect.w;
  if (Math.abs(bottom - workspaceRect.h) < SNAP) ny = workspaceRect.h - rect.h;

  // other nodes
  for (const o of others) {
    const ol = o.x, or = o.x + o.w, ot = o.y, ob = o.y + o.h;
    // horizontal
    nx = snap(nx, ol);
    nx = snap(nx, or);
    if (Math.abs(rect.x + rect.w - ol) < SNAP) nx = ol - rect.w;
    if (Math.abs(rect.x + rect.w - or) < SNAP) nx = or - rect.w;
    // vertical
    ny = snap(ny, ot);
    ny = snap(ny, ob);
    if (Math.abs(rect.y + rect.h - ot) < SNAP) ny = ot - rect.h;
    if (Math.abs(rect.y + rect.h - ob) < SNAP) ny = ob - rect.h;
  }

  return { x: nx, y: ny };
}

// ---------- draggable header ----------

function bindDrag(node, allNodes, workspace) {
  const header = node.querySelector(".node-header");
  if (!header) return;
  header.style.cursor = "move";

  let dragging = false;
  let startX = 0, startY = 0, origX = 0, origY = 0;

  header.addEventListener("mousedown", (e) => {
    if (e.target.closest("input,textarea,button,.resize-handle")) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    origX = node.offsetLeft;
    origY = node.offsetTop;
    node.style.zIndex = String(++topZ);
    node.classList.add("dragging");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const proposed = {
      x: origX + (e.clientX - startX),
      y: origY + (e.clientY - startY),
      w: node.offsetWidth,
      h: node.offsetHeight,
    };
    const others = allNodes
      .filter(n => n !== node)
      .map(n => ({ x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight }));
    const wsRect = { w: workspace.clientWidth, h: workspace.clientHeight };
    const snapped = snapNode(proposed, others, wsRect);
    node.style.left = snapped.x + "px";
    node.style.top  = snapped.y + "px";
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    node.classList.remove("dragging");
    patchNodeLayout(node.dataset.node, {
      x: node.offsetLeft, y: node.offsetTop,
      w: node.offsetWidth, h: node.offsetHeight,
    });
  });
}

// ---------- resize handle ----------

function bindResize(node, allNodes, workspace) {
  const handle = document.createElement("div");
  handle.className = "resize-handle";
  handle.title = "Resize";
  node.appendChild(handle);

  let resizing = false;
  let startX = 0, startY = 0, origW = 0, origH = 0;

  handle.addEventListener("mousedown", (e) => {
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    origW = node.offsetWidth;
    origH = node.offsetHeight;
    node.style.zIndex = String(++topZ);
    node.classList.add("resizing");
    e.preventDefault();
    e.stopPropagation();
  });

  window.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    let nw = Math.max(MIN_W, origW + (e.clientX - startX));
    let nh = Math.max(MIN_H, origH + (e.clientY - startY));

    // snap right/bottom edges to other nodes' left/top edges and workspace edges
    const left = node.offsetLeft, top = node.offsetTop;
    const wsRect = { w: workspace.clientWidth, h: workspace.clientHeight };
    if (Math.abs(left + nw - wsRect.w) < SNAP) nw = wsRect.w - left;
    if (Math.abs(top  + nh - wsRect.h) < SNAP) nh = wsRect.h - top;

    for (const o of allNodes) {
      if (o === node) continue;
      const ol = o.offsetLeft, ot = o.offsetTop;
      const or = ol + o.offsetWidth, ob = ot + o.offsetHeight;
      if (Math.abs(left + nw - ol) < SNAP) nw = ol - left;
      if (Math.abs(left + nw - or) < SNAP) nw = or - left;
      if (Math.abs(top  + nh - ot) < SNAP) nh = ot - top;
      if (Math.abs(top  + nh - ob) < SNAP) nh = ob - top;
    }

    node.style.width  = nw + "px";
    node.style.height = nh + "px";
  });

  window.addEventListener("mouseup", () => {
    if (!resizing) return;
    resizing = false;
    node.classList.remove("resizing");
    patchNodeLayout(node.dataset.node, {
      x: node.offsetLeft, y: node.offsetTop,
      w: node.offsetWidth, h: node.offsetHeight,
    });
  });
}

// ---------- click-to-focus z-index ----------

function bindFocus(node) {
  node.addEventListener("mousedown", () => {
    node.style.zIndex = String(++topZ);
  }, true);
}

// ---------- floating circular listen button ----------

function bindListenButton() {
  const btn = document.getElementById("listen-btn-float");
  if (!btn) return;

  // restore saved position
  try {
    const saved = JSON.parse(localStorage.getItem(LS_LISTEN) || "null");
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      btn.style.left   = saved.x + "px";
      btn.style.top    = saved.y + "px";
      btn.style.right  = "auto";
      btn.style.bottom = "auto";
    }
  } catch {}

  const THRESHOLD = 8;
  let pointerId = null;
  let moved = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pointerId = e.pointerId;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = btn.getBoundingClientRect();
    origLeft = rect.left;
    origTop  = rect.top;
  });

  btn.addEventListener("pointermove", (e) => {
    if (pointerId !== e.pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved) {
      if (Math.hypot(dx, dy) < THRESHOLD) return;
      moved = true;
      btn.classList.add("dragging");
      try { btn.setPointerCapture(pointerId); } catch {}
    }
    const x = Math.max(4, Math.min(window.innerWidth  - btn.offsetWidth  - 4, origLeft + dx));
    const y = Math.max(4, Math.min(window.innerHeight - btn.offsetHeight - 4, origTop  + dy));
    btn.style.left   = x + "px";
    btn.style.top    = y + "px";
    btn.style.right  = "auto";
    btn.style.bottom = "auto";
  });

  const endDrag = (e) => {
    if (pointerId !== e.pointerId) return;
    if (moved) {
      btn.classList.remove("dragging");
      localStorage.setItem(LS_LISTEN, JSON.stringify({
        x: parseInt(btn.style.left, 10),
        y: parseInt(btn.style.top,  10),
      }));
      // suppress the synthetic click that fires after a drag ends
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        btn.removeEventListener("click", swallow, true);
      };
      btn.addEventListener("click", swallow, true);
      try { btn.releasePointerCapture(pointerId); } catch {}
    }
    pointerId = null;
    moved = false;
  };
  btn.addEventListener("pointerup",     endDrag);
  btn.addEventListener("pointercancel", endDrag);
}

// ---------- init ----------

window.addEventListener("DOMContentLoaded", () => {
  const workspace = document.querySelector(".workspace");
  const nodes = Array.from(document.querySelectorAll(".node"));
  const layout = loadLayout();

  if (Object.keys(layout).length && nodes.every(n => layout[n.dataset.node])) {
    nodes.forEach(n => applyRect(n, layout[n.dataset.node]));
  } else {
    applyDefaultLayout(nodes, workspace);
  }

  nodes.forEach(n => {
    bindFocus(n);
    bindDrag(n, nodes, workspace);
    bindResize(n, nodes, workspace);
  });

  bindListenButton();
});
