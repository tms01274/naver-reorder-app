const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "..", "data", "inboundLabels.json");

function readAll() {
  if (!fs.existsSync(FILE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// data 구조: { [labelId]: { name, leadTimeDays } }

function getAllLabels() {
  return readAll();
}

function createLabel({ name, leadTimeDays }) {
  const all = readAll();
  const id = "label_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  all[id] = { name, leadTimeDays: Number(leadTimeDays) };
  writeAll(all);
  return { id, ...all[id] };
}

function updateLabel(id, { name, leadTimeDays }) {
  const all = readAll();
  if (!all[id]) return null;
  all[id] = {
    ...all[id],
    ...(name !== undefined ? { name } : {}),
    ...(leadTimeDays !== undefined ? { leadTimeDays: Number(leadTimeDays) } : {}),
  };
  writeAll(all);
  return { id, ...all[id] };
}

function deleteLabel(id) {
  const all = readAll();
  delete all[id];
  writeAll(all);
}

module.exports = { getAllLabels, createLabel, updateLabel, deleteLabel };
