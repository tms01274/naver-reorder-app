const fs = require("fs");
const path = require("path");

// data 폴더(업체 · 라벨 · 발주 기록 등)를 하루에 한 번 data/backups/날짜/ 에 복사해 둔다. 최근 14일치만 남긴다.
// 파일이 깨지거나 PC 를 옮길 때 관리자가 여기서 꺼내 쓴다.
const DATA_DIR = path.join(__dirname, "..", "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP_DAYS = 14;
// 네이버에서 다시 받으면 되는 것은 빼고
const SKIP = new Set(["naver-options.json", "naver-orders.json"]);

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function backupData() {
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    const target = path.join(BACKUP_DIR, today());
    if (fs.existsSync(target)) return;
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json") && !SKIP.has(f));
    if (!files.length) return;
    fs.mkdirSync(target, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(DATA_DIR, f), path.join(target, f));
    const days = fs.readdirSync(BACKUP_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) {
      fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
    }
  } catch (err) {
    console.error("자동 백업 실패:", err.message);
  }
}

// 서버를 켤 때 한 번, 그 뒤로는 켜 둔 채 날짜가 바뀌어도 백업되게 몇 시간마다 확인
function startDailyBackup() {
  backupData();
  setInterval(backupData, 3 * 60 * 60 * 1000).unref();
}

module.exports = { backupData, startDailyBackup };
