const fs = require("fs");
const path = require("path");

// 화면 관련 상태 (예: 사용자가 마지막으로 확인한 업데이트 기록)
// 브라우저가 아니라 PC 의 data 폴더에 저장해서, 브라우저 기록을 지워도 유지된다
const FILE_PATH = path.join(__dirname, "..", "data", "ui-state.json");

function readUiState() {
  if (!fs.existsSync(FILE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveUiState(partial) {
  const merged = { ...readUiState(), ...partial };
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

module.exports = { readUiState, saveUiState };
