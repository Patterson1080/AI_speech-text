// TD-SPK-TXT front-end controller.
// Captures mic at 16 kHz, streams PCM to /ws, renders updates back into the UI.

const DEFAULT_SYSTEM_PROMPT = `You are a semantic-affective image prompt generator for a diffusion model.

For any input phrase, silently analyze its emotional tone using Osgood's EPA (Evaluation, Potency, Activity) model, then generate a single vivid diffusion prompt that embodies that affective signature.

The prompt must:
- Be one rich, descriptive sentence of approximately 77 tokens
- Draw on natural, biological, or cosmic imagery
- Be guided by a relevant complexity pattern (phyllotaxis, Voronoi tessellation, percolation, spiral arms, erosion networks, L-systems, etc.) that shapes structure without dominating the scene

Output only the prompt. No analysis, no labels, no extra punctuation.`;

const els = {
  apiKey:    document.getElementById("api-key"),
  oscHost:   document.getElementById("osc-host"),
  oscPort:   document.getElementById("osc-port"),
  sttAddr:   document.getElementById("stt-addr"),
  llmAddr:   document.getElementById("llm-addr"),
  prompt:    document.getElementById("system-prompt"),
  micSelect: document.getElementById("mic-select"),
  micMeter:  document.getElementById("mic-meter"),
  sttOut:    document.getElementById("stt-out"),
  llmOut:    document.getElementById("llm-out"),
  log:       document.getElementById("log"),
  status:    document.getElementById("status"),
  oscTarget: document.getElementById("osc-target"),
  clock:     document.getElementById("clock"),
  toggleBtn:   document.getElementById("listen-btn-float"),
  toggleGlyph: document.getElementById("listen-glyph"),
  toggleLabel: document.getElementById("listen-label"),
  saveBtn:     document.getElementById("save-btn"),
};

// ---------- persistence (server-side: config.json next to app.py) ----------

async function loadCfg() {
  try {
    const r = await fetch("/api/config");
    if (r.ok) return await r.json();
  } catch (e) {
    setLog("_ COULDN'T LOAD CONFIG: " + e.message, "warn");
  }
  return null;
}
async function saveCfg() {
  const cfg = readForm();
  try {
    const r = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    setLog("_ SAVED TO config.json", "ok");
    els.oscTarget.textContent = `${cfg.osc_host}:${cfg.osc_port}`;
    return true;
  } catch (e) {
    setLog("_ SAVE FAILED: " + e.message, "err");
    return false;
  }
}
function readForm() {
  return {
    api_key:         els.apiKey.value.trim(),
    osc_host:        els.oscHost.value.trim() || "127.0.0.1",
    osc_port:        parseInt(els.oscPort.value, 10) || 7000,
    stt_address:     els.sttAddr.value.trim() || "/stt",
    llm_address:     els.llmAddr.value.trim() || "/llm",
    system_prompt:   els.prompt.value,
    input_device_id: els.micSelect.value || "",
  };
}
function applyCfg(cfg) {
  if (cfg.api_key       != null) els.apiKey.value  = cfg.api_key;
  if (cfg.osc_host      != null) els.oscHost.value = cfg.osc_host;
  if (cfg.osc_port      != null) els.oscPort.value = cfg.osc_port;
  if (cfg.stt_address   != null) els.sttAddr.value = cfg.stt_address;
  if (cfg.llm_address   != null) els.llmAddr.value = cfg.llm_address;
  if (cfg.system_prompt != null) els.prompt.value  = cfg.system_prompt;
  if (cfg.input_device_id != null) els.micSelect.value = cfg.input_device_id;
  els.oscTarget.textContent = `${els.oscHost.value}:${els.oscPort.value}`;
}

// ---------- ui helpers ----------

function setLog(msg, level) {
  els.log.textContent = msg;
  els.log.classList.remove("log-err", "log-warn", "log-ok");
  if (level) els.log.classList.add("log-" + level);
}
function setStatus(text, cls) {
  els.status.className = "status kv" + (cls ? " " + cls : "");
  // preserve the dot
  els.status.innerHTML = `<span class="dot"></span>${text}`;
}

// ---------- mic VU meter ----------

const METER_CELLS = 16;
let meterRaf = null;
let meterAnalyser = null;
let meterBuf = null;

function buildMicMeter() {
  els.micMeter.innerHTML = "";
  for (let i = 0; i < METER_CELLS; i++) {
    const c = document.createElement("div");
    c.className = "mic-meter-cell";
    els.micMeter.appendChild(c);
  }
}

