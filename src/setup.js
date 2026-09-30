const fs = require("fs");
const os = require("os");
const path = require("path");
const { backupStatus, backupDir, DATA_FILES, DATA_DIR } = require("./backup");

// 새 PC 설정: 백업 가져오기 · 네이버 API 키 넣기 · 지금 상태 확인.
// 새 PC 에서는 구글 드라이브의 '새PC-설치하기.bat' 로 프로그램을 설치한 뒤, 화면의 '새 PC 설정' 창에서 이걸 쓴다.
const ENV_FILE = path.join(__dirname, "..", ".env");
const ENV_EXAMPLE = path.join(__dirname, "..", ".env.example");

function hasData() {
  return ["vendors.json", "suppliers.json", "orders.json"].some((f) => fs.existsSync(path.join(DATA_DIR, f)));
}

function keysSet() {
  return !!(String(process.env.NAVER_CLIENT_ID || "").trim() && String(process.env.NAVER_CLIENT_SECRET || "").trim());
}

// 백업 파일들로 data 를 바꾼다. files: { "vendors.json": 내용(문자열) , ... }
// replaceAll: 백업 폴더 통째로 가져올 때는 백업에 없는 파일을 지워 예전 PC 상태 그대로 만든다.
//   (USB 에서 파일을 골라 가져올 때는 일부만 골랐을 수 있으니 고른 파일만 바꾼다)
// 지금 data 는 먼저 data/backups/가져오기전-시각/ 에 남겨 둔다 (잘못 가져왔을 때 되돌릴 수 있게)
function restoreFiles(files, { replaceAll = false } = {}) {
  const clean = {};
  for (const [name, text] of Object.entries(files || {})) {
    if (!DATA_FILES.includes(name)) continue;
    try {
      clean[name] = JSON.stringify(JSON.parse(String(text)), null, 2);
    } catch {
      throw new Error(`${name} 파일이 깨져 있어요. 다른 날짜의 백업을 골라주세요.`);
    }
  }
  if (!Object.keys(clean).length) throw new Error("가져올 백업 파일이 없어요. 백업 폴더 안의 .json 파일들을 골라주세요.");

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const existing = DATA_FILES.filter((f) => fs.existsSync(path.join(DATA_DIR, f)));
  if (existing.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const keep = path.join(DATA_DIR, "backups", `가져오기전-${stamp}`);
    fs.mkdirSync(keep, { recursive: true });
    for (const f of existing) fs.copyFileSync(path.join(DATA_DIR, f), path.join(keep, f));
  }
  if (replaceAll) for (const f of existing) if (!clean[f]) fs.rmSync(path.join(DATA_DIR, f), { force: true });
  for (const [name, text] of Object.entries(clean)) fs.writeFileSync(path.join(DATA_DIR, name), text, "utf-8");
  return Object.keys(clean);
}

function restoreFromBackup(source, date) {
  const dir = backupDir(source, date);
  if (!dir || !fs.existsSync(dir)) throw new Error("그 백업을 찾을 수 없어요.");
  const files = {};
  for (const f of DATA_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) files[f] = fs.readFileSync(p, "utf-8");
  }
  return restoreFiles(files, { replaceAll: true });
}

// .env 에 네이버 API 키를 넣고 실제 데이터 모드로. 지금 서버에도 바로 반영(process.env)
function saveNaverKeys(clientId, clientSecret) {
  const id = String(clientId || "").trim();
  const secret = String(clientSecret || "").trim();
  if (!id || !secret) throw new Error("client_id 와 client_secret 을 모두 넣어주세요.");
  if (/[\r\n]/.test(id + secret)) throw new Error("키에 줄바꿈이 들어 있어요. 다시 붙여넣어 주세요.");
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf-8") : fs.existsSync(ENV_EXAMPLE) ? fs.readFileSync(ENV_EXAMPLE, "utf-8") : "";
  const set = (key, value) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, () => `${key}=${value}`) : `${text.replace(/\s*$/, "")}\n${key}=${value}\n`;
    process.env[key] = value;
  };
  set("NAVER_CLIENT_ID", id);
  set("NAVER_CLIENT_SECRET", secret);
  set("MOCK_MODE", "false");
  fs.writeFileSync(ENV_FILE, text, "utf-8");
}

// 이 PC 의 인터넷 주소 (네이버 API 는 등록된 주소에서만 호출된다 → 관리자에게 알려줄 때)
async function publicIp() {
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(4000) });
    return (await res.json()).ip || null;
  } catch {
    return null;
  }
}

async function setupStatus({ mockMode }) {
  return {
    pc: os.hostname(),
    hasData: hasData(),
    keysSet: keysSet(),
    mockMode,
    ...backupStatus(),
  };
}

module.exports = { setupStatus, restoreFiles, restoreFromBackup, saveNaverKeys, publicIp, hasData, keysSet };
