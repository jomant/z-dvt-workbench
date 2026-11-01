"use strict";

const os = require("os");
const path = require("path");

function settingsDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "ZDVTWorkbench");
  }
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "ZDVTWorkbench");
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "ZDVTWorkbench");
}

function settingsPath() {
  const dir = settingsDir();
  return { dir, file: path.join(dir, "settings.json") };
}

module.exports = { settingsDir, settingsPath };
