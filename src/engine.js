"use strict";

const fs = require("fs");
const path = require("path");
const dcf = require("./dcf");
const ixxat = require("./ixxat");
const updater = require("./update");
const { settingsPath } = require("./paths");

const VERSION = require("../package.json").version;
const FILTER_NAMES = ["pdo", "sdo", "nmt", "emcy", "sync", "tx", "j1939", "uds", "debug", "unknown"];
const BAUDS = [1000, 800, 500, 250, 125, 100, 50, 20];

const EMCY_TEXT = {
  0x2310: "Output current is too high",
  0x3210: "DC link voltage is too high",
  0x3220: "DC link voltage is too low",
  0x4210: "The drive is too hot",
  0x8130: "The controller stopped answering",
  0x8611: "The shaft did not follow the speed command",
};

const EMCY_CHECK = {
  0x2310: "Check the motor leads and the current limit. A short or a loose phase does this.",
  0x3210: "Check the battery or supply. The DC link is above the rating.",
  0x3220: "Check the supply, the fuse, and the contactors. The DC link is too low.",
  0x4210: "Check airflow and coolant, then let the drive cool.",
  0x8130: "Check CAN high, CAN low, and the termination resistor.",
  0x8611: "Check the encoder connector and the phase order. Swap V and W if the shaft turns the wrong way.",
};

const DI_ENUM = [
  { v: 0, t: "None" },
  { v: 1, t: "Drive enable" },
  { v: 2, t: "Forward" },
  { v: 3, t: "Reverse" },
  { v: 4, t: "Fault reset" },
  { v: 5, t: "Interlock" },
];

const MODE_ENUM = [
  { v: 1, t: "Profile position" },
  { v: 3, t: "Profile velocity" },
  { v: 4, t: "Profile torque" },
];

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hexId(id, ext) {
  return ext ? dcf.padHex(id, 8) : dcf.padHex(id, 3);
}

function parseUserNumber(text) {
  if (typeof text === "number") return text;
  const s = String(text).trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return NaN;
}

function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}

function j1939Id(priority, pf, ps, sa) {
  return ((priority & 7) << 26) | ((pf & 0xff) << 16) | ((ps & 0xff) << 8) | (sa & 0xff);
}

function parseJ1939(id) {
  const sa = id & 0xff;
  const ps = (id >>> 8) & 0xff;
  const pf = (id >>> 16) & 0xff;
  const priority = (id >>> 26) & 7;
  if (pf < 240) return { priority, pf, ps, sa, pgn: pf << 8, da: ps };
  return { priority, pf, ps, sa, pgn: (pf << 8) | ps, da: null };
}

function classify(frame) {
  if (frame.ext) return "j1939";
  const id = frame.id;
  if (id === 0x080) return "sync";
  if (id === 0x000) return "nmt";
  if (id >= 0x081 && id <= 0x0ff) return "emcy";
  if (id >= 0x180 && id <= 0x57f) return "pdo";
  if (id >= 0x580 && id <= 0x67f) return "sdo";
  if (id >= 0x700 && id <= 0x77f) return "nmt";
  if (id === 0x7f0) return "debug";
  if (id >= 0x7e0 && id <= 0x7ef) return "uds";
  return "unknown";
}

function encodeObject(obj) {
  const buf = Buffer.alloc(8);
  const type = obj.type;
  if (type === dcf.DT.VISIBLE_STRING) return Buffer.from(String(obj.value ?? ""), "utf8");
  if (type === dcf.DT.REAL32) {
    buf.writeFloatLE(Number(obj.value) || 0, 0);
    return buf.subarray(0, 4);
  }
  let n = Number(obj.value) || 0;
  if (type === dcf.DT.BOOLEAN || type === dcf.DT.UNSIGNED8 || type === dcf.DT.INTEGER8) {
    buf.writeUInt8(n & 0xff, 0);
    return buf.subarray(0, 1);
  }
  if (type === dcf.DT.UNSIGNED16 || type === dcf.DT.INTEGER16) {
    buf.writeUInt16LE(n & 0xffff, 0);
    return buf.subarray(0, 2);
  }
  buf.writeUInt32LE(n >>> 0, 0);
  return buf.subarray(0, 4);
}

function decodeBytes(type, bytes) {
  const b = Buffer.from(bytes);
  if (type === dcf.DT.VISIBLE_STRING) return b.toString("utf8").replace(/\0+$/, "");
  if (type === dcf.DT.REAL32) return b.length >= 4 ? b.readFloatLE(0) : 0;
  if (type === dcf.DT.BOOLEAN || type === dcf.DT.UNSIGNED8) return b[0] || 0;
  if (type === dcf.DT.INTEGER8) return ((b[0] || 0) << 24) >> 24;
  if (type === dcf.DT.UNSIGNED16) return b.length >= 2 ? b.readUInt16LE(0) : 0;
  if (type === dcf.DT.INTEGER16) return b.length >= 2 ? b.readInt16LE(0) : 0;
  if (type === dcf.DT.INTEGER32) return b.length >= 4 ? b.readInt32LE(0) : 0;
  return b.length >= 4 ? b.readUInt32LE(0) : 0;
}

function packBits(entries, readValue) {
  const bits = [];
  for (const entry of entries) {
    let value = Number(readValue(entry.index, entry.sub)) || 0;
    if (value < 0) value >>>= 0;
    for (let i = 0; i < entry.bits; i++) bits.push((value >>> i) & 1);
  }
  const data = Array(Math.min(8, Math.ceil(bits.length / 8))).fill(0);
  bits.forEach((bit, i) => {
    if (bit && i < 64) data[i >> 3] |= 1 << (i & 7);
  });
  return data;
}

function unpackBits(entries, data, writeValue) {
  let cursor = 0;
  for (const entry of entries) {
    let value = 0;
    for (let i = 0; i < entry.bits; i++) {
      const byte = data[cursor >> 3] || 0;
      if ((byte >> (cursor & 7)) & 1) value |= 1 << i;
      cursor++;
    }
    if (entry.bits === 8) value = (value << 24) >> 24;
    else if (entry.bits === 16) value = (value << 16) >> 16;
    else if (entry.bits === 32) value = value | 0;
    writeValue(entry.index, entry.sub, value);
  }
}

function mapFromObject(raw) {
  const value = Number(raw) >>> 0;
  if (!value) return null;
  return {
    index: (value >>> 16) & 0xffff,
    sub: (value >>> 8) & 0xff,
    bits: value & 0xff,
  };
}

class VirtualNode {
  constructor(bus) {
    this.bus = bus;
    this.id = 1;
    this.objects = new Map();
    this.nmt = 127;
    this.driveState = "switch on disabled";
    this.lastCw = 0;
    this.faultCode = 0;
    this.errorRegister = 0;
    this.velocity = 0;
    this.positionCounts = 0;
    this.torque = 0;
    this.current = 0;
    this.vdc = 5200;
    this.tempM = 35;
    this.tempC = 32;
    this.hbAcc = 0;
    this.pdoAcc = 0;
    this.cliAcc = 0;
    this.up = null;
    this.down = null;
    this.seedDictionary();
    this.syncLive(true);
  }

  key(index, sub) {
    return (index << 8) | sub;
  }

  add(index, sub, name, type, access, value, extra = {}) {
    this.objects.set(this.key(index, sub), {
      index,
      sub,
      name,
      type,
      access,
      value,
      unit: extra.unit || "",
      group: extra.group || dcf.groupForIndex(index),
      enum: extra.enum || null,
      live: !!extra.live,
      pdo: extra.pdo !== false && type !== dcf.DT.VISIBLE_STRING,
      min: extra.min,
      max: extra.max,
    });
  }

