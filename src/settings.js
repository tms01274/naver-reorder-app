const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "..", "data", "settings.json");

function readSettings() {
  if (!fs.existsSync(FILE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(partial) {
  const merged = { ...readSettings(), ...partial };
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

module.exports = { readSettings, saveSettings };
