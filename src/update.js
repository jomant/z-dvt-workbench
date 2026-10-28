"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const REPO = process.env.ZDVT_UPDATE_REPO || "jomant/z-dvt-workbench";
const ASSET = "Z-DVT-Workbench-Setup.exe";

function parts(version) {
  return String(version || "").trim().replace(/^v/i, "").split(".").map((piece) => {
    const n = parseInt(piece, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function newerThan(remote, local) {
  const a = parts(remote);
  const b = parts(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
}

async function check(localVersion) {
  if (process.env.ZDVT_NO_UPDATE === "1") return null;
  const response = await fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Z-DVT-Workbench",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Update check failed (" + response.status + ")");
  const body = await response.json();
  const version = String(body.tag_name || "").replace(/^v/i, "");
  if (!version || !newerThan(version, localVersion)) return null;
  const asset = (body.assets || []).find((item) => item.name === ASSET);
  if (!asset || !asset.browser_download_url) return null;
  return {
    version,
    notes: String(body.body || "").trim(),
    url: asset.browser_download_url,
    name: asset.name,
  };
}

async function download(offer) {
  const response = await fetch(offer.url, {
    headers: { "User-Agent": "Z-DVT-Workbench", Accept: "application/octet-stream" },
  });
  if (!response.ok) throw new Error("Download failed (" + response.status + ")");
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length < 100000) throw new Error("The downloaded installer is too small to be the setup program.");
  const file = path.join(os.tmpdir(), ASSET);
  fs.writeFileSync(file, data);
  return file;
}

function launchInstaller(file) {
  const quoted = "'" + String(file).replace(/'/g, "''") + "'";
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-Command",
    "Start-Sleep -Seconds 2; Start-Process -FilePath " + quoted,
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

module.exports = {
  REPO,
  ASSET,
  newerThan,
  check,
  download,
  launchInstaller,
};