  seedDictionary() {
    const U8 = dcf.DT.UNSIGNED8;
    const U16 = dcf.DT.UNSIGNED16;
    const U32 = dcf.DT.UNSIGNED32;
    const I8 = dcf.DT.INTEGER8;
    const I16 = dcf.DT.INTEGER16;
    const I32 = dcf.DT.INTEGER32;
    const R = dcf.DT.REAL32;
    const S = dcf.DT.VISIBLE_STRING;
    const C = "Communication";
    const M = "Motor";
    const L = "Limits";
    const IO = "Input / Output";
    const CAN = "CAN";
    const ME = "Measurements";
    const DR = "Drive";

    this.add(0x1000, 0, "Device type", U32, "ro", 0x00020192, { group: C });
    this.add(0x1001, 0, "Error register", U8, "ro", 0, { group: C, live: true });
    this.add(0x1005, 0, "SYNC COB-ID", U32, "rw", 0x80, { group: C });
    this.add(0x1008, 0, "Manufacturer device name", S, "ro", "Z-DVT Practice Controller", { group: C });
    this.add(0x1009, 0, "Hardware version", S, "ro", "WB-HW-1", { group: C });
    this.add(0x100a, 0, "Software version", S, "ro", VERSION, { group: C });
    this.add(0x1017, 0, "Producer heartbeat time", U16, "rw", 1000, { group: C, unit: "ms", min: 0, max: 65535 });
    this.add(0x1018, 0, "Identity", U8, "ro", 4, { group: C });
    this.add(0x1018, 1, "Vendor-ID", U32, "ro", 0x57504231, { group: C });
    this.add(0x1018, 2, "Product code", U32, "ro", 0x00010001, { group: C });
    this.add(0x1018, 3, "Revision number", U32, "ro", 0x00010000, { group: C });
    this.add(0x1018, 4, "Serial number", U32, "ro", 1001, { group: C });

    this.add(0x1400, 0, "RPDO1 communication parameter", U8, "ro", 5, { group: C });
    this.add(0x1400, 1, "RPDO1 COB-ID", U32, "rw", 0x200 + this.id, { group: C });
    this.add(0x1400, 2, "RPDO1 transmission type", U8, "rw", 254, { group: C });
    this.add(0x1400, 5, "RPDO1 event timer", U16, "rw", 0, { group: C, unit: "ms" });
    this.add(0x1600, 0, "RPDO1 mapping count", U8, "rw", 3, { group: C, min: 0, max: 8 });
    this.add(0x1600, 1, "RPDO1 map 1", U32, "rw", 0x60400010, { group: C });
    this.add(0x1600, 2, "RPDO1 map 2", U32, "rw", 0x60ff0020, { group: C });
    this.add(0x1600, 3, "RPDO1 map 3", U32, "rw", 0x60710010, { group: C });

    this.add(0x1800, 0, "TPDO1 communication parameter", U8, "ro", 5, { group: C });
    this.add(0x1800, 1, "TPDO1 COB-ID", U32, "rw", 0x180 + this.id, { group: C });
    this.add(0x1800, 2, "TPDO1 transmission type", U8, "rw", 254, { group: C });
    this.add(0x1800, 5, "TPDO1 event timer", U16, "rw", 100, { group: C, unit: "ms" });
    this.add(0x1a00, 0, "TPDO1 mapping count", U8, "rw", 3, { group: C, min: 0, max: 8 });
    this.add(0x1a00, 1, "TPDO1 map 1", U32, "rw", 0x60410010, { group: C });
    this.add(0x1a00, 2, "TPDO1 map 2", U32, "rw", 0x606c0020, { group: C });
    this.add(0x1a00, 3, "TPDO1 map 3", U32, "rw", 0x60770010, { group: C });

    this.add(0x2000, 0, "Motor", U8, "ro", 7, { group: M });
    this.add(0x2000, 1, "Pole pairs", U8, "rw", 4, { group: M, min: 1, max: 64 });
    this.add(0x2000, 2, "Rated current", U16, "rw", 2000, { group: M, unit: "0.1 A", min: 0, max: 20000 });
    this.add(0x2000, 3, "Rated speed", U16, "rw", 3000, { group: M, unit: "rpm", min: 0, max: 20000 });
    this.add(0x2000, 4, "Encoder pulses per revolution", U16, "rw", 1024, { group: M, unit: "ppr", min: 1, max: 65535 });
    this.add(0x2000, 5, "Motor name", S, "rw", "Demo PM", { group: M });
    this.add(0x2000, 6, "Rotor inertia", R, "rw", 0.02, { group: M, unit: "kg m^2", min: 0, max: 100 });
    this.add(0x2000, 7, "Rated DC voltage", U16, "rw", 5000, { group: M, unit: "0.1 V", min: 0, max: 20000 });

    this.add(0x2001, 0, "Limits", U8, "ro", 6, { group: L });
    this.add(0x2001, 1, "Maximum torque", U16, "rw", 1000, { group: L, unit: "0.1 %", min: 0, max: 5000 });
    this.add(0x2001, 2, "Maximum speed", U16, "rw", 6000, { group: L, unit: "rpm", min: 0, max: 20000 });
    this.add(0x2001, 3, "Acceleration", U16, "rw", 2000, { group: L, unit: "rpm/s", min: 1, max: 100000 });
    this.add(0x2001, 4, "Deceleration", U16, "rw", 2000, { group: L, unit: "rpm/s", min: 1, max: 100000 });
    this.add(0x2001, 5, "DC cutback start", U16, "rw", 4000, { group: L, unit: "0.1 V" });
    this.add(0x2001, 6, "DC cutback end", U16, "rw", 3200, { group: L, unit: "0.1 V" });

    this.add(0x2002, 0, "Inputs", U8, "ro", 6, { group: IO });
    this.add(0x2002, 1, "Digital input 1 function", U8, "rw", 1, { group: IO, enum: DI_ENUM });
    this.add(0x2002, 2, "Digital input 2 function", U8, "rw", 2, { group: IO, enum: DI_ENUM });
    this.add(0x2002, 3, "Digital input 3 function", U8, "rw", 0, { group: IO, enum: DI_ENUM });
    this.add(0x2002, 4, "Analog input 1 scale", R, "rw", 1, { group: IO });
    this.add(0x2002, 5, "Analog input 1 offset", R, "rw", 0, { group: IO });
    this.add(0x2002, 6, "Digital input state", U8, "ro", 0, { group: IO, live: true });

    this.add(0x2003, 0, "CAN settings", U8, "ro", 2, { group: CAN });
    this.add(0x2003, 1, "J1939 source address", U8, "rw", 0x21, { group: CAN, min: 0, max: 253 });
    this.add(0x2003, 2, "Active bitrate", U16, "ro", 1000, { group: CAN, unit: "kbit/s", live: true });

    this.add(0x2100, 0, "Measurements", U8, "ro", 5, { group: ME });
    this.add(0x2100, 1, "DC link voltage", U16, "ro", 5200, { group: ME, unit: "0.1 V", live: true });
    this.add(0x2100, 2, "Motor temperature", U16, "ro", 350, { group: ME, unit: "0.1 C", live: true });
    this.add(0x2100, 3, "Controller temperature", U16, "ro", 320, { group: ME, unit: "0.1 C", live: true });
    this.add(0x2100, 4, "Output current", I16, "ro", 0, { group: ME, unit: "0.1 A", live: true });
    this.add(0x2100, 5, "Analog input 1", U16, "ro", 0, { group: ME, live: true });

    this.add(0x603f, 0, "Error code", U16, "ro", 0, { group: DR, live: true });
    this.add(0x6040, 0, "Controlword", U16, "rw", 0, { group: DR });
    this.add(0x6041, 0, "Statusword", U16, "ro", 0x0040, { group: DR, live: true });
    this.add(0x6060, 0, "Modes of operation", I8, "rw", 3, { group: DR, enum: MODE_ENUM });
    this.add(0x6061, 0, "Modes of operation display", I8, "ro", 3, { group: DR, enum: MODE_ENUM, live: true });
    this.add(0x6064, 0, "Position actual", I32, "ro", 0, { group: DR, unit: "counts", live: true });
    this.add(0x606c, 0, "Velocity actual", I32, "ro", 0, { group: DR, unit: "rpm", live: true });
    this.add(0x6071, 0, "Target torque", I16, "rw", 0, { group: DR, unit: "0.1 %", min: -5000, max: 5000 });
    this.add(0x6077, 0, "Torque actual", I16, "ro", 0, { group: DR, unit: "0.1 %", live: true });
    this.add(0x6078, 0, "Current actual", I16, "ro", 0, { group: DR, unit: "0.1 A", live: true });
    this.add(0x607a, 0, "Target position", I32, "rw", 0, { group: DR, unit: "counts" });
    this.add(0x60ff, 0, "Target velocity", I32, "rw", 0, { group: DR, unit: "rpm" });
    this.add(0x6502, 0, "Supported drive modes", U32, "ro", (1 << 1) | (1 << 3) | (1 << 4), { group: DR });
  }

  get(index, sub) {
    return this.objects.get(this.key(index, sub)) || null;
  }

  list() {
    return Array.from(this.objects.values()).sort((a, b) => a.index - b.index || a.sub - b.sub);
  }

  reply(id, data, ext = false) {
    this.bus.receive({ id, ext, data: data.slice(0, 8), dlc: Math.min(8, data.length) });
  }

  abort(index, sub, code) {
    const d = [0x80, index & 0xff, (index >> 8) & 0xff, sub & 0xff, code & 0xff, (code >> 8) & 0xff, (code >> 16) & 0xff, (code >> 24) & 0xff];
    this.reply(0x580 + this.id, d);
  }

  applyControlword(cw) {
    const prev = this.lastCw;
    this.lastCw = cw & 0xffff;
    if ((cw & 0x80) && !(prev & 0x80) && this.driveState === "fault") {
      this.driveState = "switch on disabled";
      this.faultCode = 0;
      this.errorRegister = 0;
      return;
    }
    if (this.driveState === "fault") return;
    if ((cw & 0x02) === 0) {
      if ((cw & 0x80) === 0) this.driveState = "switch on disabled";
      return;
    }
    if ((cw & 0x04) === 0) {
      this.driveState = "quick stop";
      return;
    }
    if ((cw & 0x0f) === 0x0f) this.driveState = "operation enabled";
    else if ((cw & 0x0f) === 0x07) this.driveState = "switched on";
    else if ((cw & 0x07) === 0x06) this.driveState = "ready";
  }

  statusword() {
    let sw = 0x0040;
    if (this.driveState === "ready") sw = 0x0021;
    else if (this.driveState === "switched on") sw = 0x0023;
    else if (this.driveState === "operation enabled") sw = 0x0237;
    else if (this.driveState === "quick stop") sw = 0x0007;
    else if (this.driveState === "fault") sw = 0x0008;
    if (this.driveState === "operation enabled") {
      const target = Number(this.get(0x60ff, 0).value) || 0;
      if (Math.abs(this.velocity - target) < 30) sw |= 0x0400;
    }
    return sw & 0xffff;
  }

  setValue(index, sub, value, fromUser) {
    const obj = this.get(index, sub);
    if (!obj) return 0x06020000;
    if (fromUser && (obj.access === "ro" || obj.access === "const")) return 0x06010002;
    if (typeof obj.min === "number" && value < obj.min) return 0x06090030;
    if (typeof obj.max === "number" && value > obj.max) return 0x06090030;
    obj.value = value;
    if (index === 0x6040 && sub === 0) this.applyControlword(value);
    return 0;
  }

  writeBytes(index, sub, bytes) {
    const obj = this.get(index, sub);
    if (!obj) return 0x06020000;
    if (obj.access === "ro" || obj.access === "const") return 0x06010002;
    return this.setValue(index, sub, decodeBytes(obj.type, bytes), true);
  }

  onNmt(cmd, node) {
    if (node !== 0 && node !== this.id) return;
    if (cmd === 1) this.nmt = 5;
    else if (cmd === 2) this.nmt = 4;
    else if (cmd === 128) this.nmt = 127;
    else if (cmd === 129 || cmd === 130) {
      this.nmt = 127;
      this.driveState = "switch on disabled";
      this.velocity = 0;
      this.reply(0x700 + this.id, [0]);
    }
  }