function startMicMeter(source, ctx) {
  meterAnalyser = ctx.createAnalyser();
  meterAnalyser.fftSize = 256;
  meterAnalyser.smoothingTimeConstant = 0.3;
  source.connect(meterAnalyser);
  meterBuf = new Uint8Array(meterAnalyser.fftSize);

  const cells = els.micMeter.querySelectorAll(".mic-meter-cell");
  const tick = () => {
    if (!meterAnalyser) return;
    meterAnalyser.getByteTimeDomainData(meterBuf);
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) {
      const v = (meterBuf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / meterBuf.length);
    const level = Math.min(1, rms * 3.5);
    const lit = Math.round(level * METER_CELLS);
    for (let i = 0; i < METER_CELLS; i++) {
      const c = cells[i];
      c.classList.remove("on", "amber", "red");
      if (i < lit) {
        c.classList.add("on");
        if (i >= 13) c.classList.add("red");
        else if (i >= 10) c.classList.add("amber");
      }
    }
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

function stopMicMeter() {
  if (meterRaf) cancelAnimationFrame(meterRaf);
  meterRaf = null;
  meterAnalyser = null;
  meterBuf = null;
  els.micMeter.querySelectorAll(".mic-meter-cell").forEach(c =>
    c.classList.remove("on", "amber", "red")
  );
}

// ---------- device enumeration ----------

async function refreshMicList() {
  const sel = els.micSelect;
  const previous = sel.value;
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {
    setLog("_ DEVICE ENUMERATION FAILED: " + e.message, "warn");
    return;
  }
  const inputs = devices.filter(d => d.kind === "audioinput");
  sel.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = inputs.length ? "(system default)" : "(no mics found)";
  sel.appendChild(def);
  inputs.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Input ${i + 1}  (grant mic once to see name)`;
    sel.appendChild(o);
  });
  if (previous && [...sel.options].some(o => o.value === previous)) {
    sel.value = previous;
  }
}

// ---------- audio + websocket ----------

let ws = null;
let audioCtx = null;
let mediaStream = null;
let workletNode = null;
let listening = false;

async function start() {
  const cfg = readForm();
  if (!cfg.api_key) { setLog("_ ERROR: GOOGLE_API_KEY MISSING.", "err"); setStatus("ERROR", "error"); return; }
  await saveCfg();

  // permission pre-check (avoid hanging silently on blocked mic)
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const p = await navigator.permissions.query({ name: "microphone" });
      if (p.state === "denied") {
        setLog("_ MIC BLOCKED. CLICK THE PADLOCK IN THE ADDRESS BAR → ALLOW MIC → RELOAD.", "err");
        setStatus("MIC BLOCKED", "error");
        return;
      }
    } catch {}
  }

  setStatus("REQUESTING MIC", "thinking");
  setLog("_ WAITING FOR MIC PERMISSION...");

  // mic — prefer the explicitly chosen deviceId; fall back to default if missing
  const wanted = cfg.input_device_id;
  const baseAudio = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl:  true,
  };
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: wanted ? { ...baseAudio, deviceId: { exact: wanted } } : baseAudio,
    });
  } catch (e) {
    if (wanted && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) {
      setLog("_ SAVED MIC NOT FOUND — USING SYSTEM DEFAULT", "warn");
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
      } catch (e2) {
        setLog(`_ MIC DENIED: ${e2.message}`, "err");
        setStatus("MIC DENIED", "error");
        return;
      }
    } else {
      setLog(`_ MIC DENIED: ${e.message}`, "err");
      setStatus("MIC DENIED", "error");
      return;
    }
  }
  // After permission grant the device labels become readable — refresh the picker.
  refreshMicList();

  setStatus("CONNECTING", "thinking");
  setLog("_ OPENING WEBSOCKET...");

  try {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  } catch {
    audioCtx = new AudioContext();
  }
  await audioCtx.audioWorklet.addModule("/web/worklet.js");
  const src = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm-capture");
  startMicMeter(src, audioCtx);

  // websocket
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "start", config: cfg }));
    workletNode.port.onmessage = (ev) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(ev.data);
    };
    src.connect(workletNode);
    // worklet doesn't need to feed audio out, but Chrome will suspend if not connected
    workletNode.connect(audioCtx.destination);
    listening = true;
    els.toggleBtn.classList.add("active");
    els.toggleGlyph.textContent = "■";
    els.toggleLabel.textContent = "STOP";
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handleServer(m);
  };

  ws.onerror = () => setLog("_ WEBSOCKET ERROR.", "err");
  ws.onclose = () => { if (listening) stop(); };
}

function handleServer(m) {
  switch (m.type) {
    case "status":
      if (m.text === "LISTENING")        setStatus(m.text, "listening");
      else if (m.text === "ANALYZING")   setStatus("ANALYZING", "thinking");
      else if (m.text === "CONNECTING")  setStatus("CONNECTING", "thinking");
      else if (m.text === "IDLE")        setStatus("IDLE");
      else                               setStatus(m.text);
      break;
    case "stt_partial":
      els.sttOut.textContent = "> " + m.text;
      break;
    case "stt_final":
      els.sttOut.textContent = "> " + m.text;
      setLog("_ STT → " + readForm().stt_address);
      break;
    case "llm": {
      const scenes = (m.scenes && m.scenes.length) ? m.scenes : null;
      els.llmOut.textContent = scenes ? scenes.join("\n\n") : (m.text || "");
      const n = scenes ? scenes.length : 0;
      const base = readForm().llm_address.replace(/\/$/, "");
      const addr = n === 1 ? `${base}/1` : n > 1 ? `${base}/1..${n}` : base;
      setLog(`_ LLM → ${addr}  (${n} scene prompt${n === 1 ? "" : "s"})`, "ok");
      break;
    }
    case "done":
      finalize();
      break;
    case "error":
      setLog("_ ERROR: " + m.text, "err");
      setStatus("ERROR", "error");
      finalize();
      break;
  }
}

function stop() {
  // Begin finalize: stop the mic locally, but keep the WS open so the
  // server can run the LLM and push the result back. Full teardown happens
  // in finalize() when the server sends `done` (or an error).
  if (!listening) return;
  listening = false;
  els.toggleBtn.classList.remove("active");
  els.toggleBtn.classList.add("thinking");
  els.toggleGlyph.textContent = "⋯";
  els.toggleLabel.textContent = "ANALYZING";
  try { ws && ws.send(JSON.stringify({ type: "stop" })); } catch {}
  try { workletNode && workletNode.disconnect(); } catch {}
  try { mediaStream && mediaStream.getTracks().forEach(t => t.stop()); } catch {}
}

function finalize() {
  listening = false;
  els.toggleBtn.classList.remove("active", "thinking");
  els.toggleGlyph.textContent = "▶";
  els.toggleLabel.textContent = "START";
  stopMicMeter();
  try { ws && ws.close(); } catch {}
  try { audioCtx && audioCtx.close(); } catch {}
  ws = null;
  audioCtx = null; workletNode = null; mediaStream = null;
  setStatus("IDLE");
}

// ---------- color theme switcher ----------

const THEME_KEY = "stochastic-jue:theme";

function applyTheme(t) {
  if (t) document.body.setAttribute("data-theme", t);
  else    document.body.removeAttribute("data-theme");
  document.querySelectorAll(".theme-btn").forEach(b =>
    b.classList.toggle("active", (b.dataset.theme || "") === (t || ""))
  );
  localStorage.setItem(THEME_KEY, t || "");
}

document.querySelectorAll(".theme-btn").forEach(b =>
  b.addEventListener("click", () => applyTheme(b.dataset.theme || ""))
);

// ---------- wiring ----------

els.toggleBtn.addEventListener("click", () => listening ? stop() : start());
els.saveBtn.addEventListener("click", saveCfg);

// auto-save when user leaves any config field
[els.apiKey, els.oscHost, els.oscPort, els.sttAddr, els.llmAddr, els.prompt]
  .forEach(el => el.addEventListener("blur", () => saveCfg()));
// device picker auto-saves on change (no blur needed for <select>)
els.micSelect.addEventListener("change", () => saveCfg());
// keep the picker up to date when devices are plugged/unplugged
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", refreshMicList);
}
[els.oscHost, els.oscPort].forEach(el =>
  el.addEventListener("input", () => {
    els.oscTarget.textContent = `${els.oscHost.value}:${els.oscPort.value}`;
  })
);

// clock
setInterval(() => {
  const d = new Date();
  els.clock.textContent = d.toTimeString().slice(0, 8);
}, 1000);

// init
(async function init() {
  // restore theme before anything renders visibly
  applyTheme(localStorage.getItem(THEME_KEY) || "");
  buildMicMeter();
  await refreshMicList();
  const cfg = (await loadCfg()) || {};
  if (!cfg.system_prompt) cfg.system_prompt = DEFAULT_SYSTEM_PROMPT;
  applyCfg(cfg);
})();
