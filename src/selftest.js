"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Workbench } = require("./engine");
const dcf = require("./dcf");
const ixxat = require("./ixxat");
const updater = require("./update");

let failed = 0;

function assert(cond, message) {
  if (!cond) {
    failed += 1;
    console.error("FAIL " + message);
  }
}

async function main() {
  const sample = [
    "; keep this comment",
    "[FileInfo]",
    "FileName=demo",
    "CustomKey=leave-me",
    "",
    "[1008]",
    "ParameterName=Manufacturer device name",
    "DataType=0x0009",
    "AccessType=ro",
    "ParameterValue=Z-DVT Practice Controller",
    "",
    "[2000sub1]",
    "ParameterName=Pole pairs",
    "DataType=0x0005",
    "AccessType=rw",
    "DefaultValue=4",
    "ParameterValue=4",
    "PDOMapping=0",
    "",
  ].join("\r\n");

  const doc = dcf.parseDcf(sample);
  const pole = doc.objects.find((o) => o.index === 0x2000 && o.sub === 1);
  assert(pole && pole.value === 4, "parsed pole pairs");
  pole.value = 8;
  pole.dirty = true;
  const saved = dcf.serializeDcf(doc);
  assert(saved.includes("; keep this comment"), "comment preserved");
  assert(saved.includes("CustomKey=leave-me"), "unknown key preserved");
  assert(saved.includes("ParameterValue=0x08"), "edited value written");

  const other = sample.replace("ParameterValue=4", "ParameterValue=6");
  const rows = dcf.diffDcf(sample, other, false);
  assert(rows.length === 1 && rows[0].sub === 1, "diff finds one change");
  const ro = dcf.diffDcf(sample, sample.replace("Z-DVT Practice Controller", "Other"), true);
  assert(ro.length === 0, "ignore read-only hides the name change");

  const engine = new Workbench();
  engine.persist = false;
  engine.sdoTimeout = 400;
  const name = await engine.execute("read 0x1008 0");
  assert(name.value === "Z-DVT Practice Controller", "segmented read of device name, got " + name.value);
  const vendor = await engine.execute("read 0x1018 1");
  assert(vendor.value === 0x57504231, "vendor id");
  const poles = await engine.execute("read 0x2000 1");
  assert(poles.value === 4, "pole pairs");

  await engine.execute("write 0x2000 1 6");
  assert(engine.node.get(0x2000, 1).value === 6, "pole pairs written");

  let rejected = false;
  try { await engine.execute("write 0x1000 0 1"); } catch (err) { rejected = /read-only/i.test(err.message); }
  assert(rejected, "read-only write rejected");
  assert(engine.node.get(0x1000, 0).value === 0x00020192, "device type unchanged");

  await engine.execute('write 0x2000 5 "Demo PMAC motor"');
  assert(engine.node.get(0x2000, 5).value === "Demo PMAC motor", "long string write");

  engine.accessLevel = "operator";
  rejected = false;
  try { await engine.execute("write 0x2000 1 9"); } catch (err) { rejected = /Operator/i.test(err.message); }
  assert(rejected, "operator cannot write");
  assert(engine.node.get(0x2000, 1).value === 6, "operator write did not stick");
  engine.accessLevel = "engineer";

  await engine.execute("nmt start");
  await engine.execute("demand enable");
  assert(engine.node.driveState === "operation enabled", "drive enabled, state=" + engine.node.driveState);
  assert(engine.node.nmt === 5, "nmt operational");
  await engine.execute("demand vel 1000");
  for (let i = 0; i < 10; i++) engine.tick(0.1);
  assert(engine.node.velocity > 900, "velocity ramped, got " + engine.node.velocity);

  await engine.execute("fault 0x3210");
  assert(engine.node.driveState === "fault", "fault latched");
  assert(engine.frames.some((frame) => frame.type === "emcy"), "emcy logged");
  await engine.execute("fault clear");
  assert(engine.node.driveState !== "fault", "fault cleared");
  await engine.execute("fault 0x3210");
  let heldOff = "";
  try { await engine.commissionVelocity(); } catch (err) { heldOff = err.message; }
  assert(/Fault/.test(heldOff) && /leaves the shaft stopped/.test(heldOff), "commission stops in fault, got " + heldOff);
  await engine.demand("faultreset");
  assert(engine.node.driveState === "ready", "fault reset then shutdown, got " + engine.node.driveState);
  const commissioned = await engine.commissionVelocity();
  assert(commissioned.state === "Operation enabled", "profile velocity commission, got " + commissioned.state);
  assert((engine.node.statusword() & 0x6f) === 0x27, "statusword is operation enabled");

  engine.transmit({
    id: 0x0c0021fa,
    ext: true,
    data: [0x02, 0xff, 0xff, 145, 0xff, 0xff, 0xff, 0xff],
    dlc: 8,
  });
  assert(engine.node.get(0x6071, 0).value === 200, "TSC1 torque applied, got " + engine.node.get(0x6071, 0).value);
  assert(engine.node.get(0x6060, 0).value === 4, "torque mode selected");

  engine.openDcfText(sample, "demo.dcf", "");
  engine.editDcf(0x2000, 1, 7);
  const out = dcf.serializeDcf(engine.dcfDoc);
  assert(out.includes("ParameterValue=0x07"), "helper edit saved into dcf");
  assert(out.includes("CustomKey=leave-me"), "helper edit kept vendor keys");

  const tmp = path.join(os.tmpdir(), "dvt-wb-a.dcf");
  const tmp2 = path.join(os.tmpdir(), "dvt-wb-b.dcf");
  fs.writeFileSync(tmp, sample);
  fs.writeFileSync(tmp2, other);
  const diff = await engine.execute(`dcf diff "${tmp}" "${tmp2}"`);
  assert(diff.rows.length === 1, "command diff");

  await engine.execute("ping 1");
  assert(engine.helperMode === "online", "ping opens helper");
  const snap = engine.snapshot({ frame: 0, info: 0, trace: 0, logEpoch: 0, infoEpoch: 0 });
  assert(snap.objects.length > 20, "online dictionary published");
  assert(snap.live.velocityRpm > 900, "live speed published");

  await engine.execute("filter defaults");
  assert(engine.filters.nmt === true && engine.filters.sdo === false, "default filters");

  assert(updater.newerThan("2026.9.1", "2026.9.0"), "newer patch");
  assert(updater.newerThan("2026.10.0", "2026.9.0"), "newer minor");
  assert(!updater.newerThan("2026.9.0", "2026.9.0"), "same version is not newer");
  assert(!updater.newerThan("v2026.8.0", "2026.9.0"), "older tag is not newer");

  const round = ixxat.unpackFrame(ixxat.packFrame({ id: 0x18FF00FA, ext: true, data: [1, 2, 3, 4, 5, 6, 7, 8], dlc: 8 }));
  assert(round.kind === "data" && round.ext && round.id === 0x18FF00FA && round.dlc === 8 && round.data[7] === 8, "ixxat extended frame");
  const standard = ixxat.unpackFrame(ixxat.packFrame({ id: 0x123, ext: false, data: [0x40], dlc: 1 }));
  assert(standard.kind === "data" && !standard.ext && standard.id === 0x123 && standard.dlc === 1 && standard.data[0] === 0x40, "ixxat standard frame");

  try {
    const devices = ixxat.listDevices();
    assert(Array.isArray(devices), "ixxat device list");
    if (!devices.length) {
      let message = "";
      try { ixxat.open({ bitrateK: 250, channel: 0 }); } catch (err) { message = err.message; }
      assert(/plugged in/i.test(message), "missing dongle is reported, got " + message);
    }
  } catch (err) {
    assert(/VCI|vcinpl|koffi/i.test(err.message), "ixxat load error is explicit, got " + err.message);
  }

  const sent = [];
  engine.adapter = "ixxat";
  engine.hw = {
    write(frame) { sent.push(frame); },
    poll() { return { frames: [{ id: 0x701, ext: false, data: [5], dlc: 1 }], notes: ["IXXAT bit error"] }; },
    close() {},
  };
  const nmtBefore = engine.node.nmt;
  engine.transmit({ id: 0, ext: false, data: [2, 1], dlc: 2 });
  assert(engine.node.nmt === nmtBefore, "practice controller ignores IXXAT traffic");
  assert(sent.length === 1 && sent[0].id === 0, "IXXAT transmit queued");
  engine.tick(0.1);
  assert(engine.remoteNmt === 5, "heartbeat from the dongle sets NMT");
  assert(engine.frames.some((frame) => frame.id === 0x701 && frame.dir === "rx"), "dongle frame logged");

  engine.sdoTimeout = 40;
  engine.helperMode = "offline";
  engine.selectedNode = 1;
  engine.busSeen = new Map();
  engine.busHintKey = "";
  const queued = [];
  engine.hw = {
    write(frame) {
      const data = frame.data || [];
      if (data[0] !== 0x40) return;
      const index = data[1] | (data[2] << 8);
      const sub = data[3];
      const node = frame.id - 0x600;
      let payload = [0, 0, 0, 0];
      if (index === 0x1008) payload = [0x54, 0x65, 0x73, 0x74];
      if (index === 0x1000) payload = [0x92, 0x01, 0x02, 0x00];
      queued.push({ id: 0x580 + node, ext: false, dlc: 8, data: [0x43, index & 0xff, (index >> 8) & 0xff, sub, payload[0], payload[1], payload[2], payload[3]] });
    },
    poll() {
      return { frames: queued.splice(0, queued.length), notes: [] };
    },
    close() {},
  };
  engine.noteRemote({ id: 0x708, ext: false, data: [127], dlc: 1 });
  const pending = engine.ping(1);
  let settled = null;
  pending.then((value) => { settled = { ok: true, value }; }, (err) => { settled = { ok: false, err }; });
  for (let i = 0; i < 30 && !settled; i++) {
    engine.tick(0.1);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(settled && settled.ok, "ping follows heartbeat, " + (settled && settled.err && settled.err.message));
  assert(engine.selectedNode === 8, "selected node follows heartbeat, got " + engine.selectedNode);
  assert(settled && settled.value && String(settled.value.name).startsWith("Test"), "inverter name from node 8");

  engine.helperMode = "offline";
  engine.selectedNode = 1;
  engine.busSeen = new Map();
  engine.hw = { write() {}, poll() { return { frames: [], notes: [] }; }, close() {} };
  engine.noteRemote({ id: 0x708, ext: false, data: [127], dlc: 1 });
  engine.noteRemote({ id: 0x709, ext: false, data: [5], dlc: 1 });
  const missed = await engine.ping(1);
  assert(missed.ok === false && /Heartbeat is coming from node 8/.test(missed.error), "timeout names the heartbeat nodes, got " + (missed && missed.error));

  engine.adapter = "virtual";
  engine.hw = null;

  await engine.execute("demand enable");
  await engine.execute("demand vel 800");
  const stopped = await engine.estop();
  assert(stopped.ok === true, "estop accepted");
  assert(Number(engine.node.get(0x60ff, 0).value) === 0, "estop clears target speed");
  assert(engine.node.driveState === "quick stop", "estop sends quick stop, got " + engine.node.driveState);
  assert(engine.commandRpm === 0, "estop command is 0");
  engine.accessLevel = "operator";
  const up = await engine.nudgeSpeed(1);
  assert(up.rpm === 100, "arrow up adds 100 rpm, got " + up.rpm);
  assert(engine.node.driveState === "operation enabled", "arrow up enables the drive");
  const down = await engine.nudgeSpeed(-1);
  assert(down.rpm === 0, "arrow down subtracts 100 rpm, got " + down.rpm);
  await engine.estop();
  assert(engine.node.driveState === "quick stop", "operator can e-stop");
  engine.accessLevel = "engineer";

  let abortMsg = "";
  try {
    await engine.readObject(1, 0x2222, 0);
  } catch (err) {
    abortMsg = err.message;
  }
  assert(/SDO abort 0x2222:0 0x06020000/.test(abortMsg) && /not in this controller/.test(abortMsg), "missing object abort, got " + abortMsg);

  const plate = { name: "Bench", poles: 4, amps: 12.5, volts: 48, rpm: 3000, ppr: 64 };
  const onPractice = await engine.storeNameplate(plate);
  assert(onPractice.ok && !onPractice.keptLocal, "practice nameplate stores, got " + JSON.stringify(onPractice));
  assert(engine.node.get(0x2000, 1).value === 4, "pole pairs stored");
  for (const sub of [0, 1, 2, 3, 4, 5, 6, 7]) engine.node.objects.delete(engine.node.key(0x2000, sub));
  engine.node.objects.delete(engine.node.key(0x2001, 2));
  engine.node.add(0x6075, 0, "Motor rated current", dcf.DT.UNSIGNED32, "rw", 0);
  engine.node.add(0x6080, 0, "Max motor speed", dcf.DT.UNSIGNED32, "rw", 0);
  const onInverter = await engine.storeNameplate(plate);
  assert(onInverter.ok && onInverter.keptLocal, "missing 0x2000 stays on the sheet, got " + JSON.stringify(onInverter));
  assert(onInverter.cia.includes("0x6075") && onInverter.cia.includes("0x6080"), "standard current and speed stored");
  assert(engine.node.get(0x6075, 0).value === 12500, "rated current in mA");
  assert(engine.node.get(0x6080, 0).value === 3000, "max motor speed");

  const realOnSdo = engine.node.onSdo.bind(engine.node);
  const segReqs = [];
  engine.node.onSdo = function (data) {
    const cmd = data[0];
    const ccs = cmd >> 5;
    const index = data[1] | (data[2] << 8);
    if (cmd === 0x80) {
      this.up = null;
      return;
    }
    if (ccs === 2 && index === 0x1008) {
      if (this.up && this.up.open) return this.abort(0x1008, 0, 0x05030000);
      this.up = { toggle: 0, open: true };
      this.reply(0x580 + this.id, [0x41, 0x08, 0x10, 0, 7, 0, 0, 0]);
      return;
    }
    if (ccs === 3) {
      segReqs.push(cmd);
      if (!this.up || !this.up.open) return this.abort(0x1008, 0, 0x05040001);
      const toggle = (cmd >> 4) & 1;
      if (toggle !== this.up.toggle) return this.abort(0x1008, 0, 0x05030000);
      if (this.up.toggle === 0) {
        this.up.toggle = 1;
        this.reply(0x580 + this.id, [0x00, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
        return;
      }
      this.up = null;
      this.reply(0x580 + this.id, [0x1f, 0, 0, 0, 0, 0, 0, 0]);
      return;
    }
    return realOnSdo(data);
  };
  const held = await engine.readObject(1, 0x1008, 0);
  assert(held.value === "ABCDEFG", "segmented name waits for the last bit, got " + held.value);
  assert(segReqs[0] === 0x60 && segReqs[1] === 0x70, "client requests both toggles, got " + segReqs.join(","));
  assert(!engine.node.up, "server transfer closed after the last segment");
  const heldAgain = await engine.readObject(1, 0x1008, 0);
  assert(heldAgain.value === "ABCDEFG" && segReqs.length === 4, "second device-name read starts clean");

  let nameState = "stuck";
  engine.node.onSdo = function (data) {
    const cmd = data[0];
    const ccs = cmd >> 5;
    if (cmd === 0x80) {
      nameState = "idle";
      return;
    }
    if (ccs === 2) {
      if (nameState === "stuck") {
        this.reply(0x580 + this.id, [0x80, 0x08, 0x10, 0, 0x01, 0x00, 0x04, 0x05]);
        return;
      }
      this.reply(0x580 + this.id, [0x43, 0x08, 0x10, 0, 0x54, 0x65, 0x73, 0x74]);
      return;
    }
    if (ccs === 3) this.reply(0x580 + this.id, [0x80, 0x08, 0x10, 0, 0x01, 0x00, 0x04, 0x05]);
  };
  const recovered = await engine.readObject(1, 0x1008, 0);
  assert(recovered.value === "Test", "busy name transfer is cleared and read again, got " + recovered.value);

  let open = true;
  engine.node.onSdo = function (data) {
    const cmd = data[0];
    const ccs = cmd >> 5;
    if (cmd === 0x80) return;
    if (ccs === 2) {
      if (open) {
        this.reply(0x580 + this.id, [0x80, 0x08, 0x10, 0, 0x01, 0x00, 0x04, 0x05]);
        return;
      }
      this.reply(0x580 + this.id, [0x43, 0x08, 0x10, 0, 0x54, 0x65, 0x73, 0x74]);
      return;
    }
    if (ccs === 3 && ((cmd >> 4) & 1) === 1 && open) {
      open = false;
      this.reply(0x580 + this.id, [0x1f, 0, 0, 0, 0, 0, 0, 0]);
      return;
    }
    if (ccs === 3) this.reply(0x580 + this.id, [0x80, 0x08, 0x10, 0, 0x01, 0x00, 0x04, 0x05]);
  };
  const drained = await engine.readObject(1, 0x1008, 0);
  assert(drained.value === "Test", "stuck name transfer is drained, got " + drained.value);

  let initiates = 0;
  engine.node.onSdo = function (data) {
    if (data[0] === 0x80) return;
    if ((data[0] >> 5) === 2) initiates += 1;
    this.reply(0x580 + this.id, [0x80, 0x08, 0x10, 0, 0x01, 0x00, 0x04, 0x05]);
  };
  let toggleMsg = "";
  try { await engine.readObject(1, 0x1008, 0); } catch (err) { toggleMsg = err.message; }
  assert(/0x05040001/.test(toggleMsg) && /previous transfer/.test(toggleMsg), "command abort stays visible, got " + toggleMsg);
  assert(initiates === 3, "busy transfer retry stops, got " + initiates);

  engine.node.onSdo = function (data) {
    const index = data[1] | (data[2] << 8);
    if (data[0] === 0x80) return;
    if ((data[0] >> 5) === 2 && index === 0x1008) {
      this.reply(0x580 + this.id, [0x80, 0x08, 0x10, 0, 0x01, 0x00, 0x04, 0x05]);
      return;
    }
    return realOnSdo(data);
  };
  const named = await engine.ping(1);
  assert(named.ok === true && named.name === "", "ping continues when the name is busy, got " + JSON.stringify(named));
  engine.node.onSdo = realOnSdo;
  engine.node.up = null;

  const present = await engine.probeDrive(1);
  assert(present.canSpin === true, "practice controller can spin, got " + JSON.stringify(present));
  engine.node.objects.delete(engine.node.key(0x6040, 0));
  const absent = await engine.probeDrive(1);
  assert(absent.known && absent.missing.includes("0x6040") && absent.canSpin === false, "missing controlword is reported, got " + JSON.stringify(absent));
  let blocked = "";
  try { await engine.demand("enable"); } catch (err) { blocked = err.message; }
  assert(/0x6040 is not in this controller/.test(blocked) && /leaves the shaft stopped/.test(blocked), "enable explains the missing controlword, got " + blocked);
  assert(engine.commandRpm === 0 && engine.motionReady === false, "enable leaves the shaft stopped");
  const safeStop = await engine.estop();
  assert(safeStop.ok === true && safeStop.rpm === 0 && safeStop.controlword === false, "estop still zeros speed, got " + JSON.stringify(safeStop));

  let writes = 0;
  engine.adapter = "ixxat";
  engine.hw = {
    write(frame) {
      const data = frame.data || [];
      if (data[0] === 0x80) return;
      writes += 1;
      engine.receive({
        id: 0x581,
        ext: false,
        data: [0x80, data[1], data[2], data[3], 0x00, 0x00, 0x02, 0x06],
        dlc: 8,
      });
    },
    poll() { return { frames: [], notes: [] }; },
    close() {},
  };
  let wire = "";
  try { await engine.demand("enable"); } catch (err) { wire = err.message; }
  assert(/0x6040 is not in this controller/.test(wire), "ixxat abort 0x06020000 is explained, got " + wire);
  assert(writes === 1, "enable stops after the first missing controlword, got " + writes);
  engine.adapter = "virtual";
  engine.hw = null;

  if (engine.sdoJob && engine.sdoJob.timer) clearTimeout(engine.sdoJob.timer);
  engine.stop();
  fs.unlinkSync(tmp);
  fs.unlinkSync(tmp2);

  const launchDir = path.join(os.tmpdir(), "zdvt update test");
  fs.mkdirSync(launchDir, { recursive: true });
  const launchMarker = path.join(launchDir, "ran.txt");
  const fakeSetup = path.join(launchDir, "setup.cmd");
  try { fs.unlinkSync(launchMarker); } catch { /* first run */ }
  fs.writeFileSync(fakeSetup, "@echo off\r\necho ok> \"" + launchMarker + "\"\r\nexit /b 0\r\n");
  updater.launchInstaller(fakeSetup, { relaunch: false });
  let launchCode = null;
  // The helper waits until Z-DVT Workbench.exe exits, up to about 22 seconds.
  const launchUntil = Date.now() + 28000;
  while (launchCode == null && Date.now() < launchUntil) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (fs.existsSync(launchMarker)) launchCode = updater.consumeUpdateResult();
  }
  assert(fs.existsSync(launchMarker), "setup launch keeps running after this program closes");
  assert(launchCode === "0", "setup result is success, got " + launchCode);

  if (failed) {
    console.error(failed + " failed");
    process.exit(1);
  }
  console.log("selftest ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