  onSdo(data) {
    if (this.nmt === 4) {
      this.abort(data[1] | (data[2] << 8), data[3], 0x08000022);
      return;
    }
    const cmd = data[0];
    const ccs = cmd >> 5;
    const index = data[1] | (data[2] << 8);
    const sub = data[3];
    if (ccs === 2) {
      const obj = this.get(index, sub);
      if (!obj) return this.abort(index, sub, 0x06020000);
      if (obj.access === "wo") return this.abort(index, sub, 0x06010001);
      const bytes = Buffer.from(encodeObject(obj));
      if (bytes.length <= 4) {
        const n = 4 - bytes.length;
        const out = [0x43 | (n << 2), index & 0xff, (index >> 8) & 0xff, sub, 0, 0, 0, 0];
        for (let i = 0; i < bytes.length; i++) out[4 + i] = bytes[i];
        this.reply(0x580 + this.id, out);
      } else {
        this.up = { bytes, offset: 0, toggle: 0 };
        this.reply(0x580 + this.id, [0x41, index & 0xff, (index >> 8) & 0xff, sub, bytes.length & 0xff, (bytes.length >> 8) & 0xff, (bytes.length >> 16) & 0xff, (bytes.length >> 24) & 0xff]);
      }
      return;
    }
    if (ccs === 3) {
      if (!this.up) return this.abort(index, sub, 0x05040001);
      const toggle = (cmd >> 4) & 1;
      if (toggle !== this.up.toggle) return this.abort(0, 0, 0x05030000);
      const left = this.up.bytes.length - this.up.offset;
      const chunk = Math.min(7, left);
      const last = this.up.offset + chunk >= this.up.bytes.length;
      const n = 7 - chunk;
      const out = [(this.up.toggle << 4) | (n << 1) | (last ? 1 : 0), 0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < chunk; i++) out[1 + i] = this.up.bytes[this.up.offset + i];
      this.up.offset += chunk;
      this.up.toggle ^= 1;
      if (last) this.up = null;
      this.reply(0x580 + this.id, out);
      return;
    }
    if (ccs === 1) {
      const expedited = (cmd & 0x02) !== 0;
      if (expedited) {
        const n = (cmd >> 2) & 3;
        const len = (cmd & 0x01) ? 4 - n : 4;
        const code = this.writeBytes(index, sub, data.slice(4, 4 + len));
        if (code) return this.abort(index, sub, code);
        this.reply(0x580 + this.id, [0x60, index & 0xff, (index >> 8) & 0xff, sub, 0, 0, 0, 0]);
      } else {
        const size = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
        this.down = { index, sub, size, buf: Buffer.alloc(0), toggle: 0 };
        this.reply(0x580 + this.id, [0x60, index & 0xff, (index >> 8) & 0xff, sub, 0, 0, 0, 0]);
      }
      return;
    }
    if (ccs === 0 && this.down) {
      const toggle = (cmd >> 4) & 1;
      if (toggle !== this.down.toggle) return this.abort(this.down.index, this.down.sub, 0x05030000);
      const n = (cmd >> 1) & 7;
      const last = (cmd & 1) !== 0;
      const len = 7 - n;
      this.down.buf = Buffer.concat([this.down.buf, Buffer.from(data.slice(1, 1 + len))]);
      this.down.toggle ^= 1;
      let code = 0;
      let index = this.down.index;
      let sub = this.down.sub;
      if (last) {
        const job = this.down;
        this.down = null;
        index = job.index;
        sub = job.sub;
        code = this.writeBytes(job.index, job.sub, job.buf.subarray(0, job.size || job.buf.length));
      }
      if (code) return this.abort(index, sub, code);
      this.reply(0x580 + this.id, [0x20 | (toggle << 4), 0, 0, 0, 0, 0, 0, 0]);
    }
  }

  mapped(countIndex) {
    const countObj = this.get(countIndex, 0);
    const count = Math.min(8, Number(countObj && countObj.value) || 0);
    const maps = [];
    for (let i = 1; i <= count; i++) {
      const raw = this.get(countIndex, i);
      const entry = raw && mapFromObject(raw.value);
      if (entry && entry.bits) maps.push(entry);
    }
    return maps;
  }

  onRpdo(id, data) {
    if (this.nmt !== 5) return;
    const cob = this.get(0x1400, 1);
    if (!cob || (Number(cob.value) & 0x7ff) !== id) return;
    unpackBits(this.mapped(0x1600), data, (index, sub, value) => {
      const obj = this.get(index, sub);
      if (!obj) return;
      if (obj.type === dcf.DT.UNSIGNED8 || obj.type === dcf.DT.UNSIGNED16 || obj.type === dcf.DT.UNSIGNED32) {
        value = value >>> 0;
      }
      this.setValue(index, sub, value, false);
    });
  }

  onSync() {
    if (this.nmt !== 5) return;
    const tt = Number(this.get(0x1800, 2).value);
    if (tt >= 1 && tt <= 240) this.emitTpdo();
  }

  emitTpdo() {
    const cob = Number(this.get(0x1800, 1).value) >>> 0;
    if (cob & 0x80000000) return;
    const data = packBits(this.mapped(0x1a00), (index, sub) => {
      const obj = this.get(index, sub);
      return obj ? obj.value : 0;
    });
    while (data.length < 8) data.push(0);
    this.reply(cob & 0x7ff, data);
  }

  onJ1939(id, data) {
    const parsed = parseJ1939(id);
    if (parsed.pgn !== 0) return;
    const sa = Number(this.get(0x2003, 1).value) & 0xff;
    if (parsed.da != null && parsed.da !== sa && parsed.da !== 0xff) return;
    const mode = data[0] & 0x03;
    const speedRaw = data[1] | (data[2] << 8);
    const torqueRaw = data[3];
    if ((mode === 1 || mode === 3) && speedRaw !== 0xffff) {
      this.setValue(0x60ff, 0, Math.round(speedRaw * 0.125), false);
      this.setValue(0x6060, 0, 3, false);
    }
    if ((mode === 2 || mode === 3) && torqueRaw !== 0xff) {
      const pct = torqueRaw - 125;
      this.setValue(0x6071, 0, Math.round(pct * 10), false);
      if (mode === 2) this.setValue(0x6060, 0, 4, false);
    }
  }

  onUds(data) {
    const sid = data[0];
    if (sid === 0x3e) return this.reply(0x7e8, [0x7e, data[1] || 0]);
    if (sid === 0x22 && data[1] === 0xf1 && data[2] === 0x94) {
      const name = Buffer.from("WB-DEMO", "ascii");
      return this.reply(0x7e8, [0x62, 0xf1, 0x94, ...name.subarray(0, 5)]);
    }
    if (sid === 0x10) return this.reply(0x7e8, [0x50, data[1] || 1]);
    this.reply(0x7e8, [0x7f, sid || 0, 0x11]);
  }

  raiseFault(code) {
    this.faultCode = code & 0xffff;
    this.driveState = "fault";
    if (code === 0x2310) this.errorRegister = 0x02;
    else if (code === 0x3210 || code === 0x3220) this.errorRegister = 0x04;
    else if (code === 0x4210) this.errorRegister = 0x08;
    else this.errorRegister = 0x01;
    this.syncLive(true);
    this.reply(0x080 + this.id, [
      this.faultCode & 0xff,
      (this.faultCode >> 8) & 0xff,
      this.errorRegister & 0xff,
      0, 0, 0, 0, 0,
    ]);
  }

  syncLive() {
    const set = (index, sub, value) => {
      const obj = this.get(index, sub);
      if (obj) obj.value = value;
    };
    set(0x606c, 0, Math.round(this.velocity));
    set(0x6064, 0, Math.round(this.positionCounts));
    set(0x6077, 0, Math.round(this.torque));
    set(0x6078, 0, Math.round(this.current));
    set(0x2100, 1, Math.round(this.vdc));
    set(0x2100, 2, Math.round(this.tempM * 10));
    set(0x2100, 3, Math.round(this.tempC * 10));
    set(0x2100, 4, Math.round(this.current));
    set(0x6041, 0, this.statusword());
    set(0x6061, 0, Number(this.get(0x6060, 0).value) || 0);
    set(0x1001, 0, this.errorRegister & 0xff);
    set(0x603f, 0, this.faultCode & 0xffff);
    set(0x2002, 6, this.driveState === "operation enabled" ? 0x01 : 0x00);
  }

  tick(dt, cli) {
    const enabled = this.driveState === "operation enabled" && this.nmt === 5;
    const mode = Number(this.get(0x6060, 0).value) || 3;
    const maxV = Number(this.get(0x2001, 2).value) || 6000;
    const accel = Number(this.get(0x2001, 3).value) || 2000;
    const decel = Number(this.get(0x2001, 4).value) || 2000;
    let target = clamp(Number(this.get(0x60ff, 0).value) || 0, -maxV, maxV);
    if (!enabled) {
      const rate = this.driveState === "quick stop" ? decel * 2 : decel;
      this.velocity = moveToward(this.velocity, 0, rate * dt);
    } else if (mode === 4) {
      const tq = Number(this.get(0x6071, 0).value) || 0;
      const aim = clamp(tq / 10, -100, 100) / 100 * maxV;
      this.velocity = moveToward(this.velocity, aim, accel * dt);
    } else {
      const speedingUp = Math.abs(target) > Math.abs(this.velocity) && Math.sign(target || 1) === Math.sign(this.velocity || target || 1);
      this.velocity = moveToward(this.velocity, target, (speedingUp ? accel : decel) * dt);
    }
    const ppr = Number(this.get(0x2000, 4).value) || 1024;
    this.positionCounts += (this.velocity / 60) * ppr * dt;

    const maxTq = Number(this.get(0x2001, 1).value) || 1000;
    if (mode === 4 && enabled) this.torque = clamp(Number(this.get(0x6071, 0).value) || 0, -maxTq, maxTq);
    else {
      const err = (enabled ? target : 0) - this.velocity;
      this.torque = clamp(err * 2, -maxTq, maxTq);
    }
    const rated = Number(this.get(0x2000, 2).value) || 2000;
    this.current = (this.torque / 1000) * rated;
    const sag = Math.abs(this.current) * 0.04;
    this.vdc = 5200 - sag;
    const cutS = Number(this.get(0x2001, 5).value) || 4000;
    const cutE = Number(this.get(0x2001, 6).value) || 3200;
    if (this.vdc < cutS) {
      const cut = clamp((this.vdc - cutE) / Math.max(1, cutS - cutE), 0, 1);
      this.torque *= cut;
      this.current *= cut;
    }
    const load = Math.min(1, Math.abs(this.current) / Math.max(1, rated));
    this.tempM += ((35 + load * 45) - this.tempM) * dt * 0.08;
    this.tempC += ((32 + load * 25) - this.tempC) * dt * 0.08;
    this.syncLive();

    this.hbAcc += dt * 1000;
    const hb = Number(this.get(0x1017, 0).value) || 0;
    if (hb > 0 && this.hbAcc >= hb) {
      this.hbAcc = 0;
      const state = this.nmt === 5 ? 5 : this.nmt === 4 ? 4 : 127;
      this.reply(0x700 + this.id, [state]);
    }
    this.pdoAcc += dt * 1000;
    const event = Number(this.get(0x1800, 5).value) || 0;
    if (this.nmt === 5 && event > 0 && this.pdoAcc >= event) {
      this.pdoAcc = 0;
      this.emitTpdo();
    }
    if (cli) {
      this.cliAcc += dt * 1000;
      if (this.cliAcc >= 1000) {
        this.cliAcc = 0;
        const text = `spd=${Math.round(this.velocity)} tq=${(this.torque / 10).toFixed(1)}`;
        const bytes = Array.from(Buffer.from(text, "ascii").subarray(0, 8));
        this.reply(0x7f0, bytes);
      }
    }
  }
}

function moveToward(value, target, step) {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}

