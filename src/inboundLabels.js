const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "..", "data", "inboundLabels.json");

// 라벨 색상 팔레트 (고정 순서 - 라벨 생성 순서대로 순환 배정)
const COLOR_PALETTE = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#e34948", // red
];

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
  const all = readAll();
  // 색상 팔레트 추가 전에 만들어진 라벨은 색이 없을 수 있어 여기서 보정
  Object.keys(all).forEach((id, i) => {
    if (!all[id].color) all[id].color = COLOR_PALETTE[i % COLOR_PALETTE.length];
  });
  return all;
}

function createLabel({ name, leadTimeDays }) {
  const all = readAll();
  const id = "label_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const color = COLOR_PALETTE[Object.keys(all).length % COLOR_PALETTE.length];
  all[id] = { name, leadTimeDays: Number(leadTimeDays), color };
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
