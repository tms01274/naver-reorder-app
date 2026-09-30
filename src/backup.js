const fs = require("fs");
const os = require("os");
const path = require("path");

// data 폴더(업체 · 라벨 · 발주 기록 등)를 하루에 한 번 백업한다.
//  - 이 PC: data/backups/날짜/ (최근 14일)
//  - 구글 드라이브가 있으면: 구글 드라이브/아틀리에말리 백업/날짜/ (최근 30일) + 새PC-설치하기.bat
//    → PC 가 고장 나도 남고, 새 PC 에서는 구글 드라이브에서 설치 파일을 눌러 옮긴다 (src/setup.js)
// 네이버 API 키(.env)는 넣지 않는다 (새 PC 에서는 관리자가 넣는다).
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const KEEP_DAYS = 14;
const DRIVE_KEEP_DAYS = 30;
const DRIVE_FOLDER = "아틀리에말리 백업";
const SETUP_FILE = "새PC-설치하기.bat";
// 옮길 데이터 (네이버에서 다시 받으면 되는 캐시는 빼고)
const DATA_FILES = [
  "vendors.json", "suppliers.json", "inboundLabels.json", "orders.json", "order-drafts.json",
  "settings.json", "mail-template.json", "ui-state.json", "stock-watch.json",
];

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 구글 드라이브(데스크톱 앱) 폴더 찾기. 스트리밍 방식은 G: 같은 드라이브의 "내 드라이브",
// 미러링 방식은 사용자 폴더 아래 "내 드라이브"(예전 앱은 "Google Drive"). 테스트는 GOOGLE_DRIVE_DIR 로 지정
function findGoogleDrive() {
  if (process.env.GOOGLE_DRIVE_DIR) return fs.existsSync(process.env.GOOGLE_DRIVE_DIR) ? process.env.GOOGLE_DRIVE_DIR : null;
  const names = ["내 드라이브", "My Drive"];
  const candidates = [];
  if (process.platform === "win32") {
    for (const letter of "GHIJKLMNOPQRSTUVWXYZDEF") for (const n of names) candidates.push(`${letter}:\\${n}`);
  }
  const home = os.homedir();
  for (const n of [...names, "Google Drive", "GoogleDrive"]) candidates.push(path.join(home, n));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {}
  }
  return null;
}

function listDays(dir) {
  try {
    return fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  } catch {
    return [];
  }
}

function copyDataTo(target) {
  const files = DATA_FILES.filter((f) => fs.existsSync(path.join(DATA_DIR, f)));
  if (!files.length) return false;
  fs.mkdirSync(target, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(DATA_DIR, f), path.join(target, f));
  // 어느 PC 에서 언제 만든 백업인지 (새 PC 에서 고를 때 보여줌)
  fs.writeFileSync(path.join(target, "백업정보.json"), JSON.stringify({ pc: os.hostname(), at: new Date().toISOString(), files }, null, 2));
  return true;
}

function prune(dir, keep) {
  const days = listDays(dir);
  for (const old of days.slice(0, Math.max(0, days.length - keep))) fs.rmSync(path.join(dir, old), { recursive: true, force: true });
}

// force: 오늘 백업이 있어도 다시 ("지금 백업하기")
function backupData({ force = false } = {}) {
  const result = { local: false, drive: null };
  try {
    if (!fs.existsSync(DATA_DIR)) return result;
    const localTarget = path.join(BACKUP_DIR, today());
    if (force || !fs.existsSync(localTarget)) {
      result.local = copyDataTo(localTarget);
      prune(BACKUP_DIR, KEEP_DAYS);
    }
  } catch (err) {
    console.error("자동 백업 실패:", err.message);
  }
  const drive = findGoogleDrive();
  if (!drive) return result;
  try {
    const driveDir = path.join(drive, DRIVE_FOLDER);
    const target = path.join(driveDir, today());
    if (force || !fs.existsSync(target)) {
      result.drive = copyDataTo(target);
      prune(driveDir, DRIVE_KEEP_DAYS);
    }
    // 새 PC 설치 파일도 같이 둔다 (바뀌었으면 새로)
    const src = path.join(ROOT, SETUP_FILE);
    const dst = path.join(driveDir, SETUP_FILE);
    if (fs.existsSync(src) && (!fs.existsSync(dst) || fs.readFileSync(src).compare(fs.readFileSync(dst)) !== 0)) {
      fs.mkdirSync(driveDir, { recursive: true });
      fs.copyFileSync(src, dst);
    }
  } catch (err) {
    console.error("구글 드라이브 백업 실패:", err.message);
    result.drive = false;
  }
  return result;
}

// 서버를 켤 때 한 번, 그 뒤로는 켜 둔 채 날짜가 바뀌어도 백업되게 몇 시간마다 확인
function startDailyBackup() {
  backupData();
  setInterval(backupData, 3 * 60 * 60 * 1000).unref();
}

// 백업 폴더 하나의 내용 요약
function describeBackup(dir, date) {
  let info = {};
  try {
    info = JSON.parse(fs.readFileSync(path.join(dir, "백업정보.json"), "utf-8"));
  } catch {}
  const count = (file) => {
    try {
      return Object.keys(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"))).length;
    } catch {
      return 0;
    }
  };
  return { date, pc: info.pc || "", at: info.at || null, vendors: count("vendors.json"), orders: count("orders.json"), items: count("suppliers.json") };
}

// 화면용: 구글 드라이브 백업 상태 + 가져올 수 있는 백업 목록 (최신 먼저)
function backupStatus() {
  const drive = findGoogleDrive();
  const driveDir = drive ? path.join(drive, DRIVE_FOLDER) : null;
  const driveBackups = driveDir ? listDays(driveDir).reverse().map((d) => describeBackup(path.join(driveDir, d), d)) : [];
  const localBackups = listDays(BACKUP_DIR).reverse().map((d) => describeBackup(path.join(BACKUP_DIR, d), d));
  return { drive, driveFolder: driveDir, driveBackups, localFolder: BACKUP_DIR, localBackups };
}

// 백업 날짜 폴더 경로 (source: "drive" | "local")
function backupDir(source, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
  if (source === "local") return path.join(BACKUP_DIR, date);
  const drive = findGoogleDrive();
  return drive ? path.join(drive, DRIVE_FOLDER, date) : null;
}

module.exports = { backupData, startDailyBackup, backupStatus, backupDir, DATA_FILES, DATA_DIR, SETUP_FILE, DRIVE_FOLDER };