class Workbench {
  constructor() {
    this.version = VERSION;
    this.baud = 1000;
    this.busOn = true;
    this.cli = false;
    this.filters = {};
    for (const name of FILTER_NAMES) this.filters[name] = true;
    this.selectedNode = 1;
    this.sdoTimeout = 1000;
    this.accessLevel = "engineer";
    this.j1939Tool = 0xfa;
    this.helperMode = "offline";
    this.dcfDoc = null;
    this.dcfName = "";
    this.dcfPath = "";
    this.dcfDirty = false;
    this.dictEpoch = 1;
    this.frames = [];
    this.frameSeq = 0;
    this.logEpoch = 1;
    this.infoLines = [];
    this.infoSeq = 0;
    this.infoEpoch = 1;
    this.trace = { armed: false, epoch: 1, seq: 0, points: [] };
    this.recording = false;
    this.record = [];
    this.j1939Hold = null;
    this.txHold = null;
    this.progress = "";
    this.panels = { can: true, info: true, command: true, helper: true };
    this.started = 0;
    this.timer = null;
    this.persist = true;
    this.sdoJob = null;
    this.history = [];
    this.pluginsDir = path.join(__dirname, "..", "plugins");
    this.node = new VirtualNode(this);
    this.adapter = "virtual";
    this.adapterName = "";
    this.hw = null;
    this.remoteNmt = null;
    this.remoteFault = 0;
    this.remoteName = "";
    this.updateOffer = null;
    this.loadSettings();
  }

  loadSettings() {
    try {
      const { file } = settingsPath();
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (BAUDS.includes(saved.baud)) this.baud = saved.baud;
      if (saved.filters) {
        for (const name of FILTER_NAMES) {
          if (typeof saved.filters[name] === "boolean") this.filters[name] = saved.filters[name];
        }
      }
      if (saved.accessLevel === "operator" || saved.accessLevel === "engineer") this.accessLevel = saved.accessLevel;
      if (saved.sdoTimeout) this.sdoTimeout = saved.sdoTimeout;
      if (saved.panels) Object.assign(this.panels, saved.panels);
      if (saved.cli != null) this.cli = !!saved.cli;
    } catch {
      /* first launch */
    }
  }

