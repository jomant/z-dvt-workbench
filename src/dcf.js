"use strict";

// CANopen device configuration file (CiA 306). Parsing keeps the original
// text, comments, and unknown keys so a vendor file can round-trip.

const DT = {
  BOOLEAN: 0x0001,
  INTEGER8: 0x0002,
  INTEGER16: 0x0003,
  INTEGER32: 0x0004,
  UNSIGNED8: 0x0005,
  UNSIGNED16: 0x0006,
  UNSIGNED32: 0x0007,
  REAL32: 0x0008,
  VISIBLE_STRING: 0x0009,
};

const DT_NAME = {};
for (const [name, code] of Object.entries(DT)) DT_NAME[code] = name;

function padHex(n, width) {
  return (Number(n) >>> 0).toString(16).toUpperCase().padStart(width, "0");
}

function parseSubindex(text) {
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  return parseInt(text, 16);
}

function parseDcfNumber(raw, type) {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s || s === "$NodeID") return undefined;
  if (type === DT.VISIBLE_STRING) return s.replace(/^"|"$/g, "");
  if (type === DT.REAL32) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  let n;
  if (/^0x[0-9a-f]+$/i.test(s)) n = parseInt(s, 16);
  else if (/^-?\d+$/.test(s)) n = parseInt(s, 10);
  else return undefined;
  if (!Number.isFinite(n)) return undefined;
  if (type === DT.INTEGER8) return (n << 24) >> 24;
  if (type === DT.INTEGER16) return (n << 16) >> 16;
  if (type === DT.INTEGER32) return n | 0;
  return n >>> 0;
}

function sectionObject(name) {
  const m = /^([0-9A-Fa-f]{4})(?:sub([0-9A-Fa-f]+))?$/.exec(name);
  if (!m) return null;
  return {
    index: parseInt(m[1], 16),
    sub: m[2] == null ? 0 : parseSubindex(m[2]),
  };
}

