"use strict";
// Kitty Open Studio model installer page. Plain JS, no build step.

const GROUPS = [
  ["speed", "Instant scene + sound (FastH3 Omni)"],
  ["video", "Video, talking, VFX, character swap"],
  ["image", "Image and edit"],
  ["upscale", "Upscale and utilities"],
  ["voice", "Voice"],
  ["music", "Music"],
];
const state = { catalog: null, selected: new Set(), polling: null, profile: null };
const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function gb(bytes) {
  if (!bytes) return "?";
  const v = bytes / 1e9;
  return v >= 10 ? `${v.toFixed(0)} GB` : `${v.toFixed(1)} GB`;
}
async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

async function load() {
  const profile = state.profile ? `?gpu_profile=${encodeURIComponent(state.profile)}` : "";
  state.catalog = await api(`/api/catalog${profile}`);
  state.profile = state.catalog.gpu_profile;
  $("#profile").value = state.profile;
  $("#models-dir").textContent = state.catalog.models_dir;
  $("#free").textContent = state.catalog.free_bytes == null
    ? "unknown here (a network volume: its size is what you chose in Runpod)"
    : gb(state.catalog.free_bytes) + " free";
  $("#token").innerHTML = state.catalog.hf_token_set
    ? '<span class="chip ok">HF_TOKEN is set</span>'
    : '<span class="chip warn">not set</span> <span class="muted">needed only for gated models (LTX 2.5, FLUX 3 Klein)</span>';
  renderGated();
  renderPresets();
  renderModels();
  updateSummary();
}