  saveSettings() {
    if (!this.persist) return;
    try {
      const { dir, file } = settingsPath();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        baud: this.baud,
        filters: this.filters,
        accessLevel: this.accessLevel,
        sdoTimeout: this.sdoTimeout,
        panels: this.panels,
        cli: this.cli,
      }, null, 2));
    } catch {
      /* settings are a convenience */
    }
  }

  start() {
    if (this.timer) return;
    this.started = Date.now();
    this.info("Z-DVT Workbench is ready. Crafted by Z-Jomant Meister.", "help");
    this.info("A practice controller is already on the bus as number " + this.node.id + ". It stays paused until you allow it to run.", "info");
    if (process.platform === "darwin") {
      this.info("On this Mac, Connect virtual CAN runs the practice controller. Connect IXXAT uses the Windows VCI library (vcinpl.dll).", "info");
    } else {
      this.info("CAN menu, Connect IXXAT, talks to the dongle through the VCI library. The practice controller pauses, and the Tcl license DLL is not loaded.", "info");
    }
    this.info("Follow the four steps: find the controller, allow it to run, spin the shaft, then check the 3 phases.", "info");
    this.node.reply(0x700 + this.node.id, [0]);
    this.timer = setInterval(() => this.tick(0.1), 100);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closeHardware();
    this.saveSettings();
  }

  closeHardware() {
    if (this.hw) {
      try { this.hw.close(); } catch (err) { this.info(err.message, "error"); }
      this.hw = null;
    }
    this.adapterName = "";
    this.remoteNmt = null;
    this.remoteFault = 0;
    if (this.adapter === "ixxat") this.adapter = "virtual";
  }

  connectVirtual() {
    this.closeHardware();
    this.adapter = "virtual";
    this.remoteName = "";
    this.busOn = true;
    this.info("Virtual CAN connected. The practice controller is on the bus.", "help");
  }

  connectIxxat() {
    if (this.hw) {
      try { this.hw.close(); } catch { /* reconnect replaces the open dongle */ }
      this.hw = null;
    }
    this.adapter = "virtual";
    this.adapterName = "";
    const port = ixxat.open({ bitrateK: this.baud, channel: 0 });
    this.hw = port;
    this.adapter = "ixxat";
    this.adapterName = port.label();
    this.remoteNmt = null;
    this.remoteFault = 0;
    this.remoteName = "";
    this.busOn = true;
    this.info("IXXAT connected: " + this.adapterName + " at " + this.baud + " kbit/s. The practice controller is paused.", "help");
  }

  pollHardware() {
    if (!this.hw) return;
    let batch;
    try {
      batch = this.hw.poll(64);
    } catch (err) {
      this.info(err.message, "error");
      return;
    }
    for (const note of batch.notes) this.info(note, "error");
    for (const frame of batch.frames) {
      this.noteRemote(frame);
      this.receive(frame);
    }
  }

  noteRemote(frame) {
    if (frame.ext) return;
    const id = frame.id >>> 0;
    const data = frame.data || [];
    if (id === 0x700 + this.selectedNode && data.length) this.remoteNmt = data[0];
    if (id === 0x080 + this.selectedNode && data.length >= 2) this.remoteFault = data[0] | (data[1] << 8);
  }

  info(text, level = "info") {
    this.infoSeq += 1;
    this.infoLines.push({ n: this.infoSeq, level, text: String(text) });
    if (this.infoLines.length > 1500) this.infoLines.splice(0, this.infoLines.length - 1500);
  }

  receive(frame) {
    this.pushFrame(Object.assign({ dir: "rx" }, frame));
  }

  transmit(frame) {
    this.pushFrame(Object.assign({ dir: "tx" }, frame));
    if (!this.busOn) return;
    if (this.adapter === "ixxat") {
      if (!this.hw) return;
      try { this.hw.write(frame); } catch (err) { this.info(err.message, "error"); }
      return;
    }
    const id = frame.id;
    const data = frame.data;
    if (!frame.ext && id === 0x000) this.node.onNmt(data[0], data[1]);
    else if (!frame.ext && id === 0x600 + this.node.id) this.node.onSdo(data);
    else if (!frame.ext && id === 0x080) this.node.onSync();
    else if (!frame.ext && id === (0x7e0)) this.node.onUds(data);
    else if (frame.ext) this.node.onJ1939(id, data);
    else this.node.onRpdo(id, data);
  }

  pushFrame(frame) {
    const type = classify(frame);
    const row = {
      n: ++this.frameSeq,
      t: this.started ? (Date.now() - this.started) / 1000 : 0,
      id: frame.id >>> 0,
      ext: !!frame.ext,
      dir: frame.dir,
      type,
      data: Array.from(frame.data || []).slice(0, frame.dlc || (frame.data || []).length),
      text: "",
    };
    row.text = this.describe(row);
    this.frames.push(row);
    if (this.frames.length > 2000) this.frames.splice(0, this.frames.length - 2000);
    if (this.recording) {
      this.record.push(row);
      if (this.record.length > 50000) this.record.shift();
    }
    if (this.sdoJob && row.dir === "rx" && row.id === 0x580 + this.sdoJob.node) this.feedSdo(row);
  }

  describe(frame) {
    const id = frame.id;
    const d = frame.data;
    if (frame.type === "nmt" && id === 0) {
      const cmds = { 1: "Start", 2: "Stop", 128: "Pre-operational", 129: "Reset node", 130: "Reset communication" };
      return `NMT ${cmds[d[0]] || "command " + d[0]} node ${d[1] === 0 ? "all" : d[1]}`;
    }
    if (frame.type === "nmt" && id >= 0x700) {
      const st = { 0: "boot-up", 4: "stopped", 5: "operational", 127: "pre-operational" };
      return `Heartbeat node ${id - 0x700} ${st[d[0]] || d[0]}`;
    }
    if (frame.type === "sync") return "SYNC";
    if (frame.type === "emcy") {
      const code = d[0] | (d[1] << 8);
      return `EMCY node ${id - 0x80} ${EMCY_TEXT[code] || "code 0x" + dcf.padHex(code, 4)}`;
    }
    if (frame.type === "sdo") {
      const index = d[1] | (d[2] << 8);
      const sub = d[3];
      const scs = d[0] >> 5;
      const where = `0x${dcf.padHex(index, 4)}:${sub}`;
      if (d[0] === 0x40) return `SDO upload ${where}`;
      if (scs === 1) return `SDO download ${where}`;
      if (d[0] === 0x80) {
        const code = d[4] | (d[5] << 8) | (d[6] << 16) | (d[7] << 24);
        return `SDO abort ${where} 0x${dcf.padHex(code, 8)}`;
      }
      if (scs === 2 || scs === 0) return `SDO response ${where}`;
      if (d[0] === 0x60) return `SDO write ok ${where}`;
      return `SDO ${where}`;
    }
    if (frame.type === "pdo") return `PDO 0x${hexId(id, false)} ${d.map((b) => dcf.padHex(b, 2)).join(" ")}`;
    if (frame.type === "j1939") {
      const p = parseJ1939(id);
      if (p.pgn === 0) {
        const speed = d[1] | (d[2] << 8);
        const tq = d[3];
        return `TSC1 DA ${p.da} SA 0x${dcf.padHex(p.sa, 2)} speed ${speed === 0xffff ? "n/a" : (speed * 0.125).toFixed(0) + " rpm"} torque ${tq === 0xff ? "n/a" : (tq - 125) + "%"}`;
      }
      return `J1939 PGN ${p.pgn} SA 0x${dcf.padHex(p.sa, 2)}`;
    }
    if (frame.type === "debug") return "CLI " + Buffer.from(d).toString("ascii").replace(/[^\x20-\x7e]/g, "");
    if (frame.type === "uds") return "UDS " + d.map((b) => dcf.padHex(b, 2)).join(" ");
    return frame.type.toUpperCase();
  }

  tick(dt) {
    if (this.busOn && this.adapter === "ixxat") this.pollHardware();
    else if (this.busOn) this.node.tick(dt, this.cli);
    if (this.trace.armed) {
      this.trace.seq += 1;
      this.trace.points.push({
        n: this.trace.seq,
        t: this.started ? (Date.now() - this.started) / 1000 : 0,
        velocity: this.adapter === "ixxat" ? 0 : Math.round(this.node.velocity),
        torque: this.adapter === "ixxat" ? 0 : Math.round(this.node.torque) / 10,
        current: this.adapter === "ixxat" ? 0 : Math.round(this.node.current) / 10,
        vdc: this.adapter === "ixxat" ? 0 : Math.round(this.node.vdc) / 10,
      });
      if (this.trace.points.length > 800) this.trace.points.splice(0, this.trace.points.length - 800);
    }
    if (this.j1939Hold && this.busOn) this.sendTsc1(this.j1939Hold);
    if (this.txHold && this.busOn) {
      this.txHold.acc = (this.txHold.acc || 0) + dt * 1000;
      if (this.txHold.acc >= this.txHold.every) {
        this.txHold.acc = 0;
        this.transmit({ id: this.txHold.id, ext: this.txHold.ext, data: this.txHold.data.slice(), dlc: this.txHold.data.length });
      }
    }
  }

  sendTsc1(hold) {
    hold.acc = (hold.acc || 0) + 100;
    if (hold.acc < 50) return;
    hold.acc = 0;
    const sa = this.j1939Tool & 0xff;
    const da = hold.dest & 0xff;
    let mode = 0;
    if (hold.speedOn && hold.torqueOn) mode = 3;
    else if (hold.speedOn) mode = 1;
    else if (hold.torqueOn) mode = 2;
    const speedRaw = hold.speedOn ? clamp(Math.round(hold.speedRpm * 8), 0, 65534) : 0xffff;
    const torqueRaw = hold.torqueOn ? clamp(Math.round(hold.torquePct + 125), 0, 250) : 0xff;
    const data = [mode, speedRaw & 0xff, (speedRaw >> 8) & 0xff, torqueRaw, 0xff, 0xff, 0xff, 0xff];
    this.transmit({ id: j1939Id(3, 0, da, sa), ext: true, data, dlc: 8 });
  }

  failSdo(message) {
    const job = this.sdoJob;
    if (!job || job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    this.sdoJob = null;
    job.reject(new Error(message));
  }

  beginSdo(node, index, sub) {
    if (this.sdoJob && !this.sdoJob.done) this.failSdo("SDO replaced");
    const job = { node, index, sub, done: false, toggle: 0, buf: Buffer.alloc(0), size: null };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.timer = setTimeout(() => this.failSdo("SDO timeout"), this.sdoTimeout);
    this.sdoJob = job;
    return { job, promise };
  }

  finishSdo(value) {
    const job = this.sdoJob;
    if (!job || job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    this.sdoJob = null;
    job.resolve(value);
  }

  feedSdo(frame) {
    const job = this.sdoJob;
    if (!job || job.done) return;
    const data = frame.data.concat([0, 0, 0, 0, 0, 0, 0, 0]).slice(0, 8);
    const cmd = data[0];
    const scs = cmd >> 5;
    if (scs === 2 || scs === 3 || scs === 4) {
      const index = data[1] | (data[2] << 8);
      const sub = data[3];
      if (!(scs === 4 && index === 0) && (index !== job.index || sub !== job.sub)) return;
    }
    if (cmd === 0x80) {
      const code = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
      this.failSdo("SDO abort 0x" + dcf.padHex(code >>> 0, 8));
      return;
    }
    if (job.op === "read" && scs === 2) {
      if (cmd & 0x02) {
        const n = (cmd & 0x01) ? (cmd >> 2) & 3 : 0;
        const len = (cmd & 0x01) ? 4 - n : 4;
        this.finishSdo(Buffer.from(data.slice(4, 4 + len)));
      } else {
        if (cmd & 0x01) job.size = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
        job.toggle = 0;
        this.transmit(this.sdoFrame(job.node, [0x60, 0, 0, 0, 0, 0, 0, 0]));
      }
      return;
    }
    if (job.op === "read" && scs === 0) {
      const toggle = (cmd >> 4) & 1;
      if (toggle !== job.toggle) return this.failSdo("SDO toggle");
      const n = (cmd >> 1) & 7;
      const last = cmd & 1;
      const len = 7 - n;
      job.buf = Buffer.concat([job.buf, Buffer.from(data.slice(1, 1 + len))]);
      if (last || (job.size != null && job.buf.length >= job.size)) {
        const out = job.size != null ? job.buf.subarray(0, job.size) : job.buf;
        this.finishSdo(out);
      } else {
        job.toggle ^= 1;
        this.transmit(this.sdoFrame(job.node, [0x60 | (job.toggle << 4), 0, 0, 0, 0, 0, 0, 0]));
      }
      return;
    }
    if (job.op === "write" && scs === 3 && !job.started) {
      job.started = true;
      if (job.payload.length <= 4) {
        this.finishSdo(true);
        return;
      }
      this.writeNextSegment(job);
      return;
    }
    if (job.op === "write" && scs === 1 && job.started) {
      const toggle = (cmd >> 4) & 1;
      if (toggle !== job.toggle) return this.failSdo("SDO toggle");
      if (job.offset >= job.payload.length) this.finishSdo(true);
      else {
        job.toggle ^= 1;
        this.writeNextSegment(job);
      }
    }
  }

  writeNextSegment(job) {
    const chunk = Math.min(7, job.payload.length - job.offset);
    const n = 7 - chunk;
    const last = job.offset + chunk >= job.payload.length;
    const bytes = [((job.toggle << 4) | (n << 1) | (last ? 1 : 0)), 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < chunk; i++) bytes[1 + i] = job.payload[job.offset + i];
    job.offset += chunk;
    this.transmit(this.sdoFrame(job.node, bytes));
  }

  sdoFrame(node, data) {
    const bytes = data.concat([0, 0, 0, 0, 0, 0, 0, 0]).slice(0, 8);
    return { id: 0x600 + node, ext: false, data: bytes, dlc: 8 };
  }

  async readRaw(node, index, sub) {
    if (!this.busOn) throw new Error("CAN is stopped");
    const { job, promise } = this.beginSdo(node, index, sub);
    job.op = "read";
    this.transmit(this.sdoFrame(node, [0x40, index & 0xff, (index >> 8) & 0xff, sub & 0xff, 0, 0, 0, 0]));
    return promise;
  }

  async writeRaw(node, index, sub, payload) {
    if (!this.busOn) throw new Error("CAN is stopped");
    if (this.accessLevel !== "engineer") throw new Error("Operator level cannot write. Switch to Engineer under Settings.");
    const { job, promise } = this.beginSdo(node, index, sub);
    job.op = "write";
    job.payload = Buffer.from(payload);
    job.offset = 0;
    job.started = false;
    job.toggle = 0;
    if (job.payload.length <= 4) {
      const n = 4 - job.payload.length;
      const bytes = [0x23 | (n << 2), index & 0xff, (index >> 8) & 0xff, sub & 0xff, 0, 0, 0, 0];
      for (let i = 0; i < job.payload.length; i++) bytes[4 + i] = job.payload[i];
      this.transmit(this.sdoFrame(node, bytes));
    } else {
      const size = job.payload.length;
      this.transmit(this.sdoFrame(node, [0x21, index & 0xff, (index >> 8) & 0xff, sub & 0xff, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff]));
    }
    return promise;
  }

  liveObject(index, sub) {
    return this.node.get(index, sub);
  }

  async readObject(node, index, sub) {
    const obj = node === this.node.id ? this.liveObject(index, sub) : null;
    const type = obj ? obj.type : dcf.DT.UNSIGNED32;
    const bytes = await this.readRaw(node, index, sub);
    const value = obj ? decodeBytes(obj.type, bytes) : decodeBytes(type, bytes);
    return { value, bytes, obj };
  }

  objectForWrite(node, index, sub, rawValue) {
    const live = node === this.node.id ? this.liveObject(index, sub) : null;
    if (live) return live;
    const fromFile = this.dcfDoc && this.dcfDoc.objects.find((item) => item.index === index && item.sub === sub);
    if (fromFile) return Object.assign({}, fromFile);
    if (this.adapter !== "ixxat") return null;
    const numeric = parseUserNumber(rawValue);
    if (Number.isFinite(numeric)) {
      const type = !Number.isInteger(numeric) ? dcf.DT.REAL32 : numeric < 0 ? dcf.DT.INTEGER32 : dcf.DT.UNSIGNED32;
      return { index, sub, name: "Object", type, access: "rw", value: numeric };
    }
    return { index, sub, name: "Object", type: dcf.DT.VISIBLE_STRING, access: "rw", value: String(rawValue) };
  }

  async writeObject(node, index, sub, rawValue) {
    const obj = this.objectForWrite(node, index, sub, rawValue);
    if (!obj) throw new Error("Object 0x" + dcf.padHex(index, 4) + ":" + sub + " is not in the demo dictionary");
    let value = rawValue;
    if (obj.type === dcf.DT.VISIBLE_STRING) value = String(rawValue);
    else if (obj.type === dcf.DT.REAL32) value = Number(rawValue);
    else value = parseUserNumber(rawValue);
    if (obj.type !== dcf.DT.VISIBLE_STRING && !Number.isFinite(value)) throw new Error("Value is not a number");
    if (obj.access === "ro" || obj.access === "const") throw new Error("Object is read-only");
    if (typeof obj.min === "number" && value < obj.min) throw new Error("Value is out of range");
    if (typeof obj.max === "number" && value > obj.max) throw new Error("Value is out of range");
    const payload = encodeObject({ type: obj.type, value });
    await this.writeRaw(node, index, sub, payload);
    if (this.adapter === "ixxat") {
      obj.value = value;
      if (node === this.node.id) {
        const live = this.liveObject(index, sub);
        if (live && live !== obj) live.value = value;
      }
    }
    if (node === this.node.id) return this.liveObject(index, sub) || obj;
    return obj;
  }

  nmt(cmd, node) {
    const map = { start: 1, stop: 2, preop: 128, "pre-op": 128, reset: 129, resetcomm: 130 };
    const byte = typeof cmd === "number" ? cmd : map[String(cmd).toLowerCase()];
    if (byte == null) throw new Error("NMT command must be start, stop, preop, or reset");
    this.transmit({ id: 0, ext: false, data: [byte, node & 0x7f], dlc: 2 });
  }

  async ping(nodeId) {
    const node = nodeId || this.selectedNode;
    this.selectedNode = node;
    try {
      const name = await this.readObject(node, 0x1008, 0);
      const type = await this.readObject(node, 0x1000, 0);
      this.helperMode = "online";
      this.dcfDoc = null;
      this.dcfDirty = false;
      this.dictEpoch += 1;
      this.remoteName = String(name.value);
      const nmt = this.adapter === "ixxat" && this.remoteNmt == null ? "no heartbeat yet" : this.nmtName().toLowerCase();
      this.info(`Ping node ${node}: ${name.value} (${nmt}), device type 0x${dcf.padHex(type.value, 8)}`, "help");
      return { ok: true, name: name.value };
    } catch (err) {
      this.helperMode = "offline";
      this.info(`Ping node ${node} failed: ${err.message}`, "error");
      return { ok: false, error: err.message };
    }
  }

  openDcfText(text, name, filePath) {
    this.dcfDoc = dcf.parseDcf(text);
    this.dcfName = name || "untitled.dcf";
    this.dcfPath = filePath || "";
    this.dcfDirty = false;
    this.helperMode = "dcf";
    this.dictEpoch += 1;
    this.info(`Opened ${this.dcfName} (${this.dcfDoc.objects.length} objects)`, "help");
  }

  editDcf(index, sub, rawValue) {
    if (!this.dcfDoc || this.helperMode !== "dcf") throw new Error("No DCF is open");
    const obj = this.dcfDoc.objects.find((item) => item.index === index && item.sub === sub);
    if (!obj) throw new Error("Object is not in this DCF");
    if (!dcf.isWritableAccess(obj.access)) throw new Error("Object is read-only in the file");
    if (obj.type === dcf.DT.VISIBLE_STRING) obj.value = String(rawValue);
    else if (obj.type === dcf.DT.REAL32) obj.value = Number(rawValue);
    else obj.value = parseUserNumber(rawValue);
    if (obj.type !== dcf.DT.VISIBLE_STRING && !Number.isFinite(obj.value)) throw new Error("Value is not a number");
    obj.hasValue = true;
    obj.dirty = true;
    this.dcfDirty = true;
  }

  closeDcf(save) {
    let text = "";
    if (save && this.dcfDoc) text = dcf.serializeDcf(this.dcfDoc);
    if (save && this.dcfPath && text) {
      fs.writeFileSync(this.dcfPath, text);
      this.info("Saved " + this.dcfPath, "help");
    }
    this.dcfDoc = null;
    this.dcfName = "";
    this.dcfPath = "";
    this.dcfDirty = false;
    this.helperMode = "offline";
    this.dictEpoch += 1;
    return { text };
  }

  async sendDcf(nodeId) {
    if (!this.dcfDoc) throw new Error("Open a DCF first");
    const node = nodeId || this.selectedNode;
    const list = this.dcfDoc.objects.filter((obj) => obj.hasValue && dcf.isWritableAccess(obj.access));
    let wrote = 0;
    let failed = 0;
    for (const obj of list) {
      this.progress = `Sending DCF ${wrote + failed + 1}/${list.length}`;
      try {
        if (node === this.node.id && this.liveObject(obj.index, obj.sub)) {
          await this.writeObject(node, obj.index, obj.sub, obj.value);
          wrote += 1;
        } else if (node === this.node.id) {
          failed += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
    this.progress = "";
    this.info(`DCF send finished. Wrote ${wrote}, skipped or failed ${failed}.`, failed ? "error" : "help");
    return { wrote, failed };
  }

  pullDcf() {
    const objects = this.node.list().filter((obj) => obj.sub !== 0 || obj.type !== dcf.DT.UNSIGNED8 || obj.name.indexOf("parameter") === -1);
    const text = dcf.buildDcf(this.node.list(), {
      fileName: "node-" + this.node.id,
      nodeId: this.node.id,
      nodeName: String(this.node.get(0x1008, 0).value),
      baud: this.baud,
    });
    this.openDcfText(text, `node-${this.node.id}.dcf`, "");
    this.info("Uploaded the live dictionary into the DCF editor. Save it from the helper.", "help");
    return { text, count: objects.length };
  }

  describeValue(obj, value) {
    if (!obj) return String(value);
    if (obj.type === dcf.DT.VISIBLE_STRING) return `"${value}"`;
    if (obj.type === dcf.DT.REAL32) return Number(value).toString();
    if (obj.enum) {
      const hit = obj.enum.find((item) => item.v === Number(value));
      if (hit) return `${value} (${hit.t})`;
    }
    const hex = "0x" + dcf.padHex(value, obj.type === dcf.DT.UNSIGNED8 || obj.type === dcf.DT.INTEGER8 ? 2 : obj.type === dcf.DT.UNSIGNED16 || obj.type === dcf.DT.INTEGER16 ? 4 : 8);
    return obj.unit ? `${value} ${obj.unit} (${hex})` : `${value} (${hex})`;
  }

  async execute(line) {
    const text = String(line || "").trim();
    if (!text) return { ok: true };
    this.history.push(text);
    const parts = tokenize(text);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1);
    const need = (n) => {
      if (arg.length < n) throw new Error(cmd + " needs more arguments. Type help " + cmd);
    };
    if (cmd === "help") {
      const key = (arg[0] || "").toLowerCase();
      const rows = helpRows().filter((row) => !key || row.name.includes(key) || row.summary.toLowerCase().includes(key));
      if (!rows.length) this.info("No help matched.", "error");
      for (const row of rows) this.info(row.name.padEnd(18, " ") + row.summary, "help");
      return { ok: true };
    }
    if (cmd === "about") {
      this.info("Z-DVT Workbench " + VERSION + ". Crafted by Z-Jomant Meister.", "help");
      return { ok: true };
    }
    if (cmd === "clear") {
      this.infoLines = [];
      this.infoEpoch += 1;
      return { ok: true };
    }
    if (cmd === "clearcan") {
      this.frames = [];
      this.logEpoch += 1;
      return { ok: true };
    }
    if (cmd === "baud") {
      need(1);
      const rate = parseInt(arg[0], 10);
      if (!BAUDS.includes(rate)) throw new Error("Bitrate must be one of " + BAUDS.join(", "));
      this.baud = rate;
      const obj = this.node.get(0x2003, 2);
      if (obj) obj.value = rate;
      if (this.adapter === "ixxat" && this.hw) {
        this.hw.applyBitrate(rate);
        this.info("IXXAT bitrate set to " + rate + " kbit/s", "info");
      } else {
        this.info("CAN bitrate set to " + rate + " kbit/s", "info");
      }
      this.saveSettings();
      return { ok: true };
    }
    if (cmd === "cli") {
      this.cli = arg[0] === "on" || arg[0] === "1";
      this.info("CLI debug " + (this.cli ? "on" : "off"), "info");
      this.saveSettings();
      return { ok: true };
    }
    if (cmd === "filter") {
      const which = (arg[0] || "").toLowerCase();
      if (which === "all") {
        for (const name of FILTER_NAMES) this.filters[name] = true;
      } else if (which === "none") {
        for (const name of FILTER_NAMES) this.filters[name] = false;
      } else if (which === "defaults") {
        for (const name of FILTER_NAMES) this.filters[name] = name === "nmt" || name === "emcy";
      } else if (!FILTER_NAMES.includes(which)) {
        throw new Error("Unknown filter. Use " + FILTER_NAMES.join(", ") + ", all, none, defaults");
      } else {
        this.filters[which] = arg[1] === "off" || arg[1] === "0" ? false : arg[1] === "on" || arg[1] === "1" ? true : !this.filters[which];
      }
      this.saveSettings();
      this.info("CAN filters updated", "info");
      return { ok: true };
    }
    if (cmd === "ping") {
      const node = arg[0] ? parseInt(arg[0], 10) : this.selectedNode;
      return this.ping(node);
    }
    if (cmd === "nodes" || cmd === "scan") {
      const nmt = this.node.nmt === 5 ? "operational" : this.node.nmt === 4 ? "stopped" : "pre-operational";
      this.info(`Node ${this.node.id}  ${nmt}  ${this.node.get(0x1008, 0).value}`, "info");
      return { ok: true };
    }
    if (cmd === "nmt") {
      need(1);
      const node = arg[1] != null && arg[1] !== "all" ? parseInt(arg[1], 10) : 0;
      this.nmt(arg[0], node);
      this.info(`NMT ${arg[0]} node ${node || "all"}`, "info");
      return { ok: true };
    }
    if (cmd === "read") {
      need(1);
      const index = parseUserNumber(arg[0]);
      const sub = arg[1] != null ? parseUserNumber(arg[1]) : 0;
      const node = arg[2] != null ? parseUserNumber(arg[2]) : this.selectedNode;
      const result = await this.readObject(node, index, sub);
      this.info(`Node ${node} 0x${dcf.padHex(index, 4)}:${sub} = ${this.describeValue(result.obj, result.value)}`, "info");
      return { ok: true, value: result.value };
    }
    if (cmd === "write") {
      need(3);
      const index = parseUserNumber(arg[0]);
      const sub = parseUserNumber(arg[1]);
      const node = arg[3] != null ? parseUserNumber(arg[3]) : this.selectedNode;
      const obj = await this.writeObject(node, index, sub, arg[2]);
      this.info(`Wrote 0x${dcf.padHex(index, 4)}:${sub} = ${this.describeValue(obj, obj.value)}`, "info");
      return { ok: true };
    }
    if (cmd === "dcf") {
      const sub = (arg[0] || "").toLowerCase();
      if (sub === "open") {
        need(2);
        const file = arg.slice(1).join(" ");
        this.openDcfText(fs.readFileSync(file, "utf8"), path.basename(file), file);
        return { ok: true };
      }
      if (sub === "save") {
        if (!this.dcfDoc) throw new Error("No DCF is open");
        const file = arg[1] ? arg.slice(1).join(" ") : this.dcfPath;
        if (!file) throw new Error("dcf save needs a path");
        this.dcfPath = file;
        const text = dcf.serializeDcf(this.dcfDoc);
        fs.writeFileSync(file, text);
        this.dcfDirty = false;
        this.dcfName = path.basename(file);
        this.info("Saved " + file, "help");
        return { ok: true, text };
      }
      if (sub === "diff") {
        need(3);
        const rows = dcf.diffDcf(fs.readFileSync(arg[1], "utf8"), fs.readFileSync(arg[2], "utf8"), arg.includes("--ro") || arg.includes("--ignore-ro"));
        this.info(rows.length ? rows.length + " differences" : "DCF files match", rows.length ? "info" : "help");
        for (const row of rows.slice(0, 80)) {
          this.info(`0x${dcf.padHex(row.index, 4)}:${row.sub} ${row.name}  ${row.a || "(missing)"}  ->  ${row.b || "(missing)"}`, "info");
        }
        return { ok: true, rows };
      }
      if (sub === "send") return this.sendDcf(arg[1] ? parseInt(arg[1], 10) : this.selectedNode);
      if (sub === "pull") return this.pullDcf();
      if (sub === "close") {
        this.closeDcf(false);
        this.info("Closed the DCF editor", "info");
        return { ok: true };
      }
      throw new Error("dcf commands: open, save, diff, send, pull, close");
    }
    if (cmd === "trace") {
      const sub = (arg[0] || "arm").toLowerCase();
      if (sub === "arm" || sub === "start") {
        this.trace.armed = true;
        this.trace.points = [];
        this.trace.epoch += 1;
        this.trace.seq = 0;
        this.info("Detail trace armed", "help");
      } else if (sub === "stop") {
        this.trace.armed = false;
        this.info("Detail trace stopped, " + this.trace.points.length + " samples", "info");
      } else throw new Error("trace arm | stop");
      return { ok: true };
    }
    if (cmd === "tx") {
      need(2);
      const id = parseUserNumber(arg[0]);
      const bytes = arg.slice(1).join("").replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
      if (!bytes.length || bytes.length % 2) throw new Error("Data must be hex bytes");
      const data = [];
      for (let i = 0; i < bytes.length; i += 2) data.push(parseInt(bytes.slice(i, i + 2), 16));
      this.transmit({ id, ext: id > 0x7ff, data, dlc: data.length });
      return { ok: true };
    }
    if (cmd === "sync") {
      this.transmit({ id: 0x80, ext: false, data: [], dlc: 0 });
      return { ok: true };
    }
    if (cmd === "demand") {
      need(1);
      await this.demand(arg[0], arg[1]);
      return { ok: true };
    }
    if (cmd === "fault") {
      if (this.adapter === "ixxat") {
        if (!arg[0] || arg[0] === "clear") {
          await this.demand("faultreset");
          return { ok: true };
        }
        throw new Error("A simulated fault is only for the practice controller. Disconnect IXXAT to use it.");
      }
      if (!arg[0] || arg[0] === "clear") {
        this.node.applyControlword(0x80);
        this.node.lastCw = 0;
        this.info("Fault reset sent", "info");
      } else {
        const code = parseUserNumber(arg[0]);
        this.node.raiseFault(code);
        this.info("Simulated fault 0x" + dcf.padHex(code, 4) + " " + (EMCY_TEXT[code] || ""), "error");
      }
      return { ok: true };
    }
    if (cmd === "record") {
      if (arg[0] === "stop") {
        this.recording = false;
        this.info("Recording stopped, " + this.record.length + " frames", "info");
      } else {
        this.recording = true;
        this.record = [];
        this.info("Recording CAN frames", "help");
      }
      return { ok: true };
    }
    if (cmd === "level") {
      if (arg[0] === "operator" || arg[0] === "engineer") {
        this.accessLevel = arg[0];
        this.saveSettings();
      }
      this.info("Access level: " + this.accessLevel, "info");
      return { ok: true };
    }
    if (cmd === "objects") {
      const q = (arg[0] || "").toLowerCase();
      const rows = this.node.list().filter((obj) => !q || obj.name.toLowerCase().includes(q) || dcf.padHex(obj.index, 4).toLowerCase().includes(q.replace(/^0x/, "")));
      for (const obj of rows.slice(0, 60)) {
        this.info(`0x${dcf.padHex(obj.index, 4)}:${obj.sub}  ${obj.name} = ${this.describeValue(obj, obj.value)}`, "info");
      }
      if (rows.length > 60) this.info(`... ${rows.length - 60} more. Narrow the search.`, "info");
      return { ok: true };
    }
    if (cmd === "connect") {
      if ((arg[0] || "").toLowerCase() === "ixxat") {
        this.connectIxxat();
        return { ok: true };
      }
      this.connectVirtual();
      return { ok: true };
    }
    if (cmd === "disconnect") {
      this.closeHardware();
      this.busOn = false;
      this.info("CAN stopped", "error");
      return { ok: true };
    }
    throw new Error("Unknown command '" + cmd + "'. Type help.");
  }

  async demand(op, raw) {
    const node = this.selectedNode;
    if (op === "enable") {
      await this.writeObject(node, 0x6040, 0, 0x0006);
      await this.writeObject(node, 0x6040, 0, 0x0007);
      await this.writeObject(node, 0x6040, 0, 0x000f);
      if (this.node.nmt !== 5) this.nmt("start", node);
      this.info("Drive enable sequence sent", "help");
      return;
    }
    if (op === "disable") {
      await this.writeObject(node, 0x6040, 0, 0x0000);
      this.info("Disable voltage sent", "info");
      return;
    }
    if (op === "shutdown") return this.writeObject(node, 0x6040, 0, 0x0006);
    if (op === "switchon") return this.writeObject(node, 0x6040, 0, 0x0007);
    if (op === "quickstop") return this.writeObject(node, 0x6040, 0, 0x0002);
    if (op === "faultreset") return this.writeObject(node, 0x6040, 0, 0x0080);
    if (op === "mode") {
      const modes = { pp: 1, pv: 3, tq: 4, velocity: 3, torque: 4, position: 1 };
      const mode = modes[String(raw).toLowerCase()] || parseUserNumber(raw);
      await this.writeObject(node, 0x6060, 0, mode);
      this.info("Mode set to " + mode, "info");
      return;
    }
    if (op === "vel" || op === "velocity") {
      await this.writeObject(node, 0x60ff, 0, parseUserNumber(raw));
      this.info("Target velocity " + raw + " rpm", "info");
      return;
    }
    if (op === "torque" || op === "tq") {
      await this.writeObject(node, 0x6071, 0, Math.round(Number(raw) * 10));
      this.info("Target torque " + raw + " %", "info");
      return;
    }
    throw new Error("demand enable|disable|shutdown|switchon|quickstop|faultreset|mode|vel|torque");
  }

  publicObject(obj) {
    return {
      index: obj.index,
      sub: obj.sub,
      name: obj.name,
      type: obj.type,
      typeName: dcf.DT_NAME[obj.type] || "UNSIGNED32",
      access: obj.access,
      value: obj.value,
      unit: obj.unit || "",
      group: obj.group || dcf.groupForIndex(obj.index),
      enum: obj.enum || null,
      live: !!obj.live,
      writable: dcf.isWritableAccess(obj.access),
    };
  }

  currentObjects() {
    if (this.helperMode === "dcf" && this.dcfDoc) {
      return this.dcfDoc.objects.map((obj) => this.publicObject(obj));
    }
    if (this.helperMode === "online") return this.node.list().map((obj) => this.publicObject(obj));
    return [];
  }

  liveSnapshot(sw) {
    if (this.adapter === "ixxat") {
      const code = this.remoteFault || 0;
      return {
        velocityRpm: 0,
        torquePct: 0,
        currentA: 0,
        vdcV: 0,
        tempM: 0,
        tempC: 0,
        statusword: 0,
        faultCode: code,
        faultText: EMCY_TEXT[code] || (code ? "0x" + dcf.padHex(code, 4) : ""),
        faultCheck: EMCY_CHECK[code] || "",
        errorRegister: 0,
        mode: 0,
        name: this.remoteName || this.adapterName || "IXXAT",
        swText: "",
        serial: "",
      };
    }
    return {
      velocityRpm: Math.round(this.node.velocity),
      torquePct: Math.round(this.node.torque) / 10,
      currentA: Math.round(this.node.current) / 10,
      vdcV: Math.round(this.node.vdc) / 10,
      tempM: this.node.tempM,
      tempC: this.node.tempC,
      statusword: sw,
      faultCode: this.node.faultCode,
      faultText: EMCY_TEXT[this.node.faultCode] || (this.node.faultCode ? "0x" + dcf.padHex(this.node.faultCode, 4) : ""),
      faultCheck: EMCY_CHECK[this.node.faultCode] || "",
      errorRegister: this.node.errorRegister,
      mode: Number(this.node.get(0x6060, 0).value) || 0,
      name: String(this.node.get(0x1008, 0).value),
      swText: this.node.get(0x100a, 0).value,
      serial: this.node.get(0x1018, 4).value,
    };
  }

  nmtName() {
    if (!this.busOn) return "CAN stopped";
    if (this.adapter === "ixxat") {
      if (this.remoteNmt === 5) return "Operational";
      if (this.remoteNmt === 4) return "Stopped";
      if (this.remoteNmt === 127) return "Pre-operational";
      if (this.remoteNmt === 0) return "Boot-up";
      return "IXXAT connected";
    }
    if (this.node.nmt === 5) return "Operational";
    if (this.node.nmt === 4) return "Stopped";
    return "Pre-operational";
  }

  helperStatus() {
    if (this.helperMode === "dcf") return this.dcfDirty ? "DCF unsaved changes" : "DCF editor";
    if (this.helperMode === "online") return this.nmtName();
    return "Helper is offline";
  }

  snapshot(query) {
    const frameCursor = Number(query.frame) || 0;
    const infoCursor = Number(query.info) || 0;
    const traceCursor = Number(query.trace) || 0;
    const traceReset = Number(query.traceEpoch) !== this.trace.epoch;
    const logReset = Number(query.logEpoch) !== this.logEpoch;
    const infoReset = Number(query.infoEpoch) !== this.infoEpoch;
    const frames = (logReset ? this.frames : this.frames.filter((frame) => frame.n > frameCursor)).slice(-400);
    const info = (infoReset ? this.infoLines : this.infoLines.filter((line) => line.n > infoCursor)).slice(-200);
    const points = (traceReset ? this.trace.points : this.trace.points.filter((point) => point.n > traceCursor)).slice(-400);
    const sw = this.node.statusword();
    return {
      version: VERSION,
      update: this.updateOffer,
      logEpoch: this.logEpoch,
      infoEpoch: this.infoEpoch,
      frameCursor: frames.length ? frames[frames.length - 1].n : (logReset ? 0 : frameCursor),
      infoCursor: info.length ? info[info.length - 1].n : (infoReset ? 0 : infoCursor),
      frames,
      info,
      baud: this.baud,
      bauds: BAUDS,
      filters: this.filters,
      cli: this.cli,
      busOn: this.busOn,
      adapter: this.adapter,
      adapterName: this.adapterName,
      selectedNode: this.selectedNode,
      nmtName: this.nmtName(),
      driveState: this.adapter === "ixxat" ? (this.remoteFault ? "fault" : "hardware") : this.node.driveState,
      helperMode: this.helperMode,
      helperStatus: this.helperStatus(),
      dcfName: this.dcfName,
      dcfDirty: this.dcfDirty,
      dcfPath: this.dcfPath,
      dictEpoch: this.dictEpoch,
      objects: this.currentObjects(),
      live: this.liveSnapshot(sw),
      prompt: `z-dvt(${this.selectedNode}) % `,
      accessLevel: this.accessLevel,
      panels: this.panels,
      trace: { armed: this.trace.armed, epoch: this.trace.epoch, cursor: points.length ? points[points.length - 1].n : (traceReset ? 0 : traceCursor), points },
      recording: this.recording,
      recordCount: this.record.length,
      sdoTimeout: this.sdoTimeout,
      j1939Tool: this.j1939Tool,
      j1939Node: Number(this.node.get(0x2003, 1).value) || 0,
      progress: this.progress,
      faults: Object.entries(EMCY_TEXT).map(([code, text]) => ({ code: Number(code), text, check: EMCY_CHECK[code] || "" })),
    };
  }

  pluginList() {
    try {
      return fs.readdirSync(this.pluginsDir).filter((name) => name.toLowerCase().endsWith(".txt")).sort();
    } catch {
      return [];
    }
  }

  async runPlugin(name) {
    const safe = path.basename(name);
    if (!/^[\w. -]+\.txt$/i.test(safe)) throw new Error("Plugin name is not allowed");
    const file = path.join(this.pluginsDir, safe);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    this.info("Plugin " + safe, "help");
    for (const line of lines) {
      const trim = line.trim();
      if (!trim || trim.startsWith("#")) continue;
      try {
        await this.execute(trim);
      } catch (err) {
        this.info(err.message, "error");
      }
    }
    return { ok: true };
  }

  async installUpdate() {
    if (!this.updateOffer) this.updateOffer = await updater.check(VERSION);
    if (!this.updateOffer) throw new Error("Z-DVT Workbench is up to date.");
    this.progress = "Downloading " + this.updateOffer.version;
    const file = await updater.download(this.updateOffer);
    this.progress = "";
    this.info("Starting the installer for " + this.updateOffer.version + ". This window will close.", "help");
    updater.launchInstaller(file);
    this.stop();
    return { ok: true, shutdown: true };
  }

  installPlugin(name, text) {
    const safe = path.basename(name);
    if (!/^[\w. -]+\.txt$/i.test(safe)) throw new Error("Plugins are .txt command lists");
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(this.pluginsDir, safe), String(text));
    this.info("Installed plugin " + safe, "help");
    return { ok: true, name: safe };
  }

  csvFor(rows) {
    const header = "time,dir,id,ext,type,data,text";
    const body = rows.map((row) => [
      row.t.toFixed(3),
      row.dir,
      "0x" + hexId(row.id, row.ext),
      row.ext ? 1 : 0,
      row.type,
      row.data.map((b) => dcf.padHex(b, 2)).join(" "),
      `"${String(row.text).replace(/"/g, "''")}"`,
    ].join(","));
    return [header].concat(body).join("\r\n");
  }

  async handle(msg) {
    const type = msg && msg.type;
    if (type === "command") {
      try {
        const result = await this.execute(msg.text || "");
        return Object.assign({ ok: true }, result);
      } catch (err) {
        this.info(err.message, "error");
        return { ok: false, error: err.message };
      }
    }
    if (type === "source") {
      const lines = String(msg.text || "").split(/\r?\n/);
      for (const line of lines) {
        const trim = line.trim();
        if (!trim || trim.startsWith("#")) continue;
        try { await this.execute(trim); } catch (err) { this.info(err.message, "error"); }
      }
      return { ok: true };
    }
    if (type === "ping") return this.ping(msg.node || this.selectedNode);
    if (type === "baud") return this.execute("baud " + msg.baud);
    if (type === "filter") return this.execute("filter " + msg.name + " " + (msg.on ? "on" : "off"));
    if (type === "clear") {
      if (msg.what === "can" || msg.what === "all") await this.execute("clearcan");
      if (msg.what === "info" || msg.what === "all") await this.execute("clear");
      return { ok: true };
    }
    if (type === "nmt") return this.execute("nmt " + msg.cmd + " " + (msg.node || this.selectedNode));
    if (type === "selectNode") {
      this.selectedNode = clamp(parseInt(msg.node, 10) || 1, 1, 127);
      return { ok: true };
    }
    if (type === "openDcf") {
      this.openDcfText(msg.text || "", msg.name || "untitled.dcf", msg.path || "");
      return { ok: true };
    }
    if (type === "editDcf") {
      try {
        this.editDcf(msg.index, msg.sub, msg.value);
        return { ok: true, dcfDirty: true };
      } catch (err) {
        this.info(err.message, "error");
        return { ok: false, error: err.message };
      }
    }
    if (type === "saveDcf") {
      if (!this.dcfDoc) return { ok: false, error: "No DCF is open" };
      const text = dcf.serializeDcf(this.dcfDoc);
      this.dcfDirty = false;
      if (msg.writeThrough && this.dcfPath) {
        fs.writeFileSync(this.dcfPath, text);
        this.info("Saved " + this.dcfPath, "help");
      }
      return { ok: true, text, filename: this.dcfName || "controller.dcf" };
    }
    if (type === "closeDcf") return Object.assign({ ok: true }, this.closeDcf(false));
    if (type === "compareText") {
      const rows = dcf.diffDcf(msg.a || "", msg.b || "", !!msg.ignoreRo);
      return { ok: true, rows };
    }
    if (type === "sendDcf") return Object.assign({ ok: true }, await this.sendDcf(msg.node));
    if (type === "pullDcf") return Object.assign({ ok: true }, this.pullDcf());
    if (type === "write") {
      try {
        await this.writeObject(this.selectedNode, msg.index, msg.sub, msg.value);
        return { ok: true };
      } catch (err) {
        this.info(err.message, "error");
        return { ok: false, error: err.message };
      }
    }
    if (type === "cia402") {
      try {
        await this.demand(msg.op, msg.value);
        return { ok: true };
      } catch (err) {
        this.info(err.message, "error");
        return { ok: false, error: err.message };
      }
    }
    if (type === "j1939Hold") {
      if (!msg.enable) this.j1939Hold = null;
      else {
        this.j1939Hold = {
          dest: Number(msg.dest) || Number(this.node.get(0x2003, 1).value) || 0x21,
          speedOn: !!msg.speedOn,
          torqueOn: !!msg.torqueOn,
          speedRpm: Number(msg.speedRpm) || 0,
          torquePct: Number(msg.torquePct) || 0,
          acc: 50,
        };
      }
      return { ok: true };
    }
    if (type === "tx") {
      const data = (msg.data || []).map((b) => Number(b) & 0xff);
      this.transmit({ id: Number(msg.id) >>> 0, ext: !!msg.ext || Number(msg.id) > 0x7ff, data, dlc: data.length });
      return { ok: true };
    }
    if (type === "txHold") {
      if (!msg.enable) this.txHold = null;
      else this.txHold = { id: Number(msg.id) >>> 0, ext: !!msg.ext, data: (msg.data || []).map((b) => Number(b) & 0xff), every: Math.max(10, Number(msg.every) || 100), acc: 0 };
      return { ok: true };
    }
    if (type === "trace") return this.execute(msg.arm ? "trace arm" : "trace stop");
    if (type === "traceCsv") {
      const header = "time,velocity_rpm,torque_pct,current_a,vdc_v";
      const body = this.trace.points.map((p) => [p.t.toFixed(3), p.velocity, p.torque, p.current, p.vdc].join(","));
      return { ok: true, text: [header].concat(body).join("\r\n") };
    }
    if (type === "record") {
      if (msg.stop) {
        const text = this.csvFor(this.record);
        this.recording = false;
        return { ok: true, text, count: this.record.length };
      }
      this.recording = true;
      this.record = [];
      this.info("Recording CAN frames", "help");
      return { ok: true };
    }
    if (type === "fault") return this.execute(msg.clear ? "fault clear" : "fault " + msg.code);
    if (type === "level") return this.execute("level " + msg.level);
    if (type === "panel") {
      if (msg.name && Object.prototype.hasOwnProperty.call(this.panels, msg.name)) this.panels[msg.name] = !!msg.show;
      this.saveSettings();
      return { ok: true, panels: this.panels };
    }
    if (type === "settings") {
      if (msg.sdoTimeout) this.sdoTimeout = clamp(parseInt(msg.sdoTimeout, 10) || 1000, 100, 10000);
      if (msg.j1939Tool != null) this.j1939Tool = clamp(parseInt(msg.j1939Tool, 10) || 0xfa, 0, 253);
      this.saveSettings();
      return { ok: true };
    }
    if (type === "connect") {
      try {
        const line = msg.adapter === "ixxat" ? "connect ixxat" : (msg.on ? "connect" : "disconnect");
        return Object.assign({ ok: true }, await this.execute(line));
      } catch (err) {
        this.info(err.message, "error");
        return { ok: false, error: err.message };
      }
    }
    if (type === "runPlugin") return this.runPlugin(msg.name);
    if (type === "installPlugin") return this.installPlugin(msg.name, msg.text);
    if (type === "cli") return this.execute("cli " + (msg.on ? "on" : "off"));
    if (type === "update") {
      try {
        if (msg.install) return await this.installUpdate();
        this.updateOffer = await updater.check(VERSION);
        if (this.updateOffer) this.info("Version " + this.updateOffer.version + " is available.", "help");
        else if (process.platform === "darwin") this.info("This Mac copy follows the macos branch. In the project folder, run git pull.", "info");
        else this.info("Z-DVT Workbench " + VERSION + " is up to date.", "info");
        return { ok: true, update: this.updateOffer };
      } catch (err) {
        this.info(err.message, "error");
        return { ok: false, error: err.message };
      }
    }
    if (type === "shutdown") {
      this.stop();
      return { ok: true, shutdown: true };
    }
    return { ok: false, error: "Unknown action" };
  }
}

function helpRows() {
  return [
    { name: "help [word]", summary: "List commands. A word narrows the list." },
    { name: "ping [node]", summary: "Read identity and open the helper on that node." },
    { name: "nodes", summary: "Show the controller that is answering." },
    { name: "nmt <cmd> [node]", summary: "start, stop, preop, or reset." },
    { name: "read <index> [sub] [node]", summary: "SDO upload. Example: read 0x1008 0" },
    { name: "write <index> <sub> <value>", summary: "SDO download. Example: write 0x60FF 0 1500" },
    { name: "demand <op> [value]", summary: "enable, disable, mode pv|tq, vel <rpm>, torque <%>" },
    { name: "baud <kbit>", summary: "1000, 800, 500, 250, 125, 100, 50, or 20." },
    { name: "filter <type|all|none|defaults>", summary: "Show or hide CAN log types." },
    { name: "cli on|off", summary: "Periodic text from the controller in the CAN log." },
    { name: "dcf open|save|diff|send|pull|close", summary: "Device configuration files." },
    { name: "trace arm|stop", summary: "Fast speed, torque, current, and voltage samples." },
    { name: "tx <id> <hex>", summary: "Transmit one CAN frame." },
    { name: "sync", summary: "Transmit a CANopen SYNC." },
    { name: "fault <code>|clear", summary: "Raise or reset a demo EMCY. Example: fault 0x3210" },
    { name: "record start|stop", summary: "Keep a CAN log for CSV export." },
    { name: "objects [name]", summary: "Search the object dictionary." },
    { name: "level operator|engineer", summary: "Operator can read. Engineer can write." },
    { name: "connect [ixxat] / disconnect", summary: "Practice bus, or the IXXAT dongle through VCI. Disconnect stops CAN." },
    { name: "clear / clearcan", summary: "Clear the information window or the CAN log." },
  ];
}

module.exports = {
  Workbench,
  helpRows,
  VERSION,
  BAUDS,
  FILTER_NAMES,
  EMCY_TEXT,
};
