"use strict";

// Talks to an IXXAT USB-CAN adapter through the installed VCI library
// (vcinpl.dll). This file does not load the VCI4 Tcl license DLL.

const path = require("path");

const DLL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vcinpl.dll");

const VCI_OK = 0;
const VCI_E_TIMEOUT = 0xE001000B;
const VCI_E_NO_DATA = 0xE001000E;
const VCI_E_NO_MORE_ITEMS = 0xE001000F;
const VCI_E_ALREADY_INITIALIZED = 0xE0010011;
const VCI_E_RXQUEUE_EMPTY = 0xE0010012;
const VCI_E_ACCESSDENIED = 0xE001000A;
const EMPTY = new Set([VCI_E_TIMEOUT, VCI_E_NO_DATA, VCI_E_RXQUEUE_EMPTY]);

const OPMODE = 0x01 | 0x02 | 0x04;

const BTR = {
  1000: [0x00, 0x14],
  800: [0x00, 0x16],
  500: [0x00, 0x1c],
  250: [0x01, 0x1c],
  125: [0x03, 0x1c],
  100: [0x04, 0x1c],
  50: [0x09, 0x1c],
  20: [0x18, 0x1c],
};

const INFO_TEXT = { 1: "CAN started", 2: "CAN stopped", 3: "CAN reset" };
const ERROR_TEXT = {
  1: "stuff error",
  2: "form error",
  3: "acknowledgement error",
  4: "bit error",
  6: "CRC error",
  7: "CAN error",
};

let api = null;

function codeOf(hr) {
  return hr >>> 0;
}

function bind() {
  if (api) return api;
  if (process.platform !== "win32") {
    throw new Error("The IXXAT VCI library (vcinpl.dll) ships with the Windows VCI driver. Use Connect virtual CAN on this computer.");
  }
  let koffi;
  try {
    koffi = require("koffi");
  } catch (err) {
    throw new Error("IXXAT support needs the koffi package in the Z-DVT folder. " + err.message);
  }
  let lib;
  try {
    lib = koffi.load(DLL);
  } catch (err) {
    throw new Error("The IXXAT VCI library did not load from " + DLL + ". Install HMS IXXAT VCI. " + err.message);
  }
  const fn = (sig) => lib.func(sig);
  api = {
    vciInitialize: fn("int32 __stdcall vciInitialize()"),
    vciFormatError: fn("void __stdcall vciFormatError(int32 hr, _Out_ uint8_t *text, uint32 size)"),
    vciEnumDeviceOpen: fn("int32 __stdcall vciEnumDeviceOpen(_Out_ void **ph)"),
    vciEnumDeviceClose: fn("int32 __stdcall vciEnumDeviceClose(void *h)"),
    vciEnumDeviceNext: fn("int32 __stdcall vciEnumDeviceNext(void *h, _Out_ uint8_t *info)"),
    vciDeviceOpen: fn("int32 __stdcall vciDeviceOpen(uint8_t *vciId, _Out_ void **ph)"),
    vciDeviceClose: fn("int32 __stdcall vciDeviceClose(void *h)"),
    canChannelOpen: fn("int32 __stdcall canChannelOpen(void *hDevice, uint32 canNo, int32 exclusive, _Out_ void **ph)"),
    canChannelInitialize: fn("int32 __stdcall canChannelInitialize(void *h, uint16 rxSize, uint16 rxTh, uint16 txSize, uint16 txTh)"),
    canChannelActivate: fn("int32 __stdcall canChannelActivate(void *h, int32 enable)"),
    canChannelClose: fn("int32 __stdcall canChannelClose(void *h)"),
    canChannelReadMessage: fn("int32 __stdcall canChannelReadMessage(void *h, uint32 timeoutMs, _Out_ uint8_t *msg)"),
    canChannelPostMessage: fn("int32 __stdcall canChannelPostMessage(void *h, uint8_t *msg)"),
    canControlOpen: fn("int32 __stdcall canControlOpen(void *hDevice, uint32 canNo, _Out_ void **ph)"),
    canControlInitialize: fn("int32 __stdcall canControlInitialize(void *h, uint8 mode, uint8 btr0, uint8 btr1)"),
    canControlStart: fn("int32 __stdcall canControlStart(void *h, int32 start)"),
    canControlClose: fn("int32 __stdcall canControlClose(void *h)"),
    canControlSetAccFilter: fn("int32 __stdcall canControlSetAccFilter(void *h, int32 extend, uint32 code, uint32 mask)"),
  };
  const hr = codeOf(api.vciInitialize());
  if (hr !== VCI_OK && hr !== VCI_E_ALREADY_INITIALIZED) check(hr, "vciInitialize");
  return api;
}

