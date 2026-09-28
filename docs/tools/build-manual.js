// 사용 설명서(Word)를 다시 만드는 도구
//
//   cd docs/tools
//   npm install          (처음 한 번)
//   node build-manual.js
//
// 하는 일:
//   1) 앱을 임시 폴더에 복사하고 샘플 품목(sampleData.js)으로 서버를 띄운다 (실제 data 폴더는 건드리지 않음)
//   2) Chrome 으로 화면을 캡처한다 (shots/ 폴더)
//   3) manual-content.js 의 내용으로 docs/아틀리에말리-사용설명서.docx 를 만든다
//   4) Word 가 설치돼 있으면 목차를 채워서 저장한다
//
// Chrome 위치가 다르면 CHROME_PATH 환경변수로 지정하세요.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const puppeteer = require("puppeteer-core");
const { build, Packer } = require("./manual-content");
const { ROOT, findChrome, startSampleServer, wait } = require("./sample-server");

const OUT_DOCX = path.join(ROOT, "docs", "아틀리에말리-사용설명서.docx");
const SHOTS = path.join(__dirname, "shots");
const PORT = 3399;

async function captureScreens(url) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1.5 });
  const post = (route, body) => p.evaluate((route, body) => fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()), route, body);

  // 라벨 2개 + 대부분 지정된 현실적인 상태 만들기
  await p.goto(url, { waitUntil: "networkidle0" });
  const kr = await post("/api/labels", { name: "국내", leadTimeDays: 5 });
  const cn = await post("/api/labels", { name: "중국수입", leadTimeDays: 20 });
  await post("/api/labels/assign", { productIds: ["2001", "2002", "2003", "2004", "2006", "2013", "2016", "2018"], labelId: cn.id });
  await post("/api/labels/assign", { productIds: ["2005", "2007", "2008", "2011", "2014", "2015"], labelId: kr.id });
  const gw = await post("/api/vendors", { name: "글라스월드", email: "order@glassworld.co.kr" });
  const ac = await post("/api/vendors", { name: "아크릴나라", email: "sales@acryl.kr" });
  await post("/api/vendors/assign", { productIds: ["2001", "2002", "2003", "2006", "2007", "2008", "2013", "2016", "2018"], vendorId: gw.id });
  await post("/api/vendors/assign", { productIds: ["2004", "2015", "2017"], vendorId: ac.id });
  await p.goto(url, { waitUntil: "networkidle0" });
  await wait(600);
  await p.mouse.move(0, 0);

  // clip 없이 부르면 열려 있는 팝업 부분만 잘라서 저장
  const shot = async (name, clip) => {
    await wait(350);
    if (!clip) {
      const box = await p.evaluate(() => {
        const o = [...document.querySelectorAll(".overlay")].find((x) => !x.hidden);
        if (!o) return null;
        const r = o.querySelector(".modal").getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      if (box) clip = { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 };
    }
    await p.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
    await p.screenshot({ path: path.join(SHOTS, `${name}.png`), clip });
  };
  const closeAll = async () => { await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await wait(250); };

  await closeAll(); // 자동으로 뜬 라벨 팝업
  await shot("00-highlight", { x: 0, y: 0, width: 1280, height: 300 });

  await p.click("#openGuide");
  await shot("07-guide");
  await closeAll();

  await p.click("#openLabelManager");
  await wait(200);
  await p.click('#labelManagerBody [data-mgr-tab="assign"]');
  await wait(150);
  await p.click("#labelManagerBody .assign-row");
  await p.click("#labelManagerBody .assign-row:nth-child(2)");
  await p.select("#labelAssignTarget", kr.id);
  await shot("04-labels");
  await closeAll();

  await shot("01-main", { x: 0, y: 0, width: 1280, height: 820 });
  await p.click('.tab[data-tab="all"]');
  await p.type("#searchInput", "썬캐쳐");
  await wait(200);
  await shot("02-search", { x: 0, y: 280, width: 1280, height: 420 });
  await p.click("#searchInput", { clickCount: 3 });
  await p.keyboard.press("Backspace");
  await p.click('.tab[data-tab="reorder"]');

  await p.click(".product-row");
  await shot("03-detail");
  await closeAll();

  await p.click("#openOrderBtn");
  await wait(200);
  await p.click(`[data-order-vendor="${gw.id}"]`);
  await shot("08-order");
  await p.click("#orderToMail");
  await wait(200);
  // 메일 화면은 세로로 길어서 캡처할 때만 창을 키워 한 번에 담는다
  await p.setViewport({ width: 1280, height: 1250, deviceScaleFactor: 1.5 });
  await wait(200);
  await p.click('[data-copy="orderTo"]');
  await shot("09-mail");
  // 발주 완료로 기록 → 기록 영역만 잘라서
  await p.click("#orderRecord");
  await wait(800);
  await p.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  const bar = await p.evaluate(() => {
    const r = document.querySelector("#orderOverlay .record-bar").getBoundingClientRect();
    return { x: r.x - 16, y: r.y - 70, width: r.width + 32, height: r.height + 86 };
  });
  await p.screenshot({ path: path.join(SHOTS, "12-record.png"), clip: bar });
  await p.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1.5 });
  await closeAll();

  await p.click('.tab[data-tab="pending"]');
  await wait(200);
  await shot("13-pending", { x: 0, y: 280, width: 1280, height: 420 });
  await p.click('.tab[data-tab="reorder"]');
  await p.click("#openOrdersBtn");
  await wait(300);
  await shot("14-orders");
  await closeAll();

  await p.click("#openVendorManager");
  await wait(200);
  await p.click('#vendorManagerBody [data-mgr-tab="assign"]');
  await wait(150);
  await p.click("#vendorManagerBody .assign-row");
  await p.select("#vendorAssignTarget", ac.id);
  await shot("10-vendors");
  await p.click('#vendorManagerBody [data-mgr-tab="list"]');
  await shot("11-vendor-list");
  await closeAll();
  await p.click("#openSettings");
  await shot("05-settings");
  await closeAll();
  await p.click("#openMailTemplate");
  await shot("06-mail");
  await closeAll();
  await browser.close();
}

// Word 가 있으면 목차를 채우고 저장 (없으면 Word 에서 목차 오른쪽 클릭 → 필드 업데이트)
function fillTableOfContents() {
  if (process.platform !== "win32") return false;
  const ps = `
    $w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0
    $d = $w.Documents.Open('${OUT_DOCX.replace(/'/g, "''")}')
    $d.TablesOfContents | ForEach-Object { $_.Update() }
    $d.Save(); $d.Close(); $w.Quit()`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 120000 });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const server = await startSampleServer(PORT);
  try {
    console.log("화면 캡처 중…");
    await captureScreens(server.url);
  } finally {
    await server.stop();
  }
  console.log("Word 문서 만드는 중…");
  fs.writeFileSync(OUT_DOCX, await Packer.toBuffer(build(SHOTS)));
  console.log(fillTableOfContents() ? "목차 채움 (Word)" : "Word 가 없어 목차는 비어 있어요. Word 에서 목차 오른쪽 클릭 → 필드 업데이트");
  console.log("완료:", OUT_DOCX);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
