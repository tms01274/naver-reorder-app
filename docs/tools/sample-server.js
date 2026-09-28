// 샘플 품목으로 앱을 임시로 띄우는 도구 (설명서 캡처, 화면 테스트에서 공용)
// 실제 data 폴더와 .env 는 건드리지 않는다.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome 을 찾을 수 없어요. CHROME_PATH 환경변수로 chrome.exe 위치를 지정해주세요.");
  return found;
}

// 앱을 임시 폴더에 복사하고 mockData 를 샘플 품목(sampleData.js)으로 바꿔 끼운 뒤 서버를 띄운다
// seed: { "파일이름.json": 내용 } — 서버가 켜지기 전에 data 폴더에 넣어둘 파일 (예전 데이터 옮기기 테스트용)
async function startSampleServer(port, { seed } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mali-sample-"));
  for (const item of ["server.js", "package.json", "src", "public", "docs"]) {
    fs.cpSync(path.join(ROOT, item), path.join(dir, item), { recursive: true, filter: (src) => !src.includes(`${path.sep}tools`) });
  }
  fs.copyFileSync(path.join(__dirname, "sampleData.js"), path.join(dir, "src", "mockData.js"));
  if (seed) {
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    for (const [name, content] of Object.entries(seed)) {
      fs.writeFileSync(path.join(dir, "data", name), typeof content === "string" ? content : JSON.stringify(content, null, 2));
    }
  }

  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    // 임시 폴더에는 node_modules 가 없으므로 원래 프로젝트의 것을 쓴다
    env: { ...process.env, MOCK_MODE: "true", PORT: String(port), NODE_PATH: path.join(ROOT, "node_modules") },
    stdio: "ignore",
  });

  const stop = async () => {
    // 서버가 완전히 꺼진 뒤에 임시 폴더를 지운다 (Windows 는 사용 중인 폴더를 못 지움)
    if (child.exitCode === null) await new Promise((resolve) => { child.once("exit", resolve); child.kill(); });
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      console.warn("임시 폴더를 지우지 못했어요 (무시해도 됨):", dir);
    }
  };

  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/api/labels`);
      if (res.ok) return { url: `http://localhost:${port}`, dir, stop };
    } catch {}
    await wait(250);
  }
  await stop();
  throw new Error("샘플 서버가 켜지지 않았어요. 프로젝트 폴더에서 npm install 을 했는지 확인해주세요.");
}

module.exports = { ROOT, findChrome, startSampleServer, wait };