function vciError(hr) {
  const code = codeOf(hr);
  if (code === VCI_OK) return "";
  try {
    const buf = Buffer.alloc(256);
    bind().vciFormatError(hr | 0, buf, buf.length);
    const text = buf.toString("utf8").replace(/\0[\s\S]*$/, "").trim();
    if (text) return text;
  } catch {
    /* fall through to the code */
  }
  return "VCI error 0x" + code.toString(16);
}

function check(hr, what) {
  const code = codeOf(hr);
  if (code === VCI_OK) return;
  const err = new Error(what + " failed. " + vciError(hr));
  err.vci = code;
  throw err;
}

function cstr(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const zero = slice.indexOf(0);
  return slice.subarray(0, zero === -1 ? slice.length : zero).toString("latin1").trim();
}

function printable(text) {
  if (!text || text.length < 2) return "";
  let ok = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 32 && c < 127) ok += 1;
  }
  return ok >= text.length - 1 ? text : "";
}

function scanStrings(buf) {
  const found = [];
  let run = "";
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 32 && c < 127) run += String.fromCharCode(c);
    else {
      if (run.length >= 4) found.push(run.trim());
      run = "";
    }
  }
  if (run.length >= 4) found.push(run.trim());
  return found;
}

function parseDevice(info) {
  const vciId = Buffer.from(info.subarray(0, 8));
  let description = printable(cstr(info, 48, 128));
  let manufacturer = printable(cstr(info, 176, 126));
  if (!description || !manufacturer) {
    const found = scanStrings(info.subarray(16));
    if (!description && found[0]) description = found[0];
    if (!manufacturer && found[1]) manufacturer = found[1];
  }
  return { vciId, description: description || "", manufacturer: manufacturer || "" };
}

function listDevices() {
  const lib = bind();
  const href = [null];
  check(lib.vciEnumDeviceOpen(href), "vciEnumDeviceOpen");
  const handle = href[0];
  const devices = [];
  try {
    const info = Buffer.alloc(512);
    for (;;) {
      const hr = codeOf(lib.vciEnumDeviceNext(handle, info));
      if (hr === VCI_E_NO_MORE_ITEMS) break;
      check(hr, "vciEnumDeviceNext");
      devices.push(parseDevice(info));
      info.fill(0);
    }
  } finally {
    try { lib.vciEnumDeviceClose(handle); } catch { /* enumerator is finished */ }
  }
  return devices;
}

function packFrame(frame) {
  const data = frame.data || [];
  const dlc = Math.min(8, frame.dlc != null ? frame.dlc : data.length);
  const id = frame.id >>> 0;
  const ext = !!(frame.ext || id > 0x7ff);
  const buf = Buffer.alloc(20);
  buf.writeUInt32LE(id, 4);
  buf[8] = 0;
  buf[10] = (dlc & 0x0f) | (frame.rtr ? 0x40 : 0) | (ext ? 0x80 : 0);
  for (let i = 0; i < dlc && i < data.length; i++) buf[12 + i] = data[i] & 0xff;
  return buf;
}

function unpackFrame(buf) {
  const type = buf[8];
  const flags = buf[10];
  const dlc = Math.min(8, flags & 0x0f);
  const id = buf.readUInt32LE(4) >>> 0;
  if (type === 0) {
    return {
      kind: "data",
      id,
      ext: (flags & 0x80) !== 0,
      rtr: (flags & 0x40) !== 0,
      dlc,
      data: Array.from(buf.subarray(12, 12 + dlc)),
    };
  }
  if (type === 1) return { kind: "info", note: INFO_TEXT[buf[12]] || ("CAN info " + buf[12]) };
  if (type === 2) return { kind: "error", note: "IXXAT " + (ERROR_TEXT[buf[12]] || ("error " + buf[12])) };
  return { kind: "other" };
}

class IxxatPort {
  constructor(lib, device) {
    this.api = lib;
    this.device = device;
    this.borrowed = false;
    this.hDevice = null;
    this.hChannel = null;
    this.hControl = null;
  }