function parseDcf(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  const sections = [];
  const headerLines = [];
  let cur = null;
  for (const line of lines) {
    const trim = line.trim();
    const m = /^\[(.+)]$/.exec(trim);
    if (m) {
      cur = { name: m[1], entries: [], fields: {} };
      sections.push(cur);
      continue;
    }
    if (!cur) {
      headerLines.push(line);
      continue;
    }
    cur.entries.push(line);
    if (!trim || trim.startsWith(";") || trim.startsWith("#")) continue;
    const eq = trim.indexOf("=");
    if (eq <= 0) continue;
    cur.fields[trim.slice(0, eq).trim()] = trim.slice(eq + 1).trim();
  }

  const objects = [];
  for (const section of sections) {
    const loc = sectionObject(section.name);
    if (!loc) continue;
    const type = parseInt(section.fields.DataType || "", 16);
    const dataType = DT_NAME[type] ? type : DT.UNSIGNED32;
    const access = String(section.fields.AccessType || "rw").toLowerCase();
    const hasParameterValue = Object.prototype.hasOwnProperty.call(section.fields, "ParameterValue");
    const rawValue = hasParameterValue ? section.fields.ParameterValue : section.fields.DefaultValue;
    const value = parseDcfNumber(rawValue, dataType);
    objects.push({
      index: loc.index,
      sub: loc.sub,
      name: section.fields.ParameterName || section.fields.Denotation || `Object ${padHex(loc.index, 4)}:${loc.sub}`,
      type: dataType,
      access,
      value,
      hasValue: value !== undefined,
      unit: section.fields.Unit || "",
      pdo: section.fields.PDOMapping === "1",
      section,
      dirty: false,
    });
  }

  return {
    headerLines,
    sections,
    objects,
    newline: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function formatParameterValue(obj) {
  if (obj.type === DT.VISIBLE_STRING) return String(obj.value ?? "");
  if (obj.type === DT.REAL32) {
    const n = Number(obj.value);
    return Number.isFinite(n) ? String(n) : "0";
  }
  const width = obj.type === DT.UNSIGNED8 || obj.type === DT.INTEGER8 || obj.type === DT.BOOLEAN ? 2
    : obj.type === DT.UNSIGNED16 || obj.type === DT.INTEGER16 ? 4
    : 8;
  let n = Number(obj.value);
  if (!Number.isFinite(n)) n = 0;
  if (obj.type === DT.INTEGER32) n = n | 0;
  return "0x" + padHex(n, width);
}

function serializeDcf(doc) {
  for (const obj of doc.objects) {
    if (!obj.dirty || !obj.section) continue;
    const rendered = formatParameterValue(obj);
    let found = false;
    obj.section.entries = obj.section.entries.map((line) => {
      if (/^\s*ParameterValue\s*=/.test(line)) {
        found = true;
        return "ParameterValue=" + rendered;
      }
      return line;
    });
    if (!found) obj.section.entries.push("ParameterValue=" + rendered);
    obj.section.fields.ParameterValue = rendered;
    obj.dirty = false;
  }

  const nl = doc.newline || "\n";
  const parts = [];
  if (doc.headerLines && doc.headerLines.length) parts.push(doc.headerLines.join(nl));
  for (const section of doc.sections) {
    const body = [`[${section.name}]`].concat(section.entries);
    parts.push(body.join(nl));
  }
  let text = parts.filter((p) => p !== "").join(nl);
  if (!text.endsWith(nl)) text += nl;
  return text;
}

function groupForIndex(index) {
  if (index < 0x2000) return "Communication";
  if (index < 0x6000) return "Manufacturer";
  if (index < 0x6800) return "Device profile";
  return "Other";
}

function isWritableAccess(access) {
  const a = String(access || "").toLowerCase();
  return a === "rw" || a === "rww" || a === "wo";
}

function isReadOnlyAccess(access) {
  const a = String(access || "").toLowerCase();
  return a === "ro" || a === "const";
}

function diffDcf(textA, textB, ignoreReadOnly) {
  const a = parseDcf(textA);
  const b = parseDcf(textB);
  const key = (o) => `${o.index.toString(16)}:${o.sub}`;
  const mapB = new Map(b.objects.map((o) => [key(o), o]));
  const seen = new Set();
  const rows = [];
  const consider = (left, right) => {
    if (ignoreReadOnly && left && isReadOnlyAccess(left.access) && (!right || isReadOnlyAccess(right.access))) return;
    if (ignoreReadOnly && right && isReadOnlyAccess(right.access) && !left) return;
    const lv = left && left.hasValue ? formatParameterValue(left) : "";
    const rv = right && right.hasValue ? formatParameterValue(right) : "";
    if (lv === rv) return;
    const src = left || right;
    rows.push({
      index: src.index,
      sub: src.sub,
      name: (left && left.name) || (right && right.name) || "",
      access: (left && left.access) || (right && right.access) || "",
      a: lv,
      b: rv,
    });
  };
  for (const obj of a.objects) {
    const k = key(obj);
    seen.add(k);
    consider(obj, mapB.get(k));
  }
  for (const obj of b.objects) {
    if (!seen.has(key(obj))) consider(undefined, obj);
  }
  rows.sort((p, q) => p.index - q.index || p.sub - q.sub);
  return rows;
}

function buildDcf(objects, meta) {
  const nl = "\r\n";
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const lines = [];
  lines.push("[FileInfo]");
  lines.push("FileName=" + (meta.fileName || "controller"));
  lines.push("FileVersion=1");
  lines.push("FileRevision=1");
  lines.push("EDSVersion=4.0");
  lines.push("Description=Device configuration written by Z-DVT Workbench");
  lines.push("CreationDate=" + date);
  lines.push("CreatedBy=Z-Jomant Meister");
  lines.push("");
  lines.push("[DeviceCommissioning]");
  lines.push("NodeID=" + (meta.nodeId || 1));
  lines.push("NodeName=" + (meta.nodeName || "controller"));
  lines.push("Baudrate=" + (meta.baud || 1000));
  lines.push("NetNumber=0");
  lines.push("NetworkName=workbench");
  lines.push("CANopenManager=0");
  lines.push("");

  const sorted = objects.slice().sort((a, b) => a.index - b.index || a.sub - b.sub);
  for (const obj of sorted) {
    if (obj.sub === 0) lines.push("[" + padHex(obj.index, 4) + "]");
    else lines.push("[" + padHex(obj.index, 4) + "sub" + obj.sub + "]");
    lines.push("ParameterName=" + obj.name);
    lines.push("ObjectType=0x7");
    lines.push("DataType=0x" + padHex(obj.type, 4));
    lines.push("AccessType=" + obj.access);
    if (obj.value !== undefined) lines.push("ParameterValue=" + formatParameterValue(obj));
    if (obj.unit) lines.push("Unit=" + obj.unit);
    lines.push("PDOMapping=" + (obj.pdo ? "1" : "0"));
    lines.push("");
  }
  return lines.join(nl);
}

module.exports = {
  DT,
  DT_NAME,
  parseDcf,
  serializeDcf,
  diffDcf,
  buildDcf,
  formatParameterValue,
  groupForIndex,
  isWritableAccess,
  isReadOnlyAccess,
  parseDcfNumber,
  padHex,
};
