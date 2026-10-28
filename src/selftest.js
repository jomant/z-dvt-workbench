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
  engine.adapter = "virtual";
  engine.hw = null;

  if (engine.sdoJob && engine.sdoJob.timer) clearTimeout(engine.sdoJob.timer);
  engine.stop();
  fs.unlinkSync(tmp);
  fs.unlinkSync(tmp2);

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