// Gated models (LTX 2.5): Hugging Face serves them only after you accept their license on the model page,
// logged in to the account whose read token is in HF_TOKEN. Everything else downloads without that.
function gatedSources() {
  return [...new Set(state.catalog.models.filter((m) => m.gated && m.source).map((m) => m.source))];
}
function licenseLinks() {
  return gatedSources().map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace("https://huggingface.co/", ""))} ↗</a>`).join(", ");
}
function renderGated() {
  const links = licenseLinks();
  $("#gated").innerHTML = links
    ? `Gated models: accept the license on ${links} with the Hugging Face account of your token, then install. Without it those files fail with "access denied"; everything else downloads anyway.`
    : "";
}

function presetModels(p) {
  const wfs = p.workflows.includes("*") ? state.catalog.workflows.map((w) => w.id) : p.workflows;
  const ids = new Set();
  for (const w of state.catalog.workflows) if (wfs.includes(w.id)) w.models.forEach((m) => ids.add(m));
  return ids;
}

function renderPresets() {
  const byId = Object.fromEntries(state.catalog.models.map((m) => [m.id, m]));
  $("#presets").innerHTML = state.catalog.presets.map((p) => {
    const ids = presetModels(p);
    const size = [...ids].reduce((a, i) => a + (byId[i]?.size_bytes || 0), 0);
    return `<button class="card preset" type="button" data-preset="${esc(p.id)}">
      <div class="row between"><strong>${esc(p.title)}</strong><span class="size">${gb(size)}</span></div>
      <p>${esc(p.summary)}</p></button>`;
  }).join("");
  document.querySelectorAll("[data-preset]").forEach((el) => el.addEventListener("click", () => {
    const p = state.catalog.presets.find((x) => x.id === el.dataset.preset);
    state.selected = presetModels(p);
    renderModels();
    updateSummary();
  }));
}

function workflowTitles(ids) {
  const t = Object.fromEntries(state.catalog.workflows.map((w) => [w.id, w.title]));
  return ids.map((i) => t[i] || i);
}

function renderModels() {
  const q = $("#filter").value.trim().toLowerCase();
  const html = GROUPS.map(([group, title]) => {
    const models = state.catalog.models.filter((m) => m.group === group).filter((m) => {
      if (!q) return true;
      return (m.filename + " " + workflowTitles(m.workflows).join(" ")).toLowerCase().includes(q);
    });
    if (!models.length) return "";
    const cards = models.map((m) => {
      const chips = [];
      if (m.installed) chips.push('<span class="chip ok">installed</span>');
      if (m.auto_download) chips.push('<span class="chip">fetched by its node</span>');
      if (m.gated) {
        chips.push('<span class="chip warn">needs HF_TOKEN</span>');
        chips.push(`<a class="chip warn" href="${esc(m.source)}" target="_blank" rel="noopener">accept the license ↗</a>`);
      }
      const nc = m.license_kind === "non-commercial" ? " nc" : "";
      chips.push(`<a class="chip${nc}" href="${esc(m.source)}" target="_blank" rel="noopener">${esc(m.license)}</a>`);
      chips.push(`<span class="chip">${esc(m.folder)}</span>`);
      return `<label class="card model">
        <input type="checkbox" data-model="${esc(m.id)}" ${state.selected.has(m.id) ? "checked" : ""}>
        <span class="name">${esc(m.filename)}</span><span class="size">${gb(m.size_bytes)}</span>
        <span class="meta">${chips.join("")}</span>
        <span class="wfs">${esc(workflowTitles(m.workflows).join(" · "))}</span>
      </label>`;
    }).join("");
    return `<h3>${esc(title)}</h3><div class="models">${cards}</div>`;
  }).join("");
  $("#groups").innerHTML = html || '<p class="muted">No model matches the filter.</p>';
  document.querySelectorAll("[data-model]").forEach((el) => el.addEventListener("change", () => {
    if (el.checked) state.selected.add(el.dataset.model); else state.selected.delete(el.dataset.model);
    updateSummary();
  }));
}

let estimateTimer = null;
function updateSummary() {
  const n = state.selected.size;
  $("#sum-count").textContent = `${n} model${n === 1 ? "" : "s"}`;
  $("#install").disabled = n === 0;
  clearTimeout(estimateTimer);
  if (!n) {
    $("#sum-size").textContent = "0 GB";
    $("#sum-volume").textContent = "";
    $("#sum-cost").textContent = "";
    $("#sum-space").classList.add("hidden");
    return;
  }
  estimateTimer = setTimeout(async () => {
    try {
      const est = await api("/api/estimate", { models: [...state.selected], gpu_profile: state.profile });
      $("#sum-size").textContent = `${est.total_gb} GB (${est.to_download_gb} GB to download)`;
      $("#sum-volume").textContent = `volume: ${est.recommended_volume_gb} GB recommended`;
      $("#sum-cost").textContent = `≈ $${est.monthly_cost_usd.toFixed(2)}/month on a Runpod network volume`;
      $("#sum-cost").title = est.price_note;
      // same rule as the server's space check: what is still missing + 2 GiB margin
      const free = state.catalog.free_bytes;
      const short = free && est.to_download_gb * 1e9 + 2 * 1024 ** 3 > free;
      const gated = (est.needs_hf_token || []).length;
      $("#sum-space").innerHTML = short ? esc(`Only ${gb(free)} free here: grow the volume or pick fewer models`)
        : gated ? `${gated} gated file(s): accept the license first on ${licenseLinks()}` : "";
      $("#sum-space").classList.toggle("hidden", !short && !gated);
    } catch (e) {
      $("#sum-size").textContent = e.message;
    }
  }, 150);
}

async function install() {
  $("#install").disabled = true;
  try {
    await api("/api/install", { models: [...state.selected], gpu_profile: state.profile, only_missing: $("#only-missing").checked });
    $("#progress-panel").classList.remove("hidden");
    $("#progress-panel").scrollIntoView({ behavior: "smooth" });
    poll();
  } catch (e) {
    alert(e.message);
    $("#install").disabled = false;
  }
}

function renderProgress(p) {
  const pct = p.total ? (100 * p.done) / p.total : 0;
  $("#overall span").style.width = `${pct.toFixed(1)}%`;
  $("#job-message").textContent = p.message || (p.state === "running" ? `${pct.toFixed(1)}% of ${gb(p.total)}` : p.state);
  $("#job-message").className = p.state === "error" ? "error-box" : "muted";
  $("#files").innerHTML = p.files.map((f) => {
    const fp = f.total ? (100 * f.done) / f.total : (f.status === "done" ? 100 : 0);
    const speed = f.status === "downloading" && f.speed ? ` · ${(f.speed / 1e6).toFixed(1)} MB/s` : "";
    const label = f.status === "downloading" ? `${fp.toFixed(1)}% of ${gb(f.total)}${speed}` : `${f.status}${f.message ? " · " + f.message : ""}`;
    return `<div class="file ${esc(f.status)}"><span class="mono">${esc(f.filename)}</span><span class="state">${esc(label)}</span>
      <div class="bar"><span style="width:${fp.toFixed(1)}%"></span></div></div>`;
  }).join("");
}

function poll() {
  clearInterval(state.polling);
  state.polling = setInterval(async () => {
    const p = await api("/api/progress").catch(() => null);
    if (!p) return;
    renderProgress(p);
    if (p.state !== "running") {
      clearInterval(state.polling);
      $("#install").disabled = state.selected.size === 0;
      load();
    }
  }, 1500);
}

// The volume setup (ComfyUI, node packs, Python venv) runs next to this page on a pod's first start.
const SETUP_TITLES = {
  running: "Preparing ComfyUI on your volume…",
  done: "ComfyUI is ready",
  error: "The ComfyUI setup failed",
};
async function pollSetup() {
  const s = await api("/api/status").then((r) => r.setup).catch(() => null);
  const box = $("#setup");
  if (!s || !s.state) { box.classList.add("hidden"); return; }
  const quiet = s.state === "done" && !(s.warnings || []).length;
  box.classList.toggle("hidden", quiet);
  box.classList.toggle("error", s.state === "error");
  $("#setup-title").textContent = SETUP_TITLES[s.state] || s.state;
  $("#setup-step").textContent = s.state === "running" ? s.step : "";
  $("#setup-message").textContent = s.state === "running"
    ? "First start only: 30-60 minutes on a Runpod network volume. You can already download models below; ComfyUI starts when this is done."
    : (s.message || "");
  $("#setup-warnings").innerHTML = (s.warnings || []).map((w) => `<li>${esc(w)}</li>`).join("");
  if (s.state === "running") setTimeout(pollSetup, 5000);
}

$("#install").addEventListener("click", install);
$("#cancel").addEventListener("click", () => api("/api/cancel", {}));
$("#select-none").addEventListener("click", () => { state.selected.clear(); renderModels(); updateSummary(); });
$("#filter").addEventListener("input", renderModels);
$("#profile").addEventListener("change", (e) => { state.profile = e.target.value; load(); });

pollSetup();
load().then(async () => {
  const p = await api("/api/progress").catch(() => null);
  if (p && p.state !== "idle") { $("#progress-panel").classList.remove("hidden"); renderProgress(p); if (p.state === "running") poll(); }
}).catch((e) => { document.body.insertAdjacentHTML("afterbegin", `<p class="error-box">Could not load the catalog: ${esc(e.message)}</p>`); });
