"use strict";

const ui = {
  frameCursor: 0,
  infoCursor: 0,
  traceCursor: 0,
  logEpoch: null,
  infoEpoch: null,
  traceEpoch: null,
  frames: [],
  helperKey: "",
  history: [],
  hist: -1,
  draft: "",
  trace: [],
  phaseSeen: false,
  latest: null,
  help: [],
  cmpRows: [],
};

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

async function act(msg) {
  const res = await fetch("/api/act", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
  const body = await res.json();
  if (body && body.shutdown) window.close();
  return body;
}

function download(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function hexByte(n) {
  return Number(n).toString(16).toUpperCase().padStart(2, "0");
}

function hexIndex(n) {
  return Number(n).toString(16).toUpperCase().padStart(4, "0");
}

function visible(frame, filters) {
  if (!filters || !filters[frame.type]) return false;
  if (frame.dir === "tx" && !filters.tx) return false;
  return true;
}

function formatObj(obj) {
  if (obj.value == null || Number.isNaN(obj.value)) return "";
  if (obj.typeName === "VISIBLE_STRING") return String(obj.value);
  if (obj.typeName === "REAL32") return Number(obj.value).toString();
  if (obj.enum) {
    const hit = obj.enum.find((item) => item.v === Number(obj.value));
    if (hit) return hit.t;
  }
  if (obj.unit) return obj.value + " " + obj.unit;
  const width = obj.typeName.endsWith("8") || obj.typeName === "BOOLEAN" ? 2 : obj.typeName.endsWith("16") ? 4 : 8;
  return obj.value + " (0x" + (Number(obj.value) >>> 0).toString(16).toUpperCase().padStart(width, "0") + ")";
}

function editorText(obj) {
  if (obj.typeName === "VISIBLE_STRING" || obj.typeName === "REAL32") return String(obj.value ?? "");
  if (obj.unit || String(obj.typeName).startsWith("INTEGER")) return String(obj.value ?? "");
  const width = obj.typeName.endsWith("8") || obj.typeName === "BOOLEAN" ? 2 : obj.typeName.endsWith("16") ? 4 : 8;
  return "0x" + (Number(obj.value) >>> 0).toString(16).toUpperCase().padStart(width, "0");
}

async function poll() {
  const q = new URLSearchParams({
    frame: String(ui.frameCursor),
    info: String(ui.infoCursor),
    trace: String(ui.traceCursor),
  });
  if (ui.logEpoch != null) q.set("logEpoch", String(ui.logEpoch));
  if (ui.infoEpoch != null) q.set("infoEpoch", String(ui.infoEpoch));
  if (ui.traceEpoch != null) q.set("traceEpoch", String(ui.traceEpoch));
  const res = await fetch("/api/state?" + q.toString());
  const snap = await res.json();
  ui.latest = snap;
  renderStatus(snap);
  renderFrames(snap);
  renderInfo(snap);
  renderHelper(snap);
  renderTrace(snap);
  renderOpenDialog(snap);
}

function renderStatus(s) {
  $("prompt").textContent = s.prompt;
  const found = s.helperMode === "online";
  const running = found && s.nmtName === "Operational";
  const spinning = running && s.driveState === "operation enabled" && Math.abs(s.live.velocityRpm) > 20;
  const main = $("st-main");
  if (!s.busOn) {
    main.textContent = "The CAN bus is stopped";
    main.className = "bad";
  } else if (s.adapter !== "ixxat" && spinning) {
    main.textContent = `Shaft is turning at ${s.live.velocityRpm.toFixed(0)} rpm`;
    main.className = "ok";
  } else if (s.adapter !== "ixxat" && running) {
    main.textContent = `Controller ${s.selectedNode} is ready. Set a speed to spin the shaft.`;
    main.className = "ok";
  } else if (s.adapter === "ixxat" && found) {
    const state = s.nmtName === "IXXAT connected" ? "" : " " + s.nmtName + ".";
    main.textContent = `Controller ${s.selectedNode} answered on the IXXAT adapter at ${s.baud} kbit/s.${state}`;
    main.className = "ok";
  } else if (s.adapter === "ixxat") {
    const who = s.adapterName ? ` — ${s.adapterName}` : "";
    main.textContent = `IXXAT is on at ${s.baud} kbit/s${who}. Find the controller, or watch the CAN log.`;
    main.className = "ok";
  } else if (found) {
    main.textContent = `Controller ${s.selectedNode} answered. Allow the drive to run.`;
    main.className = "ok";
  } else {
    main.textContent = `Bus is on at ${s.baud} kbit/s. Find the controller to begin.`;
    main.className = "ok";
  }
  main.title = `${s.adapter === "ixxat" ? "IXXAT" : "Practice"} · ${s.nmtName} · node ${s.selectedNode} · ${s.baud} kbit/s`;
  const pillNames = {
    "Helper is offline": "Not connected yet",
    "Pre-operational": "Connected, paused",
    "Operational": "Ready to spin",
    "Stopped": "Connected, stopped",
    "CAN stopped": "Bus is stopped",
    "IXXAT connected": "On the IXXAT adapter",
    "Boot-up": "Controller is starting",
    "DCF editor": "Editing a settings file",
    "DCF unsaved changes": "Unsaved settings",
  };
  $("g1").classList.toggle("done", found);
  $("g2").classList.toggle("done", running);
  $("g3").classList.toggle("done", spinning);
  $("g4").classList.toggle("done", ui.phaseSeen);
  $("st-helper").textContent = pillNames[s.helperStatus] || s.helperStatus;
  $("st-progress").textContent = s.progress || "";
  $("st-cli").classList.toggle("on", s.cli);
  $("cli-btn").classList.toggle("on", s.cli);
  document.querySelectorAll(".baud").forEach((btn) => btn.classList.toggle("on", Number(btn.dataset.baud) === s.baud));
  document.querySelectorAll("#filters button").forEach((btn) => btn.classList.toggle("on", !!s.filters[btn.dataset.filter]));
  const pill = $("node-pill");
  pill.textContent = pillNames[s.helperStatus] || s.helperStatus;
  pill.title = s.helperStatus;
  pill.className = "";
  if (s.helperMode === "online" && s.nmtName === "Operational") pill.classList.add("op");
  else if (s.helperMode === "online" && s.nmtName === "Pre-operational") pill.classList.add("pre");
  else if (s.helperStatus === "DCF unsaved changes" || s.driveState === "fault") pill.classList.add(s.driveState === "fault" ? "bad" : "dirty");
  const op = $("op-btn");
  if (s.helperMode === "online") {
    op.hidden = false;
    op.textContent = s.nmtName === "Operational" ? "Pause the drive" : "Allow the drive to run";
  } else op.hidden = true;
  $("node-id").value = document.activeElement === $("node-id") ? $("node-id").value : s.selectedNode;
  document.body.classList.toggle("level-op", s.accessLevel === "operator");
  const bar = $("update-bar");
  if (bar) {
    const offer = s.update;
    const show = offer && offer.version && !ui.updateLater;
    bar.hidden = !show;
    if (show) $("update-text").textContent = "Version " + offer.version + " is ready to install.";
  }
  $("workspace").classList.toggle("hide-helper", s.panels && s.panels.helper === false);
  $("left").classList.toggle("hide-can", s.panels && s.panels.can === false);
  $("left").classList.toggle("hide-info", s.panels && s.panels.info === false);
  $("left").classList.toggle("hide-command", s.panels && s.panels.command === false);
}

function renderFrames(s) {
  if (s.logEpoch !== ui.logEpoch) {
    ui.logEpoch = s.logEpoch;
    ui.frames = s.frames.slice();
  } else if (s.frames.length) {
    ui.frames.push(...s.frames);
    if (ui.frames.length > 800) ui.frames.splice(0, ui.frames.length - 800);
  }
  ui.frameCursor = s.frameCursor;
  paintCan(s.filters);
}

function paintCan(filters) {
  const rows = ui.frames.filter((frame) => visible(frame, filters));
  const logOn = document.querySelector('[data-cantab="log"]').classList.contains("on");
  const body = logOn ? $("can-body") : $("can-msg-body");
  const wrap = body.parentElement;
  const stick = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 28;
  const previous = wrap.scrollTop;
  if (logOn) {
    body.innerHTML = rows.slice(-500).map((frame) => {
      const id = frame.ext ? frame.id.toString(16).toUpperCase().padStart(8, "0") : frame.id.toString(16).toUpperCase().padStart(3, "0");
      const bytes = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<td>${frame.data[i] == null ? "" : hexByte(frame.data[i])}</td>`).join("");
      return `<tr class="${esc(frame.type)} ${frame.dir}"><td>${frame.dir === "tx" ? "» " : ""}0x${id}</td><td>${frame.t.toFixed(3)}</td><td>${esc(frame.type.toUpperCase())}</td>${bytes}</tr>`;
    }).join("");
  } else {
    body.innerHTML = rows.slice(-500).map((frame) => `<tr class="${esc(frame.type)}"><td>${frame.t.toFixed(3)}</td><td>${esc(frame.type.toUpperCase())}</td><td>${esc(frame.text)}</td></tr>`).join("");
  }
  const place = () => {
    if (stick) wrap.scrollTop = wrap.scrollHeight;
    else wrap.scrollTop = previous;
  };
  place();
  requestAnimationFrame(place);
}

function renderInfo(s) {
  const log = $("info-log");
  if (s.infoEpoch !== ui.infoEpoch) {
    ui.infoEpoch = s.infoEpoch;
    log.innerHTML = "";
  }
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
  for (const line of s.info) {
    const div = document.createElement("div");
    div.className = line.level || "info";
    div.textContent = line.text;
    log.appendChild(div);
  }
  while (log.childNodes.length > 800) log.removeChild(log.firstChild);
  ui.infoCursor = s.infoCursor;
  if (stick) log.scrollTop = log.scrollHeight;
}

function renderHelper(s) {
  const offline = s.helperMode === "offline";
  const key = s.helperMode + ":" + s.dictEpoch;
  $("offline-view").classList.toggle("hidden", !offline);
  $("online-view").classList.toggle("hidden", offline);
  if (ui.helperKey !== key) {
    ui.helperKey = key;
    if (offline) {
      $("tree").innerHTML = "<p class='note'>Ping a node or open a DCF file.</p>";
      $("io-list").innerHTML = "";
      $("pdo-list").innerHTML = "";
      return;
    }
    buildLists(s.objects);
    buildMainActions(s);
  }
  if (!offline) {
    updateValues(s);
    updateMainText(s);
  }
}

function buildMainActions(s) {
  $("main-actions").innerHTML = "";
  $("gauges").className = "gauge-row";
  if (s.helperMode === "dcf") {
    $("gauges").innerHTML = "";
    addAction("Save the file", saveDcf);
    addAction("Close the file", () => act({ type: "closeDcf" }));
    addAction("Send these settings to the controller", () => act({ type: "sendDcf" }));
    return;
  }
  addAction("Set up this inverter", () => openDialog("dlg-setup"));
  addAction("Save these settings to a file", () => act({ type: "pullDcf" }));
  addAction("Spin the shaft", () => openDialog("dlg-402"));
  addAction("Check the 3 phases", () => openDialog("dlg-phases"));
  addAction("Graph this run", () => openDialog("dlg-trace"));
}

function updateMainText(s) {
  if (s.helperMode === "dcf") {
    $("identity").textContent = `${s.dcfName || "untitled.dcf"}${s.dcfDirty ? "  ·  unsaved changes" : ""}\n${s.objects.length} objects`;
    return;
  }
  const live = s.live;
  $("identity").textContent = [
    live.name + "   software " + live.swText,
    "Serial " + live.serial + "   " + s.driveState,
    "Statusword 0x" + (live.statusword >>> 0).toString(16).toUpperCase().padStart(4, "0"),
    live.faultCode ? "Fault: " + live.faultText + (live.faultCheck ? "\n" + live.faultCheck : "") : "No fault",
  ].join("\n");
  const plate = nameplateFrom(s);
  $("nameplate-card").textContent = plate
    ? `${plate.name}\n${plate.poles} pole pairs · ${plate.amps} A · ${plate.volts} V DC · ${plate.rpm} rpm · encoder ${plate.ppr}`
    : "";
  const values = [live.velocityRpm.toFixed(0), live.torquePct.toFixed(1), live.currentA.toFixed(1), live.vdcV.toFixed(1), live.tempM.toFixed(1), live.tempC.toFixed(1)];
  const units = ["rpm", "%", "A", "V", "°C", "°C"];
  const names = ["Speed", "Torque", "Current", "DC link", "Motor", "Controller"];
  if ($("gauges").childElementCount !== names.length) {
    $("gauges").innerHTML = names.map((name, i) => `<div class="gauge"><span>${name}</span><b>${values[i]}</b><span>${units[i]}</span></div>`).join("");
  } else {
    $("gauges").querySelectorAll("b").forEach((node, i) => { node.textContent = values[i]; });
  }
}

function addAction(label, fn) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", fn);
  $("main-actions").appendChild(btn);
}

function buildLists(objects) {
  const groups = new Map();
  for (const obj of objects) {
    const name = obj.group || "Other";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(obj);
  }
  $("tree").innerHTML = Array.from(groups.entries()).map(([name, list]) => {
    const rows = list.map(objectRow).join("");
    return `<details open><summary>${esc(name)} (${list.length})</summary>${rows}</details>`;
  }).join("");
  bindEditors($("tree"));
  const io = objects.filter((obj) => obj.index === 0x2002);
  $("io-list").innerHTML = io.length ? io.map(objectRow).join("") : "<p class='note'>This dictionary has no input objects.</p>";
  bindEditors($("io-list"));
  const pdo = objects.filter((obj) => [0x1400, 0x1600, 0x1800, 0x1a00].includes(obj.index));
  $("pdo-list").innerHTML = pdo.length ? pdo.map(objectRow).join("") : "<p class='note'>This dictionary has no PDO objects.</p>";
  bindEditors($("pdo-list"));
}

function objectRow(obj) {
  const key = obj.index + ":" + obj.sub;
  const search = (hexIndex(obj.index) + " " + obj.name + " " + (obj.unit || "")).toLowerCase();
  let editor;
  if (!obj.writable) editor = `<span class="val" data-k="${key}">${esc(formatObj(obj))}</span>`;
  else if (obj.enum) {
    editor = `<select data-k="${key}" data-index="${obj.index}" data-sub="${obj.sub}">${obj.enum.map((item) => `<option value="${item.v}" ${Number(obj.value) === item.v ? "selected" : ""}>${esc(item.t)}</option>`).join("")}</select>`;
  } else {
    editor = `<input data-k="${key}" data-index="${obj.index}" data-sub="${obj.sub}" data-raw="${esc(editorText(obj))}" value="${esc(editorText(obj))}">`;
  }
  return `<div class="obj" data-search="${esc(search)}"><span class="idx">0x${hexIndex(obj.index)}:${obj.sub}</span><span>${esc(obj.name)}</span>${editor}<span class="mono">${esc(obj.access)}${obj.unit ? " · " + esc(obj.unit) : ""}</span></div>`;
}

function bindEditors(root) {
  root.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("change", () => commitEditor(el));
  });
}

async function commitEditor(el) {
  const msg = {
    index: Number(el.dataset.index),
    sub: Number(el.dataset.sub),
    value: el.value,
  };
  msg.type = ui.latest && ui.latest.helperMode === "dcf" ? "editDcf" : "write";
  const result = await act(msg);
  if (!result.ok && el.dataset.raw != null) el.value = el.dataset.raw;
  else if (el.dataset.raw != null) el.dataset.raw = el.value;
}

function updateValues(s) {
  const map = new Map(s.objects.map((obj) => [obj.index + ":" + obj.sub, obj]));
  document.querySelectorAll("[data-k]").forEach((el) => {
    const obj = map.get(el.dataset.k);
    if (!obj || el === document.activeElement) return;
    if (el.tagName === "INPUT") {
      const next = editorText(obj);
      if (el.value !== next) el.value = next;
      el.dataset.raw = next;
    } else if (el.tagName === "SELECT") {
      if (el.value !== String(obj.value)) el.value = String(obj.value);
    } else el.textContent = formatObj(obj);
  });
}

function renderTrace(s) {
  if (s.trace.epoch !== ui.traceEpoch) {
    ui.traceEpoch = s.trace.epoch;
    ui.trace = s.trace.points.slice();
  } else if (s.trace.points.length) ui.trace.push(...s.trace.points);
  if (ui.trace.length > 800) ui.trace.splice(0, ui.trace.length - 800);
  ui.traceCursor = s.trace.cursor;
  const canvas = $("trace-canvas");
  if (!$("dlg-trace").open) return;
  drawTrace(canvas, ui.trace);
  $("tr-state").textContent = s.trace.armed ? ui.trace.length + " samples, armed" : ui.trace.length + " samples";
}

function drawTrace(canvas, points) {
  const width = canvas.clientWidth || 860;
  const height = 280;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#071428";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#1c3d66";
  ctx.strokeRect(40, 10, width - 50, height - 30);
  if (points.length < 2) {
    ctx.fillStyle = "#9eb0c9";
    ctx.fillText("Arm the trace, enable the drive, and set a speed.", 50, 40);
    return;
  }
  const series = [
    { key: "velocity", color: "#9ecbff", scale: 6000 },
    { key: "torque", color: "#f0c27a", scale: 100 },
    { key: "current", color: "#8ee0b0", scale: 400 },
  ];
  const left = 40;
  const plotW = width - 50;
  const plotH = height - 30;
  for (const line of series) {
    ctx.beginPath();
    ctx.strokeStyle = line.color;
    points.forEach((point, i) => {
      const x = left + (i / (points.length - 1)) * plotW;
      const y = 10 + plotH - (Math.max(-line.scale, Math.min(line.scale, point[line.key])) / line.scale) * (plotH / 2) - plotH / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.fillStyle = "#9ecbff";
  ctx.fillText("speed", 48, 24);
  ctx.fillStyle = "#f0c27a";
  ctx.fillText("torque %", 100, 24);
  ctx.fillStyle = "#8ee0b0";
  ctx.fillText("current A", 170, 24);
}

function renderOpenDialog(s) {
  if ($("dlg-vehicle").open) {
    const rows = ui.frames.filter((frame) => visible(frame, s.filters)).slice(-200);
    $("veh-log").innerHTML = "<table><tbody>" + rows.map((frame) => `<tr><td>${frame.t.toFixed(3)}</td><td>${esc(frame.text)}</td></tr>`).join("") + "</tbody></table>";
    $("rec-state").textContent = s.recording ? "Recording " + s.recordCount + " frames" : "Not recording";
  }
  if ($("dlg-402").open) {
    $("dem-live").textContent = `Drive is ${s.driveState}. Shaft ${s.live.velocityRpm.toFixed(0)} rpm, torque ${s.live.torquePct.toFixed(1)} %.`;
  }
  if ($("dlg-faults").open) {
    $("fault-live").textContent = s.live.faultCode
      ? s.live.faultText + (s.live.faultCheck ? " " + s.live.faultCheck : "")
      : "No active fault.";
    if (!$("fault-list").childElementCount && s.faults) {
      $("fault-list").innerHTML = s.faults.map((fault) => `<button type="button" data-fault="${fault.code}">${esc(fault.text)}. ${esc(fault.check || "")}</button>`).join("");
      $("fault-list").querySelectorAll("button").forEach((btn) => btn.addEventListener("click", () => act({ type: "fault", code: btn.dataset.fault })));
    }
  }
}

function objectValue(s, index, sub) {
  const hit = (s.objects || []).find((obj) => obj.index === index && obj.sub === sub);
  return hit ? hit.value : undefined;
}

function nameplateFrom(s) {
  if (!s) return null;
  const poles = objectValue(s, 0x2000, 1);
  if (poles == null) return null;
  const ampsRaw = Number(objectValue(s, 0x2000, 2));
  const voltsRaw = Number(objectValue(s, 0x2000, 7));
  return {
    name: objectValue(s, 0x2000, 5) || "Motor",
    poles,
    amps: Number.isFinite(ampsRaw) ? (ampsRaw / 10) : "",
    volts: Number.isFinite(voltsRaw) ? (voltsRaw / 10) : "",
    rpm: objectValue(s, 0x2000, 3) || "",
    ppr: objectValue(s, 0x2000, 4) || "",
  };
}

const wiz = { step: 1, found: false, spinTried: false, spinOk: false, spinHardware: false, dirReady: false, direction: "" };

function showWizard(step) {
  wiz.step = step;
  for (let i = 1; i <= 5; i++) {
    $("wiz-" + i).classList.toggle("hidden", i !== step);
    const pip = document.querySelector(`#wiz-pips [data-wiz="${i}"]`);
    pip.classList.toggle("on", i === step);
    pip.classList.toggle("done", i < step);
  }
  $("wiz-back").hidden = step === 1;
  $("wiz-next").textContent = step === 5 ? "Close" : "Next";
  if (step === 1 && ui.latest && ui.latest.helperMode === "online") fillNameplateForm(ui.latest);
  if (step === 5) fillWizardSummary();
}

function fillNameplateForm(s) {
  const plate = nameplateFrom(s);
  if (!plate) return;
  $("np-name").value = plate.name;
  $("np-poles").value = plate.poles;
  $("np-amps").value = plate.amps;
  $("np-volts").value = plate.volts;
  $("np-rpm").value = plate.rpm;
  $("np-ppr").value = plate.ppr;
}

function readNameplateForm() {
  return {
    name: $("np-name").value.trim() || "Motor",
    poles: Math.round(Number($("np-poles").value)),
    amps: Number($("np-amps").value),
    volts: Number($("np-volts").value),
    rpm: Math.round(Number($("np-rpm").value)),
    ppr: Math.round(Number($("np-ppr").value)),
  };
}

async function applyNameplate() {
  const plate = readNameplateForm();
  if (!(plate.poles >= 1) || !(plate.amps >= 0) || !(plate.volts >= 0) || !(plate.rpm >= 1) || !(plate.ppr >= 1)) {
    throw new Error("Check the nameplate numbers.");
  }
  const writes = [
    [0x2000, 5, plate.name],
    [0x2000, 1, plate.poles],
    [0x2000, 2, Math.round(plate.amps * 10)],
    [0x2000, 3, plate.rpm],
    [0x2000, 4, plate.ppr],
    [0x2000, 7, Math.round(plate.volts * 10)],
    [0x2001, 2, Math.min(20000, plate.rpm)],
  ];
  for (const [index, sub, value] of writes) {
    const result = await act({ type: "write", index, sub, value });
    if (!result.ok) throw new Error(result.error || "The controller rejected a nameplate value.");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prepareDrive() {
  const node = Number($("node-id").value) || 1;
  const ping = await act({ type: "ping", node });
  if (!ping.ok) throw new Error("The controller did not answer. Check the number and the CAN lead.");
  await act({ type: "nmt", cmd: "start", node });
  const enable = await act({ type: "cia402", op: "enable" });
  if (!enable.ok) throw new Error(enable.error || "The drive did not enable.");
  await act({ type: "cia402", op: "mode", value: "pv" });
  return node;
}

async function runGuardedSpin() {
  $("wiz-spin-result").textContent = "Turning the shaft up to 100 rpm…";
  try {
    await prepareDrive();
    await act({ type: "cia402", op: "vel", value: 100 });
    await sleep(2200);
    await poll();
    const rpm = Math.abs(ui.latest.live.velocityRpm);
    await act({ type: "cia402", op: "vel", value: 0 });
    wiz.spinTried = true;
    if (ui.latest.live.faultCode) {
      wiz.spinOk = false;
      await act({ type: "cia402", op: "disable" });
      $("wiz-spin-result").textContent = `${ui.latest.live.faultText} ${ui.latest.live.faultCheck || ""}`.trim();
      return;
    }
    if (ui.latest.adapter === "ixxat") {
      wiz.spinHardware = true;
      $("wiz-spin-result").textContent = "The speed command was sent on the IXXAT adapter, then set back to zero. Watch the real shaft. The rpm gauge stays on the practice controller and does not follow this inverter. If the shaft did not turn, check the DC link, the three phase leads, and that the drive enabled.";
      return;
    }
    if (rpm < 15) {
      wiz.spinOk = false;
      await act({ type: "cia402", op: "disable" });
      $("wiz-spin-result").textContent = "The shaft did not move. Check the DC link voltage, that all three phase leads are tight, and that the drive is enabled. Then run this test again.";
      return;
    }
    wiz.spinOk = true;
    $("wiz-spin-result").textContent = `The shaft reached about ${rpm.toFixed(0)} rpm, then the speed command was set back to zero.`;
  } catch (err) {
    wiz.spinTried = true;
    wiz.spinOk = false;
    $("wiz-spin-result").textContent = err.message;
  }
}

async function runDirection() {
  $("wiz-dir-result").textContent = "Turning the shaft slowly. Watch which way it goes.";
  try {
    await prepareDrive();
    await act({ type: "cia402", op: "vel", value: 80 });
    await sleep(1800);
    await poll();
    const rpm = ui.latest.live.velocityRpm;
    await act({ type: "cia402", op: "vel", value: 0 });
    if (ui.latest.adapter === "ixxat") {
      wiz.dirReady = true;
      $("wiz-dir-result").textContent = "The slow turn was sent on the IXXAT adapter. Did the real shaft turn the way the vehicle needs?";
      return;
    }
    if (Math.abs(rpm) < 15) {
      wiz.dirReady = false;
      $("wiz-dir-result").textContent = "The shaft did not move, so the direction cannot be judged yet. Go back and run the slow test.";
      return;
    }
    wiz.dirReady = true;
    $("wiz-dir-result").textContent = `It was turning at about ${Math.abs(rpm).toFixed(0)} rpm. Did it turn the way the vehicle needs?`;
  } catch (err) {
    $("wiz-dir-result").textContent = err.message;
  }
}

function answerDirection(ok) {
  if (!wiz.dirReady) {
    $("wiz-dir-result").textContent = "Turn the shaft for the direction check first.";
    return;
  }
  wiz.direction = ok ? "correct" : "swap";
  phase.swap = !ok;
  const swapBtn = $("ph-swap");
  if (swapBtn) {
    swapBtn.classList.toggle("on", phase.swap);
    swapBtn.textContent = phase.swap ? "Put V and W back" : "Swap V and W";
  }
  $("wiz-yes").classList.toggle("on", ok);
  $("wiz-no").classList.toggle("on", !ok);
  $("wiz-dir-result").textContent = ok
    ? "Phase order is correct. Leave the V and W cables as they are."
    : "Exchange the V and W motor cables. The phase picture now shows that swapped order. After the cables are swapped, the shaft turns the other way.";
}

function fillWizardSummary() {
  const plate = readNameplateForm();
  const direction = wiz.direction === "swap"
    ? "Exchange motor cables V and W."
    : wiz.direction === "correct"
      ? "Phase order is correct."
      : "Direction was not confirmed.";
  const spin = wiz.spinHardware
    ? "Slow spin was sent on the IXXAT adapter. Confirm the shaft on the bench."
    : !wiz.spinTried ? "Slow spin was not run." : wiz.spinOk ? "Slow spin moved the shaft." : "Slow spin did not move the shaft.";
  $("wiz-summary").textContent = `${plate.name}\n${plate.poles} pole pairs, ${plate.amps} A, ${plate.volts} V DC, ${plate.rpm} rpm, encoder ${plate.ppr}.\n${spin}\n${direction}`;
}

async function saveWizard() {
  const plate = readNameplateForm();
  const direction = wiz.direction === "swap" ? "Swap V and W cables" : wiz.direction === "correct" ? "Phase order correct" : "Not confirmed";
  const text = [
    "Z-DVT Workbench setup",
    "Crafted by Z-Jomant Meister",
    "",
    "Motor: " + plate.name,
    "Pole pairs: " + plate.poles,
    "Rated current A: " + plate.amps,
    "Rated DC voltage V: " + plate.volts,
    "Top speed rpm: " + plate.rpm,
    "Encoder pulses per turn: " + plate.ppr,
    "Slow spin: " + (wiz.spinHardware ? "sent on the IXXAT adapter" : wiz.spinOk ? "shaft moved" : "shaft did not move or was not tested"),
    "Direction: " + direction,
    "Controller: " + (Number($("node-id").value) || 1),
  ].join("\r\n");
  download("z-dvt-setup.txt", text);
  const pulled = await act({ type: "pullDcf" });
  if (pulled && pulled.ok) {
    const saved = await act({ type: "saveDcf", writeThrough: false });
    if (saved && saved.text) download(saved.filename || "controller.dcf", saved.text);
  }
  $("wiz-save-result").textContent = "Saved the setup sheet and the controller settings file.";
}

function wizardNext() {
  if (wiz.step === 1) {
    const plate = readNameplateForm();
    if (!(plate.poles >= 1) || !(plate.rpm >= 1) || !(plate.ppr >= 1)) return;
    showWizard(2);
    return;
  }
  if (wiz.step === 2 && !wiz.found) {
    $("wiz-find-result").textContent = "Find the controller before leaving this step.";
    return;
  }
  if (wiz.step === 3 && !wiz.spinTried) {
    $("wiz-spin-result").textContent = "Run the slow test before leaving this step.";
    return;
  }
  if (wiz.step === 4 && !wiz.direction) {
    $("wiz-dir-result").textContent = "Answer the direction question before leaving this step.";
    return;
  }
  if (wiz.step === 5) {
    $("dlg-setup").close();
    return;
  }
  showWizard(wiz.step + 1);
}

function openDialog(id) {
  const dlg = $(id);
  if (!dlg.open) dlg.showModal();
  if (id === "dlg-phases") startPhase();
  if (id === "dlg-setup") showWizard(1);
}

const phase = { lock: null, swap: false, theta: 0, last: 0, frame: 0 };

function startPhase() {
  ui.phaseSeen = true;
  $("g4").classList.add("done");
  if (phase.frame) return;
  phase.last = performance.now();
  phase.frame = requestAnimationFrame(phaseTick);
}

function phaseTick(now) {
  if (!$("dlg-phases").open) {
    phase.frame = 0;
    return;
  }
  phase.frame = requestAnimationFrame(phaseTick);
  const dt = Math.min(0.05, (now - phase.last) / 1000 || 0.016);
  phase.last = now;
  let rpm = 90;
  let following = false;
  if ($("ph-follow").checked && ui.latest && ui.latest.driveState === "operation enabled" && Math.abs(ui.latest.live.velocityRpm) > 8) {
    rpm = ui.latest.live.velocityRpm;
    following = true;
  }
  if (!phase.lock) phase.theta += rpm * 2 * Math.PI / 60 * dt;
  const seq = phase.swap ? -1 : 1;
  let iU;
  let iV;
  let iW;
  let rotor;
  if (phase.lock === "U") { iU = 1; iV = 0; iW = 0; rotor = 0; }
  else if (phase.lock === "V") { iU = 0; iV = 1; iW = 0; rotor = 120; }
  else if (phase.lock === "W") { iU = 0; iV = 0; iW = 1; rotor = 240; }
  else {
    const theta = phase.theta;
    iU = Math.cos(theta);
    iV = Math.cos(theta - seq * 2 * Math.PI / 3);
    iW = Math.cos(theta + seq * 2 * Math.PI / 3);
    rotor = seq * theta * 180 / Math.PI;
  }
  paintPhase(iU, iV, iW, rotor, rpm, seq, following);
}

function paintPhase(iU, iV, iW, rotor, rpm, seq, following) {
  const lights = { u: iU, v: iV, w: iW };
  for (const name of ["u", "v", "w"]) {
    const coil = document.querySelector(`#coil-${name} .coil-body`);
    const amount = Math.max(0, lights[name]);
    const colors = { u: "126,182,255", v: "240,194,122", w: "142,224,176" };
    coil.setAttribute("fill", `rgba(${colors[name]},${(0.28 + amount * 0.72).toFixed(3)})`);
    $(`bar-${name}`).style.width = `${Math.round(amount * 100)}%`;
  }
  $("rotor-spin").setAttribute("transform", `rotate(${rotor.toFixed(2)} 170 170)`);
  const clockwise = (rpm >= 0 ? 1 : -1) * seq > 0;
  $("arrow-cw").setAttribute("opacity", !phase.lock && clockwise ? "1" : "0");
  $("arrow-ccw").setAttribute("opacity", !phase.lock && !clockwise ? "1" : "0");
  const brightest = [["U", iU], ["V", iV], ["W", iW]].sort((a, b) => b[1] - a[1])[0];
  const nowLit = brightest[1] > 0.55 ? `${brightest[0]} is brightest right now. ` : "";
  const order = phase.swap ? "U → W → V" : "U → V → W";
  let motion;
  if (phase.lock) motion = `Only phase ${phase.lock} is energized, so the shaft is pulled to ${phase.lock}.`;
  else if (Math.abs(rpm) < 1) motion = "The shaft is stopped.";
  else motion = `The shaft turns ${clockwise ? "clockwise" : "counter-clockwise"} at about ${Math.abs(rpm).toFixed(0)} rpm.`;
  const source = following ? "Speed is coming from the bench." : "This is a preview spin. Start the bench to use the real shaft speed.";
  const swap = phase.swap ? "V and W are swapped, so the field runs backwards." : "Swap V and W if the real motor turns the wrong way.";
  $("phase-readout").textContent = `${nowLit}Lighting order ${order}. ${motion} ${source} ${swap}`;
}

function setPhaseLock(lock) {
  phase.lock = lock;
  for (const id of ["ph-u", "ph-v", "ph-w", "ph-run"]) $(id).classList.remove("on");
  if (lock === "U") $("ph-u").classList.add("on");
  else if (lock === "V") $("ph-v").classList.add("on");
  else if (lock === "W") $("ph-w").classList.add("on");
  else $("ph-run").classList.add("on");
}

function closeMenus() {
  document.querySelectorAll(".menu.open").forEach((menu) => menu.classList.remove("open"));
}

async function runCommand(text) {
  const line = text.trim();
  if (!line) return;
  ui.history.push(line);
  ui.hist = ui.history.length;
  const row = document.createElement("div");
  row.textContent = ($("prompt").textContent || "dvt % ") + line;
  $("cmd-log").appendChild(row);
  $("cmd-log").scrollTop = $("cmd-log").scrollHeight;
  await act({ type: "command", text: line });
}

async function saveDcf() {
  const result = await act({ type: "saveDcf", writeThrough: true });
  if (result && result.ok && result.text) download(result.filename || "controller.dcf", result.text);
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function parseBytes(text) {
  const clean = String(text).replace(/0x/gi, " ").replace(/[^0-9a-f]/gi, "");
  if (!clean.length || clean.length % 2) throw new Error("Data must be hex bytes");
  const data = [];
  for (let i = 0; i < clean.length; i += 2) data.push(parseInt(clean.slice(i, i + 2), 16));
  return data;
}

function coastTorque(text, inertia) {
  const rows = [];
  for (const line of String(text).split(/\n/)) {
    const parts = line.trim().split(/[\s,;]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const t = Number(parts[0]);
    const rpm = Number(parts[1]);
    if (Number.isFinite(t) && Number.isFinite(rpm)) rows.push({ t, rpm });
  }
  if (rows.length < 2) return "Need at least two rows of time and rpm.";
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i].t - rows[i - 1].t;
    if (dt <= 0) continue;
    const w1 = rows[i - 1].rpm * 2 * Math.PI / 60;
    const w2 = rows[i].rpm * 2 * Math.PI / 60;
    const torque = inertia * (w2 - w1) / dt;
    out.push(`${rows[i - 1].t.toFixed(3)} → ${rows[i].t.toFixed(3)} s    ${torque.toFixed(3)} N·m`);
  }
  const dt = rows[rows.length - 1].t - rows[0].t;
  const avg = inertia * ((rows[rows.length - 1].rpm - rows[0].rpm) * 2 * Math.PI / 60) / dt;
  return `Average ${avg.toFixed(3)} N·m over ${dt.toFixed(3)} s.\nA negative value means the shaft is slowing.\n\n` + out.join("\n");
}

const HELP = [
  ["What this is", "Z-DVT Workbench, crafted by Z-Jomant Meister, watches CAN, talks CANopen, edits settings files, and runs a motor on the bench. It does not load the IXXAT VCI4 Tcl DLL, so the license error in DVT Customer 2025.05b does not apply. A practice controller is already on the bus as number 1."],
  ["First steps", "Use the four steps under the toolbar. Find the controller, allow it to run, spin the shaft, then open Phases. The motor picture shows leads U, V and W. Swapping V and W reverses the shaft."],
  ["IXXAT adapter", "CAN menu, Connect IXXAT, opens the USB-CAN dongle through the VCI library. The practice controller pauses, so the CAN log and the SDO commands are the inverter. The VCI4 Tcl license DLL is not loaded. Disconnect CAN, or Connect virtual CAN, returns to the practice bus."],
  ["3-phase identification", "Light one lead at a time and the shaft mark is pulled to that lead. Run the field and the leads light in a circle. If the real motor turns the wrong way, swap the V and W cables and look again."],
  ["Commands", "The command window takes the same kind of lines as the old console: read 0x1008 0, write 0x60FF 0 1500, nmt start, demand enable, dcf open <path>, trace arm. Type help there for the full list."],
  ["DCF files", "Open a .dcf or .eds from Offline DCF. Names, values, comments, and unknown keys are kept. Compare two files and ignore read-only objects when you only care about settings. Save writes the file back if it was opened from a path, and also downloads a copy."],
  ["CANopen", "SDO upload and download, NMT, heartbeat, EMCY, SYNC, and one RPDO/TPDO pair are implemented, including segmented strings. PDO mapping uses the 0x1600 and 0x1A00 objects."],
  ["CiA 402", "Shutdown, switch on, enable operation, quick stop, disable voltage, and fault reset follow the standard controlword. Profile velocity, profile torque, and profile position are accepted. The virtual shaft ramps with the acceleration and deceleration objects."],
  ["J1939", "The demand window sends TSC1, PGN 0. Requested speed is 0.125 rpm per bit. Requested torque is 1 percent per bit with an offset of -125 percent. The tool address defaults to 250 (0xFA)."],
  ["Updates", "Help, Check for updates, looks at the public project on GitHub. When a newer setup program is published, a bar at the bottom downloads it and starts the installer. This window closes so the files can be replaced."],
  ["Not included", "This is not a BorgWarner or Sevcon product. It does not program vendor firmware, does not implement a vendor security unlock, and does not ship the vendor object database. A DCF you already have still opens, because those names are stored in the file."],
];

function fillHelp() {
  $("help-body").innerHTML = HELP.map(([title, body]) => `<h2>${esc(title)}</h2><p>${esc(body)}</p>`).join("");
  $("about-body").innerHTML = `<p><b>Z-DVT Workbench ${ui.latest ? ui.latest.version : "2026.09"}</b></p><p><b>Crafted by Z-Jomant Meister</b></p><p>Z-DVT Workbench replaces the customer configuration workflow. DVT Customer 2025.05b on this PC reports that its VCI4 Tcl 9 DLL will not load, and that release is no longer updated.</p><p>Practice controller 1 speaks CANopen and a small J1939 speed and torque demand. Connect IXXAT on the CAN menu talks to a USB-CAN dongle through the VCI library instead. Saved DCF settings files can be edited and compared offline.</p><p>Not affiliated with BorgWarner or Sevcon.</p>`;
}

async function onAction(name) {
  closeMenus();
  if (name === "source") $("file-source").click();
  else if (name === "focus-command") $("cmd").focus();
  else if (name === "clear-all") {
    await act({ type: "clear", what: "all" });
    $("cmd-log").innerHTML = "";
  }
  else if (name === "clear-can") await act({ type: "clear", what: "can" });
  else if (name === "clear-info") await act({ type: "clear", what: "info" });
  else if (name === "cut") document.execCommand("cut");
  else if (name === "copy") document.execCommand("copy");
  else if (name === "paste") document.execCommand("paste");
  else if (name === "settings") openSettings();
  else if (name === "access") openSettings();
  else if (name === "filter-all") await act({ type: "command", text: "filter all" });
  else if (name === "filter-none") await act({ type: "command", text: "filter none" });
  else if (name === "filter-defaults") await act({ type: "command", text: "filter defaults" });
  else if (name === "connect") await act({ type: "connect", on: true });
  else if (name === "connect-ixxat") await act({ type: "connect", adapter: "ixxat" });
  else if (name === "disconnect") await act({ type: "connect", on: false });
  else if (name === "tx") openDialog("dlg-tx");
  else if (name === "vehicle") openDialog("dlg-vehicle");
  else if (name === "j1939") {
    if (ui.latest) $("j-dest").value = ui.latest.j1939Node;
    openDialog("dlg-j1939");
  }
  else if (name === "cia402") openDialog("dlg-402");
  else if (name === "phases") openDialog("dlg-phases");
  else if (name === "setup") openDialog("dlg-setup");
  else if (name === "guide-run") {
    const node = Number($("node-id").value) || 1;
    await act({ type: "ping", node });
    await act({ type: "nmt", cmd: "start", node });
  }
  else if (name === "ping") await act({ type: "ping", node: Number($("node-id").value) || 1 });
  else if (name === "trace") openDialog("dlg-trace");
  else if (name === "faults") openDialog("dlg-faults");
  else if (name === "help") openDialog("dlg-help");
  else if (name === "about") openDialog("dlg-about");
  else if (name === "check-update") {
    ui.updateLater = false;
    await act({ type: "update", check: true });
    await poll();
  }
  else if (name === "open-dcf") $("file-dcf").click();
  else if (name === "compare-dcf") openDialog("dlg-compare");
  else if (name === "pull-dcf") await act({ type: "pullDcf" });
  else if (name === "coast") openDialog("dlg-coast");
  else if (name === "install-plugin") $("file-plugin").click();
  else if (name === "exit") await act({ type: "shutdown" });
}

function openSettings() {
  if (ui.latest) {
    $("set-timeout").value = String(ui.latest.sdoTimeout);
    $("set-sa").value = ui.latest.j1939Tool;
    $("set-level").value = ui.latest.accessLevel;
  }
  openDialog("dlg-settings");
}

function sendJ1939(enable) {
  return act({
    type: "j1939Hold",
    enable: enable && $("j-hold").checked,
    dest: Number($("j-dest").value),
    speedOn: $("j-speed-on").checked,
    torqueOn: $("j-torque-on").checked,
    speedRpm: Number($("j-speed").value),
    torquePct: Number($("j-torque").value),
  });
}

async function loadPlugins() {
  const names = await (await fetch("/api/plugins")).json();
  const menu = $("plugin-menu");
  menu.innerHTML = "";
  if (!names.length) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.disabled = true;
    empty.textContent = "None";
    menu.appendChild(empty);
  }
  for (const name of names) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = name;
    btn.addEventListener("click", async () => {
      closeMenus();
      await act({ type: "runPlugin", name });
    });
    menu.appendChild(btn);
  }
  const hr = document.createElement("hr");
  menu.appendChild(hr);
  const install = document.createElement("button");
  install.type = "button";
  install.textContent = "Install new plugin from text file";
  install.addEventListener("click", () => onAction("install-plugin"));
  menu.appendChild(install);
}

function setupSplits() {
  const workspace = $("workspace");
  const left = $("left");
  document.querySelectorAll(".split").forEach((bar) => {
    bar.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const horizontal = bar.classList.contains("h");
      const start = horizontal ? event.clientX : event.clientY;
      const rect = horizontal ? left.getBoundingClientRect() : left.getBoundingClientRect();
      const startSize = horizontal ? rect.width : null;
      const rows = left.getBoundingClientRect();
      function move(ev) {
        if (horizontal) {
          const width = Math.max(320, startSize + ev.clientX - start);
          workspace.style.gridTemplateColumns = width + "px 6px 1fr";
        } else if (bar.dataset.split === "top") {
          const total = rows.height;
          const top = Math.max(80, ev.clientY - rows.top);
          left.style.gridTemplateRows = top + "px 6px 1fr 6px .72fr";
          void total;
        } else {
          const bottom = Math.max(70, rows.bottom - ev.clientY);
          left.style.gridTemplateRows = "1.35fr 6px 1fr 6px " + bottom + "px";
        }
      }
      function up() {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      }
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  });
}

function bind() {
  document.querySelectorAll(".menu > button").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = btn.parentElement;
      const open = menu.classList.contains("open");
      closeMenus();
      if (!open) menu.classList.add("open");
    });
  });
  document.addEventListener("click", closeMenus);
  document.querySelectorAll("[data-act]").forEach((btn) => {
    if (btn.closest(".menu > button")) return;
    btn.addEventListener("click", () => onAction(btn.dataset.act));
  });
  document.querySelectorAll("[data-panel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.panel;
      const show = !(ui.latest && ui.latest.panels && ui.latest.panels[name]);
      await act({ type: "panel", name, show });
      closeMenus();
    });
  });
  document.querySelectorAll(".baud").forEach((btn) => btn.addEventListener("click", () => act({ type: "baud", baud: Number(btn.dataset.baud) })));
  document.querySelectorAll("#filters button").forEach((btn) => btn.addEventListener("click", () => {
    const on = !btn.classList.contains("on");
    act({ type: "filter", name: btn.dataset.filter, on });
  }));
  document.querySelectorAll("[data-cantab]").forEach((btn) => btn.addEventListener("click", () => {
    document.querySelectorAll("[data-cantab]").forEach((tab) => tab.classList.remove("on"));
    btn.classList.add("on");
    $("can-log-wrap").classList.toggle("hidden", btn.dataset.cantab !== "log");
    $("can-msg-wrap").classList.toggle("hidden", btn.dataset.cantab !== "msg");
    if (ui.latest) paintCan(ui.latest.filters);
  }));
  document.querySelectorAll("[data-htab]").forEach((btn) => btn.addEventListener("click", () => {
    document.querySelectorAll("[data-htab]").forEach((tab) => tab.classList.remove("on"));
    btn.classList.add("on");
    document.querySelectorAll(".htab").forEach((tab) => tab.classList.add("hidden"));
    $("htab-" + btn.dataset.htab).classList.remove("hidden");
  }));
  $("ping-btn").addEventListener("click", () => onAction("ping"));
  $("boot-ping").addEventListener("click", () => onAction("ping"));
  $("op-btn").addEventListener("click", () => {
    if (!ui.latest) return;
    const cmd = ui.latest.nmtName === "Operational" ? "preop" : "start";
    act({ type: "nmt", cmd, node: Number($("node-id").value) || 1 });
  });
  $("node-id").addEventListener("change", () => act({ type: "selectNode", node: Number($("node-id").value) }));
  $("cli-btn").addEventListener("click", () => act({ type: "cli", on: !(ui.latest && ui.latest.cli) }));
  $("st-cli").addEventListener("click", () => act({ type: "cli", on: !(ui.latest && ui.latest.cli) }));
  $("cmd").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const text = $("cmd").value;
      $("cmd").value = "";
      runCommand(text);
    } else if (event.key === "ArrowUp") {
      if (!ui.history.length) return;
      if (ui.hist === ui.history.length) ui.draft = $("cmd").value;
      ui.hist = Math.max(0, ui.hist - 1);
      $("cmd").value = ui.history[ui.hist];
      event.preventDefault();
    } else if (event.key === "ArrowDown") {
      if (ui.hist < 0) return;
      ui.hist = Math.min(ui.history.length, ui.hist + 1);
      $("cmd").value = ui.hist === ui.history.length ? ui.draft : ui.history[ui.hist];
      event.preventDefault();
    }
  });
  $("cmd-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") runCommand("help " + $("cmd-search").value.trim());
  });
  $("tree-search").addEventListener("input", () => {
    const q = $("tree-search").value.trim().toLowerCase();
    document.querySelectorAll("#tree .obj").forEach((row) => {
      row.hidden = !!q && !row.dataset.search.includes(q);
    });
  });
  $("file-source").addEventListener("change", async () => {
    const file = $("file-source").files[0];
    if (!file) return;
    await act({ type: "source", text: await readFile(file) });
    $("file-source").value = "";
  });
  $("file-dcf").addEventListener("change", async () => {
    const file = $("file-dcf").files[0];
    if (!file) return;
    await act({ type: "openDcf", name: file.name, text: await readFile(file) });
    $("file-dcf").value = "";
  });
  $("file-plugin").addEventListener("change", async () => {
    const file = $("file-plugin").files[0];
    if (!file) return;
    await act({ type: "installPlugin", name: file.name, text: await readFile(file) });
    $("file-plugin").value = "";
    loadPlugins();
  });
  $("set-save").addEventListener("click", async () => {
    await act({ type: "settings", sdoTimeout: Number($("set-timeout").value), j1939Tool: Number($("set-sa").value) });
    await act({ type: "level", level: $("set-level").value });
    $("dlg-settings").close();
  });
  $("rec-start").addEventListener("click", () => act({ type: "record" }));
  $("rec-stop").addEventListener("click", async () => {
    const result = await act({ type: "record", stop: true });
    if (result && result.text) download("can-log.csv", result.text);
  });
  ["j-speed", "j-torque", "j-dest", "j-speed-on", "j-torque-on"].forEach((id) => {
    $(id).addEventListener("change", () => { if ($("j-hold").checked) sendJ1939(true); });
  });
  $("j-send").addEventListener("click", async () => {
    const hold = $("j-hold").checked;
    $("j-hold").checked = true;
    await sendJ1939(true);
    if (!hold) {
      $("j-hold").checked = false;
      setTimeout(() => sendJ1939(false), 120);
    }
  });
  $("j-hold").addEventListener("change", () => sendJ1939($("j-hold").checked));
  document.querySelectorAll("[data-dem]").forEach((btn) => btn.addEventListener("click", () => act({ type: "cia402", op: btn.dataset.dem })));
  $("dem-mode").addEventListener("change", () => act({ type: "cia402", op: "mode", value: $("dem-mode").value }));
  $("dem-vel-go").addEventListener("click", () => act({ type: "cia402", op: "vel", value: $("dem-vel").value }));
  $("dem-tq-go").addEventListener("click", () => act({ type: "cia402", op: "torque", value: $("dem-tq").value }));
  $("tr-arm").addEventListener("click", () => act({ type: "trace", arm: true }));
  $("tr-stop").addEventListener("click", () => act({ type: "trace", arm: false }));
  $("tr-csv").addEventListener("click", async () => {
    const result = await act({ type: "traceCsv" });
    if (result && result.text) download("detail-trace.csv", result.text);
  });
  $("tx-send").addEventListener("click", async () => {
    let id = $("tx-id").value.trim();
    id = id.toLowerCase().startsWith("0x") ? parseInt(id, 16) : parseInt(id, 10);
    const data = parseBytes($("tx-data").value);
    const ext = $("tx-ext").checked || id > 0x7ff;
    await act({ type: "tx", id, ext, data });
    await act({ type: "txHold", enable: $("tx-hold").checked, id, ext, data, every: Number($("tx-every").value) });
  });
  $("cmp-go").addEventListener("click", async () => {
    const a = $("cmp-a").files[0];
    const b = $("cmp-b").files[0];
    if (!a || !b) return;
    const result = await act({ type: "compareText", a: await readFile(a), b: await readFile(b), ignoreRo: $("cmp-ro").checked });
    ui.cmpRows = result.rows || [];
    $("cmp-out").innerHTML = ui.cmpRows.length ? "<table><thead><tr><th>Index</th><th>Name</th><th>A</th><th>B</th></tr></thead><tbody>" + ui.cmpRows.map((row) => `<tr><td>0x${hexIndex(row.index)}:${row.sub}</td><td>${esc(row.name)}</td><td>${esc(row.a)}</td><td>${esc(row.b)}</td></tr>`).join("") + "</tbody></table>" : "<p class='note'>No differences.</p>";
  });
  $("cmp-copy").addEventListener("click", async () => {
    const csv = ["index,sub,name,access,a,b"].concat(ui.cmpRows.map((row) => [hexIndex(row.index), row.sub, `"${row.name}"`, row.access, row.a, row.b].join(","))).join("\n");
    try { await navigator.clipboard.writeText(csv); } catch { download("dcf-diff.csv", csv); }
  });
  $("fault-clear").addEventListener("click", () => act({ type: "fault", clear: true }));
  $("coast-go").addEventListener("click", () => {
    $("coast-out").textContent = coastTorque($("coast-text").value, Number($("coast-i").value) || 0);
  });
  $("ph-u").addEventListener("click", () => setPhaseLock("U"));
  $("ph-v").addEventListener("click", () => setPhaseLock("V"));
  $("ph-w").addEventListener("click", () => setPhaseLock("W"));
  $("ph-run").addEventListener("click", () => setPhaseLock(null));
  $("ph-swap").addEventListener("click", () => {
    phase.swap = !phase.swap;
    $("ph-swap").classList.toggle("on", phase.swap);
    $("ph-swap").textContent = phase.swap ? "Put V and W back" : "Swap V and W";
  });
  $("wiz-back").addEventListener("click", () => { if (wiz.step > 1) showWizard(wiz.step - 1); });
  $("wiz-next").addEventListener("click", wizardNext);
  $("wiz-find").addEventListener("click", async () => {
    $("wiz-find-result").textContent = "Looking for the controller…";
    try {
      const node = Number($("node-id").value) || 1;
      const ping = await act({ type: "ping", node });
      if (!ping.ok) throw new Error(ping.error || "The controller did not answer.");
      await applyNameplate();
      wiz.found = true;
      $("wiz-find-result").textContent = `Controller ${node} answered${ping.name ? " as " + ping.name : ""}. The nameplate is stored.`;
    } catch (err) {
      wiz.found = false;
      $("wiz-find-result").textContent = err.message;
    }
  });
  $("wiz-spin").addEventListener("click", runGuardedSpin);
  $("wiz-dir-run").addEventListener("click", runDirection);
  $("wiz-yes").addEventListener("click", () => answerDirection(true));
  $("wiz-no").addEventListener("click", () => answerDirection(false));
  $("wiz-save").addEventListener("click", saveWizard);
  $("ph-bench").addEventListener("click", async () => {
    const node = Number($("node-id").value) || 1;
    await act({ type: "ping", node });
    await act({ type: "nmt", cmd: "start", node });
    await act({ type: "cia402", op: "enable" });
    await act({ type: "cia402", op: "mode", value: "pv" });
    await act({ type: "cia402", op: "vel", value: 600 });
    setPhaseLock(null);
  });
  $("dlg-phases").addEventListener("close", () => {
    cancelAnimationFrame(phase.frame);
    phase.frame = 0;
  });
  setPhaseLock(null);
  setupSplits();
}

async function loop() {
  try { await poll(); }
  catch (err) {
    $("st-main").textContent = "Z-DVT Workbench is not answering";
    $("st-main").className = "bad";
  }
  setTimeout(loop, 300);
}

document.querySelectorAll("dialog header button").forEach((btn) => {
  if (btn.textContent.trim() !== "Close") return;
  btn.type = "button";
  btn.addEventListener("click", () => {
    const dlg = btn.closest("dialog");
    if (dlg && dlg.open) dlg.close();
  });
});
fillHelp();
$("update-go").addEventListener("click", async () => {
  $("update-text").textContent = "Downloading the installer…";
  const result = await act({ type: "update", install: true });
  if (result && !result.ok) $("update-text").textContent = result.error || "The download did not finish.";
});
$("update-later").addEventListener("click", () => {
  ui.updateLater = true;
  $("update-bar").hidden = true;
});
bind();
loadPlugins();
loop();
if (new URLSearchParams(location.search).has("phases")) openDialog("dlg-phases");
if (new URLSearchParams(location.search).has("setup")) openDialog("dlg-setup");