  label() {
    const text = [this.device.manufacturer, this.device.description].filter(Boolean).join(" ");
    const base = text || "IXXAT USB-CAN";
    return this.borrowed ? base + " (already in use)" : base;
  }

  open(channel, btr) {
    const lib = this.api;
    const opened = [null];
    check(lib.vciDeviceOpen(this.device.vciId, opened), "vciDeviceOpen");
    this.hDevice = opened[0];
    const channelOut = [null];
    check(lib.canChannelOpen(this.hDevice, channel, 0, channelOut), "canChannelOpen");
    this.hChannel = channelOut[0];
    check(lib.canChannelInitialize(this.hChannel, 1024, 1, 128, 1), "canChannelInitialize");
    check(lib.canChannelActivate(this.hChannel, 1), "canChannelActivate");
    const controlOut = [null];
    check(lib.canControlOpen(this.hDevice, channel, controlOut), "canControlOpen");
    this.hControl = controlOut[0];
    const init = codeOf(lib.canControlInitialize(this.hControl, OPMODE, btr[0], btr[1]));
    if (init === VCI_E_ACCESSDENIED) this.borrowed = true;
    else {
      check(init, "canControlInitialize");
      check(lib.canControlSetAccFilter(this.hControl, 0, 0, 0), "canControlSetAccFilter");
      check(lib.canControlSetAccFilter(this.hControl, 1, 0, 0), "canControlSetAccFilter");
    }
    const start = codeOf(lib.canControlStart(this.hControl, 1));
    if (start !== VCI_E_ACCESSDENIED) check(start, "canControlStart");
    this.poll(32);
  }

  applyBitrate(kbit) {
    const btr = BTR[kbit];
    if (!btr) throw new Error("Bitrate " + kbit + " kbit/s is not supported on the IXXAT adapter.");
    if (this.borrowed) throw new Error("The IXXAT adapter is in use by another program, so the bitrate was left unchanged.");
    const lib = this.api;
    check(lib.canControlStart(this.hControl, 0), "canControlStart");
    check(lib.canControlInitialize(this.hControl, OPMODE, btr[0], btr[1]), "canControlInitialize");
    check(lib.canControlSetAccFilter(this.hControl, 0, 0, 0), "canControlSetAccFilter");
    check(lib.canControlSetAccFilter(this.hControl, 1, 0, 0), "canControlSetAccFilter");
    check(lib.canControlStart(this.hControl, 1), "canControlStart");
  }

  write(frame) {
    check(this.api.canChannelPostMessage(this.hChannel, packFrame(frame)), "canChannelPostMessage");
  }

  poll(max) {
    const frames = [];
    const notes = [];
    const buf = Buffer.alloc(32);
    const limit = max || 64;
    for (let i = 0; i < limit; i++) {
      const hr = codeOf(this.api.canChannelReadMessage(this.hChannel, 0, buf));
      if (EMPTY.has(hr)) break;
      check(hr, "canChannelReadMessage");
      const frame = unpackFrame(buf);
      if (frame.kind === "data") frames.push(frame);
      else if (frame.kind === "error" && frame.note) notes.push(frame.note);
    }
    return { frames, notes };
  }

  close() {
    const lib = this.api;
    const swallow = (fn) => { try { fn(); } catch { /* closing */ } };
    if (this.hControl) swallow(() => lib.canControlStart(this.hControl, 0));
    if (this.hChannel) swallow(() => lib.canChannelActivate(this.hChannel, 0));
    if (this.hChannel) swallow(() => lib.canChannelClose(this.hChannel));
    if (this.hControl) swallow(() => lib.canControlClose(this.hControl));
    if (this.hDevice) swallow(() => lib.vciDeviceClose(this.hDevice));
    this.hChannel = null;
    this.hControl = null;
    this.hDevice = null;
  }
}

function open(options) {
  const bitrateK = Number(options && options.bitrateK);
  const channel = Number(options && options.channel) || 0;
  const btr = BTR[bitrateK];
  if (!btr) throw new Error("Bitrate " + bitrateK + " kbit/s is not supported on the IXXAT adapter.");
  const devices = listDevices();
  if (!devices.length) throw new Error("No IXXAT adapter is plugged in.");
  const port = new IxxatPort(bind(), devices[0]);
  try {
    port.open(channel, btr);
  } catch (err) {
    port.close();
    throw err;
  }
  return port;
}

module.exports = {
  listDevices,
  open,
  packFrame,
  unpackFrame,
  BTR,
};
