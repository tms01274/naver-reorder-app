// 화면 동작 테스트 (Chrome 으로 실제 버튼을 눌러 확인)
//
//   cd docs/tools
//   npm install                  (처음 한 번)
//   node e2e-test.js             → 전체 (약 40초)
//   node e2e-test.js order detail → 고친 기능 묶음만
//   node e2e-test.js --list      → 묶음 목록
//
// 묶음마다 샘플 품목으로 새 임시 서버를 띄우고 필요한 데이터를 미리 넣어서, 서로 상관없이 따로 돌 수 있다.
// 실제 data 폴더는 건드리지 않는다. 기능을 고치면 그 기능 묶음에 검사를 추가/수정한다.

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const { findChrome, startSampleServer, wait } = require("./sample-server");
const sample = require("./sampleData");

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
  if (!cond) fails++;
};

// ── 공용 준비물 ───────────────────────────────────────

const LABELS = { kr: { name: "국내", leadTimeDays: 5, color: "#2a78d6" }, cn: { name: "중국수입", leadTimeDays: 20, color: "#eb6834" } };
const VENDORS = { gw: { name: "글라스월드", email: "order@glassworld.co.kr", lang: "ko" }, ac: { name: "아크릴나라", email: "", lang: "ko" } };

let productsCache;
async function sampleProducts() {
  if (!productsCache) productsCache = await sample.fetchProducts();
  return productsCache;
}
async function idsWhere(fn) {
  return (await sampleProducts()).filter(fn).map((p) => p.id);
}
const isGlassArt = (p) => p.name.includes("글라스아트");

// 페이지에서 자주 쓰는 동작
function helpers(p) {
  return {
    toasts: () => p.$$eval(".toast", (t) => t.map((x) => x.textContent)),
    hidden: (id) => p.$eval("#" + id, (e) => e.hidden),
    txt: (sel) => p.$eval(sel, (e) => e.textContent.trim()),
    rows: async () => (await p.$$(".product-row")).length,
    esc: async () => { await p.keyboard.press("Escape"); await wait(150); },
    modalHeight: () => p.evaluate(() => {
      const o = [...document.querySelectorAll(".overlay")].find((x) => !x.hidden);
      return o ? Math.round(o.querySelector(".modal").getBoundingClientRect().height) : 0;
    }),
    // 처음 열 때 자동으로 뜨는 라벨 팝업 닫기
    closeAutoPopup: async () => { if (!(await p.$eval("#labelOverlay", (e) => e.hidden))) { await p.keyboard.press("Escape"); await wait(150); } },
  };
}

// ── 묶음 ──────────────────────────────────────────────

const SUITES = {};

SUITES.migration = {
  title: "예전 데이터 옮기기",
  seed: () => ({
    "suppliers.json": {
      "2001": { supplierName: "글라스월드", supplierEmail: "Order@GlassWorld.co.kr", labelId: "x" },
      "2002": { supplierName: "글라스월드 (영업)", supplierEmail: "order@glassworld.co.kr" },
      "2003": { supplierName: "아크릴나라", supplierEmail: "" },
      "2004": { supplierName: "", supplierEmail: "", leadTimeDays: 4 },
      "2005": { leadTimeDays: 2 },
    },
    "mail-template.json": { subject: "[발주] {{품목명}}", body: "{{품목명}} {{수량}}개 부탁드려요" },
  }),
  browser: false,
  async run({ server }) {
    const get = (r) => fetch(server.url + r).then((x) => x.json());
    const vendors = await get("/api/vendors");
    check("같은 이메일(대소문자 무관)은 업체 하나로", vendors.filter((v) => v.email.toLowerCase() === "order@glassworld.co.kr").length === 1, JSON.stringify(vendors));
    check("이메일 없으면 이름으로 업체 생성", vendors.some((v) => v.name === "아크릴나라" && v.email === ""));
    check("빈 업체 정보는 업체 안 만듦", vendors.length === 2, String(vendors.length));
    const { products } = await get("/api/products");
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));
    check("품목이 옮겨진 업체에 연결", byId["2001"].vendor?.email && byId["2001"].vendorId === byId["2002"].vendorId && byId["2003"].vendor?.name === "아크릴나라");
    check("업체 없던 품목은 그대로", !byId["2004"].vendorId && !byId["2005"].vendorId);
    check("다른 정보(리드타임) 유지", byId["2004"].leadTimeDays === 4 && byId["2005"].leadTimeDays === 2);
    const saved = JSON.parse(fs.readFileSync(path.join(server.dir, "data", "suppliers.json"), "utf8"));
    check("예전 업체명/이메일 칸 정리", !JSON.stringify(saved).includes("supplierName") && !JSON.stringify(saved).includes("supplierEmail"));
    const mt = await get("/api/mail-template");
    check("예전 메일 양식 → 새 발주서 양식 (3개 언어)", ["ko", "en", "zh"].every((l) => mt.templates[l].body.includes("{{품목목록}}")));
    check("예전 양식은 파일에 보관", JSON.parse(fs.readFileSync(path.join(server.dir, "data", "mail-template.json"), "utf8")).legacy?.body.includes("{{품목명}}"));
    check("옮겨진 업체는 한국어 발주서", vendors.every((v) => !v.lang || v.lang === "ko"));
  },
};

SUITES.whatsnew = {
  title: "업데이트 내용 · 가이드",
  async run({ p, server }) {
    const dataDir = path.join(server.dir, "data");
    const { CHANGELOG } = require(path.join(server.dir, "src", "changelog.js"));
    const state = async () => ({
      highlighted: await p.$eval("#openGuide", (e) => e.classList.contains("has-new")),
      banner: !(await p.$eval("#whatsNewBanner", (e) => e.hidden)),
    });
    const load = async () => { await p.goto(server.url, { waitUntil: "networkidle0" }); await wait(400); await helpers(p).closeAutoPopup(); };

    fs.rmSync(path.join(dataDir, "ui-state.json"), { force: true });
    await load();
    let s = await state();
    check("새 소식 → 버튼 강조 + 안내 띠", s.highlighted && s.banner, JSON.stringify(s));
    await p.click("#whatsNewBannerBtn"); await wait(400);
    check("업데이트 내용 탭부터 열림", !(await p.$eval("#guideUpdates", (e) => e.hidden)));
    check("모든 기록에 NEW", (await p.$$(".changelog-entry.is-new")).length === CHANGELOG.length);
    s = await state();
    check("열어보면 버튼 원래대로", !s.highlighted && !s.banner, JSON.stringify(s));
    const hUpdates = await helpers(p).modalHeight();
    await p.click('[data-guide-tab="howto"]'); await wait(150);
    check("사용 가이드 탭", !(await p.$eval("#guideHowto", (e) => e.hidden)));
    check("탭 바꿔도 팝업 높이 같음", (await helpers(p).modalHeight()) === hUpdates);
    check("설명서 카드가 사용 가이드 맨 위", await p.$eval("#guideHowto", (e) => e.firstElementChild.classList.contains("manual-card") && e.firstElementChild.textContent.includes("자세한 사용 설명서")));
    const dl = await p.$eval(".guide-download", (a) => a.href);
    check("Word 설명서 내려받기 링크", (await p.evaluate((u) => fetch(u).then((r) => r.status), dl)) === 200);
    await p.keyboard.press("Escape"); await wait(150);
    await p.click('.tab[data-tab="all"]'); await wait(100);
    check("가이드 연 뒤에도 메인 탭 정상", await p.$eval('.tab[data-tab="all"]', (e) => e.classList.contains("active")));

    await load();
    s = await state();
    check("다시 열어도 강조 안 됨", !s.highlighted && !s.banner, JSON.stringify(s));
    if (CHANGELOG.length > 1) {
      // 이전 기록까지만 확인한 상태 = 새 기록이 추가된 상황
      fs.writeFileSync(path.join(dataDir, "ui-state.json"), JSON.stringify({ lastSeenChangelogId: CHANGELOG[1].id }));
      await load();
      s = await state();
      check("새 기록 추가 → 다시 강조", s.highlighted && s.banner, JSON.stringify(s));
      await p.click("#openGuide"); await wait(300);
      check("새 기록 하나만 NEW", (await p.$$(".changelog-entry.is-new")).length === 1);
    }
  },
};

SUITES.labels = {
  title: "라벨 관리 (목록 · 품목에 지정)",
  async run({ p }) {
    const { toasts, txt, modalHeight } = helpers(p);
    const overlaysOpen = await p.$$eval(".overlay", (o) => o.filter((x) => getComputedStyle(x).display !== "none").map((x) => x.id));
    check("처음엔 라벨 팝업만 열림", JSON.stringify(overlaysOpen) === '["labelOverlay"]', JSON.stringify(overlaysOpen));
    check("제목 아틀리에 말리", (await p.title()).includes("아틀리에 말리"));
    check("라벨 없으면 목록 탭부터", (await txt("#labelManagerBody .tab.active")).startsWith("라벨 목록"));
    const hList = await modalHeight();
    await p.click('#labelManagerBody [data-mgr-tab="assign"]'); await wait(150);
    check("지정 탭: 라벨 먼저 만들라는 안내", !!(await p.$("#labelManagerBody .hint-box")));
    check("탭 바꿔도 팝업 높이 같음", (await modalHeight()) === hList);
    await p.click('#labelManagerBody [data-mgr-tab="list"]'); await wait(150);

    // 추가
    await p.click("#createLabelBtn"); await wait(200);
    check("빈 라벨 추가 → 에러 토스트", (await toasts()).some((t) => t.includes("모두 입력")));
    await p.type("#newLabelName", "국내"); await p.type("#newLabelLeadTime", "5"); await p.click("#createLabelBtn"); await wait(500);
    await p.type("#newLabelName", "중국수입"); await p.type("#newLabelLeadTime", "20"); await p.keyboard.press("Enter"); await wait(500);
    const labels = await p.$$eval(".label-edit-row[data-label-id] .label-edit-name", (x) => x.map((i) => i.value));
    check("라벨 2개 추가 (버튼 + Enter)", JSON.stringify(labels) === '["국내","중국수입"]', JSON.stringify(labels));
    const krId = await p.$$eval(".label-edit-row[data-label-id]", (r) => r[0].dataset.labelId);
    const cnId = await p.$$eval(".label-edit-row[data-label-id]", (r) => r[1].dataset.labelId);

    // 품목에 지정: 검색 → 전체 선택 → 지정
    await p.click('#labelManagerBody [data-mgr-tab="assign"]'); await wait(200);
    const before = (await p.$$("#labelManagerBody .assign-row")).length;
    await p.type("#labelAssignSearch", "글라스아트"); await wait(200);
    const searched = (await p.$$("#labelManagerBody .assign-row")).length;
    check("미지정 품목 검색", searched > 0 && searched < before, `${before} → ${searched}`);
    check("검색 중 입력칸 포커스 유지", await p.$eval("#labelAssignSearch", (e) => document.activeElement === e));
    await p.click("#labelAssignCheckAll"); await wait(150);
    check("전체 선택 → 버튼 숫자", (await txt("#labelAssignBtn")).includes(String(searched)));
    await p.click("#labelAssignBtn"); await wait(200);
    check("라벨 미선택 → 에러 토스트", (await toasts()).some((t) => t.includes("라벨을 선택")));
    await p.select("#labelAssignTarget", cnId); await p.click("#labelAssignBtn"); await wait(600);
    check("지정 토스트 문구", (await toasts()).some((t) => t.includes(`${searched}개 품목에 라벨을 지정했어요`)));
    const after = (await p.$$("#labelManagerBody .assign-row")).length;
    check("일괄 지정 후 남은 미지정", after === before - searched, `${before} - ${searched} → ${after}`);
    await p.click("#labelManagerBody .assign-row"); await wait(150);
    check("행 클릭으로 선택", (await txt("#labelAssignBtn")).includes("1개"));
    await p.select("#labelAssignTarget", krId); await p.click("#labelAssignBtn"); await wait(600);
    check("하나 더 지정", (await p.$$("#labelManagerBody .assign-row")).length === after - 1);
    // 긴 목록 아래쪽을 골라도 스크롤이 맨 위로 튀지 않아야 함 (매장 영상으로 신고된 문제)
    await p.setViewport({ width: 1366, height: 560 }); await wait(200);
    const pane = "#labelManagerBody .manager-pane";
    await p.$eval(pane, (e) => { e.scrollTop = e.scrollHeight; }); await wait(150);
    const topBefore = await p.$eval(pane, (e) => Math.round(e.scrollTop));
    const assignRows = await p.$$("#labelManagerBody .assign-row");
    await assignRows[assignRows.length - 1].click(); await wait(150);
    check("품목 체크해도 스크롤 위치 유지", topBefore > 0 && (await p.$eval(pane, (e) => Math.round(e.scrollTop))) === topBefore, `${topBefore}`);
    check("체크하면 버튼 숫자 바로 갱신", (await txt("#labelAssignBtn")).includes("1개"));
    await assignRows[assignRows.length - 1].click(); await wait(150);
    await p.setViewport({ width: 1366, height: 900 }); await wait(200);

    // 전체 품목 → 이미 지정된 품목 해제
    await p.select("#labelAssignFilter", "all"); await wait(200);
    check("전체 품목 보기 (현재 라벨 표시)", (await p.$$("#labelManagerBody .assign-row")).length === before && !!(await p.$("#labelManagerBody .assign-current .label-chip:not(.none)")));
    const labeledRow = await p.$$eval("#labelManagerBody .assign-row", (r) => r.findIndex((x) => !x.querySelector(".label-chip.none")));
    await (await p.$$("#labelManagerBody .assign-row"))[labeledRow].click(); await wait(150);
    await p.select("#labelAssignTarget", "__none__"); await p.click("#labelAssignBtn"); await wait(600);
    check("라벨 해제", (await toasts()).some((t) => t.includes("1개 품목의 라벨을 해제했어요")));
    await p.select("#labelAssignFilter", "none"); await wait(200);
    check("해제한 품목이 미지정으로 돌아옴", (await p.$$("#labelManagerBody .assign-row")).length === after);

    // 목록 탭: 수정 / 삭제 / 검색
    await p.click('#labelManagerBody [data-mgr-tab="list"]'); await wait(200);
    check("목록 탭에 라벨별 품목 수", (await p.$$eval(".label-edit-row[data-label-id] .small", (x) => x.map((e) => e.textContent))).every((t) => /품목 \d+개/.test(t)));
    const lt = await p.$(".label-edit-row[data-label-id] .label-edit-leadtime"); await lt.click({ clickCount: 3 }); await lt.type("3");
    await p.click(".label-edit-row[data-label-id] .update-label-btn"); await wait(500);
    check("라벨 리드타임 수정", await p.$eval(".label-edit-row[data-label-id] .label-edit-leadtime", (e) => e.value) === "3");
    await p.type("#newLabelName", "임시"); await p.type("#newLabelLeadTime", "1"); await p.click("#createLabelBtn"); await wait(500);
    const delBtn = async () => (await p.$$(".label-edit-row[data-label-id] .delete-label-btn"))[2];
    await (await delBtn()).click(); await wait(200);
    check("삭제 1번 누름 → 확인 상태", (await p.$$(".label-edit-row[data-label-id]")).length === 3 && (await (await delBtn()).evaluate((e) => e.textContent)).includes("한 번 더"));
    await (await delBtn()).click(); await wait(500);
    check("두 번 누르면 삭제", (await p.$$(".label-edit-row[data-label-id]")).length === 2);
    for (const n of ["a1", "a2", "a3", "a4"]) { await p.type("#newLabelName", n); await p.type("#newLabelLeadTime", "1"); await p.click("#createLabelBtn"); await wait(400); }
    check("라벨 많으면 검색칸 보임", !!(await p.$("#labelManagerBody .list-search")));
    await p.type("#labelManagerBody .list-search", "중국"); await wait(150);
    check("목록 검색으로 줄 숨김", (await p.$$eval(".label-edit-row[data-label-id]", (r) => r.filter((x) => !x.hidden).length)) === 1);
    await p.keyboard.press("Escape"); await wait(200);
    check("Esc 로 팝업 닫힘", await helpers(p).hidden("labelOverlay"));
  },
};

SUITES.main = {
  title: "첫 화면 (통계 · 탭 · 검색 · 라벨 필터)",
  async seed() {
    const ga = await idsWhere(isGlassArt);
    return {
      "inboundLabels.json": LABELS,
      "suppliers.json": Object.fromEntries([...ga.map((id) => [id, { labelId: "cn" }]), ["2005", { labelId: "kr" }]]),
    };
  },
  async run({ p, server }) {
    const { txt, rows, hidden } = helpers(p);
    const all = (await sampleProducts()).length;
    const cnCount = (await idsWhere(isGlassArt)).length;
    const unlabeled = all - cnCount - 1;
    await helpers(p).closeAutoPopup();
    const stat = async (id) => Number(await txt("#" + id));
    const reorderN = await stat("statReorder"), soonN = await stat("statSoon"), allN = await stat("statAll");
    check("통계 = 탭 숫자", reorderN === Number(await txt("#tabCountReorder")) && allN === Number(await txt("#tabCountAll")) && allN === all);
    check("라벨 미지정 수", (await stat("statUnlabeled")) === unlabeled, String(await stat("statUnlabeled")));
    check("발주 필요 목록 행 수", (await rows()) === reorderN);
    const firstStatus = await txt(".product-row .status");
    check("긴급한 순 정렬 (품절 먼저)", firstStatus === "품절", firstStatus);
    await p.click('.tab[data-tab="soon"]'); await wait(100);
    check("곧 필요 탭", (await rows()) === soonN);
    await p.click('.stat[data-tab="all"]'); await wait(100);
    check("통계 카드 클릭 → 전체 탭", (await rows()) === allN && await p.$eval('.tab[data-tab="all"]', (e) => e.classList.contains("active")));
    await p.type("#searchInput", "납선"); await wait(100);
    check("검색", (await rows()) === 2 && (await txt("#tabCountAll")) === "2", String(await rows()));
    await p.click("#searchInput", { clickCount: 3 }); await p.keyboard.press("Backspace"); await wait(100);
    await p.select("#labelFilter", "cn"); await wait(100);
    check("라벨 필터 (전체 탭에도 적용)", (await rows()) === cnCount, `${await rows()} / ${cnCount}`);
    await p.select("#labelFilter", "none"); await wait(100);
    check("라벨 없음 필터", (await rows()) === unlabeled);
    await p.select("#labelFilter", "all"); await wait(100);
    await p.click("#statUnlabeledCard"); await wait(200);
    check("라벨 미지정 카드 → 라벨 팝업 (지정 탭)", !(await hidden("labelOverlay")) && (await txt("#labelManagerBody .tab.active")).startsWith("품목에 지정"));
    await p.mouse.click(20, 450); await wait(200);
    check("바깥 클릭으로 닫힘", await hidden("labelOverlay"));
    await p.click("#refreshBtn"); await wait(600);
    check("새로고침 후 정상", (await rows()) > 0);
  },
};

SUITES.vendors = {
  title: "업체 관리 (목록 · 품목 연결)",
  async run({ p }) {
    const { toasts, txt, modalHeight } = helpers(p);
    await helpers(p).closeAutoPopup();
    await p.click("#openVendorManager"); await wait(200);
    check("업체 없으면 목록 탭부터", (await txt("#vendorManagerBody .tab.active")).startsWith("업체 목록"));
    await p.type("#newVendorName", "글라스월드"); await p.type("#newVendorEmail", "wrong-email"); await p.click("#createVendorBtn"); await wait(300);
    check("이메일 형식 틀림 → 에러", (await toasts()).some((t) => t.includes("이메일 주소 형식")));
    await p.click("#newVendorEmail", { clickCount: 3 }); await p.type("#newVendorEmail", "order@glassworld.co.kr"); await p.keyboard.press("Enter"); await wait(500);
    await p.type("#newVendorName", "아크릴나라"); await p.click("#createVendorBtn"); await wait(500);
    const vendorNames = await p.$$eval(".vendor-edit-row[data-vendor-id] .vendor-edit-name", (x) => x.map((i) => i.value));
    check("업체 2개 추가 (이메일 없이도 가능)", JSON.stringify(vendorNames) === '["글라스월드","아크릴나라"]', JSON.stringify(vendorNames));
    const gwId = await p.$$eval(".vendor-edit-row[data-vendor-id]", (r) => r[0].dataset.vendorId);
    const hList = await modalHeight();
    await p.click('#vendorManagerBody [data-mgr-tab="assign"]'); await wait(200);
    check("탭 바꿔도 팝업 높이 같음", (await modalHeight()) === hList);
    await p.type("#vendorAssignSearch", "글라스아트"); await wait(200);
    const gaCount = (await p.$$("#vendorManagerBody .assign-row")).length;
    await p.click("#vendorAssignCheckAll"); await wait(150);
    await p.select("#vendorAssignTarget", gwId); await p.click("#vendorAssignBtn"); await wait(600);
    check("검색 → 전체 선택 → 업체 연결", (await toasts()).some((t) => t.includes(`${gaCount}개 품목에 업체를 연결했어요`)), String(gaCount));
    await p.click('#vendorManagerBody [data-mgr-tab="list"]'); await wait(200);
    check("연결 후 품목 수 표시", (await p.$eval(".vendor-edit-row[data-vendor-id] .small", (e) => e.textContent)) === `품목 ${gaCount}개`);
    await p.keyboard.press("Escape"); await wait(200);
    check("목록에 업체 이름 표시", (await p.$$eval(".vendor-chip", (x) => x.map((e) => e.textContent))).includes("글라스월드"));
    await p.click("#openVendorManager"); await wait(200);
    check("미연결 품목 있으면 연결 탭부터", (await txt("#vendorManagerBody .tab.active")).startsWith("품목 연결"));
  },
};

SUITES.order = {
  title: "발주서 만들기",
  async seed() {
    const ga = await idsWhere(isGlassArt);
    return { "vendors.json": VENDORS, "suppliers.json": Object.fromEntries(ga.map((id) => [id, { vendorId: "gw" }])) };
  },
  async run({ p }) {
    const gaCount = (await idsWhere(isGlassArt)).length;
    await helpers(p).closeAutoPopup();
    await p.click("#openOrderBtn"); await wait(250);
    check("처음엔 업체 선택만", (await p.$$(".vendor-card")).length === 2 && !(await p.$(".order-row")));
    check("메일 버튼 비활성 (업체 미선택)", await p.$eval("#orderToMail", (e) => e.disabled));
    await p.click('[data-order-vendor="gw"]'); await wait(250);
    const orderRows = (await p.$$(".order-row")).length;
    check("업체 품목만 나옴", orderRows === gaCount, `${orderRows}/${gaCount}`);
    const preChecked = await p.$$eval(".order-row", (r) => r.filter((x) => x.querySelector(".order-check").checked).length);
    const needCount = await p.$eval('[data-order-vendor="gw"] .vendor-meta', (e) => e.textContent);
    check("발주 필요 품목 미리 체크", needCount.includes(String(preChecked)), `${preChecked} / ${needCount}`);
    const firstQty = await p.$(".order-row .order-qty");
    await firstQty.click({ clickCount: 3 }); await firstQty.type("50"); await wait(100);
    check("수량 칸 눌러도 체크 유지", await p.$eval(".order-row .order-check", (e) => e.checked));
    const firstName = await p.$eval(".order-row .order-name .name", (e) => e.textContent);
    const checkedRows = await p.$$(".order-row.checked");
    const lastChecked = checkedRows[checkedRows.length - 1];
    const removedName = await lastChecked.$eval(".order-name .name", (e) => e.textContent);
    await (await lastChecked.$(".order-name")).click(); await wait(100);
    check("이름 눌러 체크 해제", !(await lastChecked.$eval(".order-check", (e) => e.checked)));
    await p.type("#orderAddSearch", "낚싯줄"); await wait(150);
    await p.click(".order-add-item"); await wait(250);
    check("다른 품목 검색해서 추가 (체크됨)", await p.$$eval(".order-row", (r) => r.some((x) => x.textContent.includes("낚싯줄") && x.querySelector(".order-check").checked)));
    const summary = await p.$eval("#orderSummary", (e) => e.textContent);
    await p.click("#orderToMail"); await wait(250);
    const to = await p.$eval("#orderTo", (e) => e.value);
    const subject = await p.$eval("#orderSubject", (e) => e.value);
    const body = await p.$eval("#orderMailBody", (e) => e.value);
    check("받는 사람 = 업체 이메일", to === "order@glassworld.co.kr", to);
    check("제목에 날짜·건수", /\d{4}-\d{2}-\d{2}/.test(subject) && subject.includes("건"), subject);
    check("본문에 업체명", body.includes("글라스월드 담당자님"));
    check("본문에 바꾼 수량", body.includes(`${firstName} — 50개`));
    check("체크 해제한 품목은 빠짐", !body.includes(removedName));
    check("추가한 품목 포함", body.includes("낚싯줄"));
    check("본문 품목 수 = 요약", summary.includes(`${(body.match(/^\d+\. /gm) || []).length}개 품목`), summary);
    check("자리표시자 남지 않음", !/\{\{.+?\}\}/.test(subject + body));
    await p.click('[data-copy="orderMailBody"]'); await wait(200);
    const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
    check("본문 복사", clip === null ? (await p.$eval('[data-copy="orderMailBody"]', (e) => e.textContent)).includes("복사됨") : clip === body);
    check("네이버 메일 링크", (await p.$eval("#orderOpenNaver", (a) => a.href)).startsWith("https://mail.naver.com"));
    await p.click("#orderBack"); await wait(200);
    check("품목 다시 고르기 → 선택 유지", (await p.$eval(".order-row .order-qty", (e) => e.value)) === "50");
    await p.click('[data-order-vendor="ac"]'); await wait(250);
    check("품목 없는 업체 → 안내 + 이메일 없음 경고", !!(await p.$(".order-table .empty-note")) && !!(await p.$(".warn-box")));
    check("선택 0개면 메일 버튼 비활성", await p.$eval("#orderToMail", (e) => e.disabled));
  },
};

SUITES.detail = {
  title: "품목 상세 (업체 · 라벨 · 리드타임 · 상세에서 발주서)",
  seed: () => ({ "inboundLabels.json": LABELS, "vendors.json": VENDORS }),
  async run({ p }) {
    const { toasts, hidden } = helpers(p);
    const statValues = () => p.$$eval(".stat-box .value", (v) => v.map((x) => x.textContent));
    await helpers(p).closeAutoPopup();
    await p.click(".product-row"); await wait(200);
    check("상세 열림", !(await hidden("detailOverlay")));
    await p.select("#detailVendor", "ac");
    await p.select("#detailLabel", ""); await p.type("#productLeadTime", "4");
    await p.click("#saveSupplier"); await wait(600);
    check("상세 저장 → 토스트", (await toasts()).some((t) => t.includes("저장했어요")));
    check("저장값 유지", (await p.$eval("#detailVendor", (e) => e.value)) === "ac" && (await p.$eval("#productLeadTime", (e) => e.value)) === "4");
    check("라벨 없음", (await p.$eval("#detailLabel", (e) => e.value)) === "");
    check("리드타임 4일 반영", (await statValues())[2] === "4일");
    await p.click("#productLeadTime", { clickCount: 3 }); await p.keyboard.press("Backspace");
    await p.select("#detailLabel", "cn"); await p.click("#saveSupplier"); await wait(600);
    check("리드타임 비우면 라벨값(20일) 사용", (await statValues())[2] === "20일");
    const detailName = await p.$eval("#detailBody h3", (e) => e.textContent);
    await p.click("#orderFromDetail"); await wait(300);
    check("상세 → 발주서: 그 업체 선택 + 품목 체크", await p.$eval('[data-order-vendor="ac"]', (e) => e.classList.contains("active"))
      && await p.$$eval(".order-row", (r, n) => r.some((x) => x.textContent.includes(n) && x.querySelector(".order-check").checked), detailName));
    await p.click("#orderOverlay .btn-close"); await wait(150);
    check("X 로 발주서 닫힘", await hidden("orderOverlay"));
  },
};

SUITES.overseas = {
  title: "해외 업체 (영어 · 중국어 발주서, 업체용 품명)",
  seed: () => ({ "vendors.json": VENDORS, "suppliers.json": { "2003": { vendorId: "ac" } } }),
  async run({ p }) {
    await helpers(p).closeAutoPopup();
    await p.click("#openVendorManager"); await wait(200);
    await p.click('#vendorManagerBody [data-mgr-tab="list"]'); await wait(200);
    const acRow = '.vendor-edit-row[data-vendor-id="ac"]';
    await p.type(`${acRow} .vendor-edit-email`, "sales@acryl.cn");
    await p.select(`${acRow} .vendor-edit-lang`, "en");
    await p.click(`${acRow} .update-vendor-btn`); await wait(500);
    check("업체 언어 저장 (영어)", (await p.$eval(`${acRow} .vendor-edit-lang`, (e) => e.value)) === "en");
    await p.keyboard.press("Escape"); await wait(200);
    await p.click('.tab[data-tab="all"]'); await p.type("#searchInput", "SP05"); await wait(150);
    await p.click(".product-row"); await wait(250);
    const koName = await p.$eval("#detailBody h3", (e) => e.textContent);
    await p.type("#vendorItemName", "Sun catcher acrylic M"); await p.click("#saveSupplier"); await wait(600);
    check("업체용 품명 저장", (await p.$eval("#vendorItemName", (e) => e.value)) === "Sun catcher acrylic M");
    await p.click("#orderFromDetail"); await wait(300);
    check("업체 카드에 언어 표시", (await p.$eval('[data-order-vendor="ac"]', (e) => e.textContent)).includes("English"));
    check("품목에 업체용 품명 표시", (await p.$$eval(".vendor-item-name", (x) => x.map((e) => e.textContent))).some((t) => t.includes("Sun catcher acrylic M")));
    const q = await p.$(".order-row.checked .order-qty"); await q.click({ clickCount: 3 }); await q.type("12");
    await p.click("#orderToMail"); await wait(250);
    const enSubject = await p.$eval("#orderSubject", (e) => e.value);
    const enBody = await p.$eval("#orderMailBody", (e) => e.value);
    check("영어 제목", enSubject.startsWith("[Purchase Order] Atelier Mali"), enSubject);
    check("영어 본문 (업체명·업체용 품명·pcs)", enBody.includes("Dear 아크릴나라") && enBody.includes("Sun catcher acrylic M — 12 pcs") && enBody.includes("Best regards"), enBody.slice(0, 120));
    check("영어 발주서에 한국어 품명 없음", !enBody.includes(koName));
    check("받는 사람 = 바꾼 이메일", (await p.$eval("#orderTo", (e) => e.value)) === "sales@acryl.cn");
    check("메일 화면에 언어 표시", (await p.$eval("#orderBody h3", (e) => e.textContent)).includes("English"));
    await p.keyboard.press("Escape"); await wait(150);
    await p.click("#openVendorManager"); await wait(200);
    await p.click('#vendorManagerBody [data-mgr-tab="list"]'); await wait(200);
    await p.select(`${acRow} .vendor-edit-lang`, "zh"); await p.click(`${acRow} .update-vendor-btn`); await wait(500);
    await p.keyboard.press("Escape"); await wait(150);
    await p.click("#openOrderBtn"); await wait(200); await p.click('[data-order-vendor="ac"]'); await wait(200);
    await p.click("#orderToMail"); await wait(250);
    const zhBody = await p.$eval("#orderMailBody", (e) => e.value);
    check("중국어 본문 (件)", zhBody.includes("您好") && /— \d+ 件/.test(zhBody), zhBody.slice(0, 80));
  },
};

SUITES.records = {
  title: "발주 기록 (기록 · 입고 대기 · 입고 · 취소)",
  async seed() {
    const ga = await idsWhere(isGlassArt);
    return { "vendors.json": VENDORS, "suppliers.json": Object.fromEntries(ga.map((id) => [id, { vendorId: "gw" }])) };
  },
  async run({ p }) {
    const { txt, toasts } = helpers(p);
    await helpers(p).closeAutoPopup();
    const reorderBefore = Number(await txt("#tabCountReorder"));
    check("처음엔 입고 대기 없음", (await txt("#tabCountPending")) === "0" && (await p.$eval("#pendingCountBadge", (e) => e.hidden)));
    await p.click("#openOrderBtn"); await wait(200); await p.click('[data-order-vendor="gw"]'); await wait(250);
    const checkedIds = await p.$$eval(".order-row.checked", (r) => r.map((x) => x.dataset.orderId));
    await p.click("#orderToMail"); await wait(250);
    await p.$eval("#orderMailBody", (e) => { e.value += "\n(고친 내용)"; });
    await p.click("#orderRecord"); await wait(800);
    check("발주 완료로 기록", (await txt("#orderRecord")).includes("기록됨") && (await p.$eval("#orderRecord", (e) => e.disabled)));
    check("기록 토스트", (await toasts()).some((t) => t.includes(`${checkedIds.length}개 품목의 발주를 기록했어요`)));
    check("기록해도 메일 화면에서 고친 내용 유지", (await p.$eval("#orderMailBody", (e) => e.value)).includes("(고친 내용)"));
    await p.keyboard.press("Escape"); await wait(200);
    check("입고 대기 탭 숫자", Number(await txt("#tabCountPending")) === checkedIds.length);
    check("발주한 품목은 발주 필요에서 빠짐", Number(await txt("#tabCountReorder")) === reorderBefore - checkedIds.length, `${reorderBefore} → ${await txt("#tabCountReorder")}`);
    check("발주 기록 버튼에 대기 건수", (await txt("#pendingCountBadge")) === `입고 대기 ${checkedIds.length}`);
    await p.click('.tab[data-tab="pending"]'); await wait(150);
    check("입고 대기 탭에 발주함 표시", (await p.$$(".product-row .pending-chip")).length === checkedIds.length);
    // 같은 업체 발주서를 다시 열면 이미 발주한 품목은 체크 안 됨
    await p.click("#openOrderBtn"); await wait(200); await p.click('[data-order-vendor="gw"]'); await wait(250);
    check("이미 발주함 표시", (await p.$$(".order-row .pending-note")).length === checkedIds.length);
    check("이미 발주한 품목은 미리 체크 안 함", !(await p.$$eval(".order-row.checked", (r) => r.length)));
    await p.keyboard.press("Escape"); await wait(150);

    // 발주 기록 창: 품목 입고 → 모두 입고 → 되돌리기 → 취소
    await p.click("#openOrdersBtn"); await wait(300);
    check("발주 기록: 입고 대기 1건", (await p.$$(".order-card")).length === 1 && (await txt(".order-card .status")) === `입고 0/${checkedIds.length}`);
    await p.click(".order-item [data-receive]"); await wait(600);
    check("품목 하나 입고", (await txt(".order-card .status")) === `입고 1/${checkedIds.length}`);
    await p.click("[data-receive-all]"); await wait(600);
    check("모두 입고 → 입고 대기 비어 있음", !!(await p.$("#ordersBody .empty-note")));
    await p.click('[data-orders-tab="all"]'); await wait(200);
    check("전체 기록에 입고 완료로 남음", (await txt(".order-card .status")) === "입고 완료");
    await p.click(".order-item [data-unreceive]"); await wait(600);
    check("입고 되돌리기", (await txt(".order-card .status")) === `입고 ${checkedIds.length - 1}/${checkedIds.length}`);
    await p.click("[data-cancel-order]"); await wait(150);
    check("취소 1번 누름 → 확인 상태", (await txt("[data-cancel-order]")).includes("한 번 더"));
    await p.click("[data-cancel-order]"); await wait(600);
    check("두 번 누르면 발주 취소", (await p.$$(".order-card")).length === 0);
    await p.keyboard.press("Escape"); await wait(150);
    check("취소하면 다시 발주 필요", Number(await txt("#tabCountReorder")) === reorderBefore && (await txt("#tabCountPending")) === "0");
  },
};

SUITES.naver = {
  title: "네이버 응답 읽기 (실제 응답 모양으로 확인)",
  browser: false,
  seed: () => ({}),
  async run() {
    // 2026-09 매장 스토어 실제 응답의 "모양"을 흉내 낸 가짜 응답으로 naverClient 를 돌린다 (값은 가짜)
    const realFetch = global.fetch;
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    const order = (id, pid, qty, status) => ({
      productOrderId: id,
      content: {
        order: { orderId: "o" + id, paymentDate: hourAgo, orderDate: hourAgo },
        productOrder: { productOrderId: id, productId: pid, quantity: qty, productOrderStatus: status },
      },
    });
    global.fetch = async (url) => {
      const u = String(url);
      const json = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d), json: async () => d });
      if (u.includes("oauth2/token")) return json({ access_token: "t", expires_in: 10800 });
      if (u.includes("products/search")) {
        return json({ contents: [{ originProductNo: 1, channelProducts: [{ channelProductNo: 111, name: "시트지", stockQuantity: 5, salePrice: 1000, representativeImage: { url: "https://shop-phinf.pstatic.net/a.jpg" } }] }] });
      }
      if (u.includes("product-orders")) {
        return json({ data: { contents: [order("A", "111", 3, "DELIVERED"), order("A", "111", 3, "DELIVERED"), order("B", "111", 2, "CANCELED"), order("C", "111", 4, "PAYED"), order("D", "111", 1, "RETURNED")], pagination: { hasNext: false } } });
      }
      throw new Error("모르는 요청 " + u);
    };
    process.env.NAVER_CLIENT_ID = "x";
    process.env.NAVER_CLIENT_SECRET = "$2a$10$abcdefghijklmnopqrstuv"; // bcrypt salt 형식
    try {
      const modPath = require.resolve(path.join(__dirname, "..", "..", "src", "naverClient.js"));
      delete require.cache[modPath];
      const client = require(modPath);
      const products = await client.fetchProducts();
      check("상품 대표 사진 주소 읽기", products[0].imageUrl === "https://shop-phinf.pstatic.net/a.jpg", products[0].imageUrl);
      const orders = await client.fetchRecentOrders(1);
      check("주문을 content.productOrder 에서 읽기 (품목 번호·수량)", orders.every((o) => o.productId === "111") && orders.some((o) => o.quantity === 3));
      check("취소·반품 주문은 판매에서 제외", !orders.some((o) => o.quantity === 2 || o.quantity === 1));
      check("같은 주문이 두 번 와도 한 번만", orders.length === 2, String(orders.length));
      check("주문 날짜 = 결제일", orders.every((o) => o.orderedAt === hourAgo));
    } finally {
      global.fetch = realFetch;
    }
  },
};

SUITES.today = {
  title: "첫 화면 오늘 할 일 · 표/사진 보기 · 대량 주문 표시",
  async seed() {
    const ga = await idsWhere(isGlassArt);
    const due = new Date(Date.now() - 864e5).toISOString();
    return {
      "vendors.json": { ...VENDORS, sz: { name: "Shenzhen Acrylic", email: "s@sz.cn", lang: "zh" } },
      "suppliers.json": { ...Object.fromEntries(ga.map((id) => [id, { vendorId: "gw" }])), "2014": { vendorId: "sz" } },
      "orders.json": { o1: { vendorId: "gw", vendorName: "글라스월드", createdAt: new Date(Date.now() - 5 * 864e5).toISOString(), items: [{ productId: "2016", name: "투명 아크릴", qty: 3, expectedAt: due }] } },
    };
  },
  async run({ p, server }) {
    const { txt } = helpers(p);
    await helpers(p).closeAutoPopup();
    const titles = await p.$$eval("#todayTasks .task-title strong", (x) => x.map((e) => e.textContent.trim()));
    check("업체별 발주 할 일", titles.some((t) => t.startsWith("글라스월드에 발주하기")) && titles.some((t) => t.startsWith("Shenzhen Acrylic에 발주하기")), titles.join(" | "));
    check("해외 업체 언어 표시", titles.some((t) => t.includes("中文")));
    check("입고 지연 할 일", titles.some((t) => t.startsWith("입고 확인 · 지연 1품목")));
    check("업체 없는 품목 할 일", titles.some((t) => t.startsWith("업체 없는 품목 연결")));
    check("제목에 할 일 개수", (await txt("#pageTitle")) === `오늘 할 일 ${titles.length}가지`);
    const gwIdx = titles.findIndex((t) => t.startsWith("글라스월드"));
    await (await p.$$("#todayTasks [data-task]"))[gwIdx].click(); await wait(300);
    check("발주하기 → 그 업체 발주서", (await txt(".vendor-card.active .vendor-name")) === "글라스월드");
    await p.keyboard.press("Escape"); await wait(150);
    const btns = await p.$$eval("#todayTasks [data-task]", (b) => b.map((x) => x.textContent.trim()));
    await (await p.$$("#todayTasks [data-task]"))[btns.indexOf("입고 처리")].click(); await wait(300);
    check("입고 처리 → 발주 기록 창", !(await helpers(p).hidden("ordersOverlay")));
    await p.keyboard.press("Escape"); await wait(150);
    await (await p.$$("#todayTasks [data-task]"))[btns.indexOf("연결하기")].click(); await wait(300);
    check("연결하기 → 업체 관리 품목 연결 탭", (await txt("#vendorManagerBody .tab.active")).startsWith("품목 연결"));
    await p.keyboard.press("Escape"); await wait(150);

    // 표 / 사진 보기
    const rowsTable = (await p.$$(".product-row")).length;
    await p.click('.view-btn[data-view="cards"]'); await wait(300);
    check("사진 보기로 바꾸면 같은 품목이 카드로", (await p.$$(".product-card")).length === rowsTable && (await helpers(p).hidden("tableHead")));
    check("카드에 판매 그래프", (await p.$$(".product-card .card-spark polyline")).length > 0);
    await p.click(".product-card"); await wait(250);
    check("카드 누르면 상세", !(await helpers(p).hidden("detailOverlay")));
    await p.keyboard.press("Escape"); await wait(150);
    await p.goto(server.url, { waitUntil: "networkidle0" }); await wait(400); await helpers(p).closeAutoPopup();
    check("다시 열어도 사진 보기 유지", (await p.$eval(".view-btn.active", (e) => e.dataset.view)) === "cards" && (await p.$$(".product-card")).length > 0);
    await p.click('.view-btn[data-view="table"]'); await wait(300);
    check("표로 되돌리기", (await p.$$(".product-row")).length === rowsTable);

    // 품절 + 판매 기록 없음 → 직접 정하기 (샘플에서 '글라스아트 도안'은 판매 0)
    await p.click('.tab[data-tab="all"]'); await wait(150);
    check("판매 기록 없는 품목은 '판매 없음'", (await p.$$eval(".product-row .status", (x) => x.map((e) => e.textContent))).includes("판매 없음"));

    // 대량 주문 판단 (샘플엔 없어서 계산 함수를 직접 확인): 하루 475개 몰림 → 표시, 그 날 빼면 0
    const spike = await p.evaluate(() => spikeInfo({ dailySales: [0, 0, 475, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], leadTimeDays: 7, bufferDays: 3, stockQuantity: 0 }));
    check("하루에 몰린 대량 주문 감지", spike && spike.max === 475 && spike.velocity === 0 && spike.rec === 0, JSON.stringify(spike));
    const even = await p.evaluate(() => spikeInfo({ dailySales: [3, 2, 4, 3, 2, 3, 4, 2, 3, 3, 2, 4, 3, 2], leadTimeDays: 7, bufferDays: 3, stockQuantity: 0 }));
    check("고르게 팔리면 대량 주문 아님", even === null);
    const small = await p.evaluate(() => spikeInfo({ dailySales: [0, 0, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0], leadTimeDays: 7, bufferDays: 3, stockQuantity: 0 }));
    check("적은 수량은 대량 주문으로 안 봄", small === null);
  },
};

SUITES.settings = {
  title: "판단 기준",
  async run({ p }) {
    const { toasts, hidden, txt } = helpers(p);
    await helpers(p).closeAutoPopup();
    await p.click("#openSettings"); await wait(150);
    check("판단 기준 값 채워짐", (await p.$eval("#lookbackDays", (e) => e.value)) === "14");
    await p.click("#lookbackDays", { clickCount: 3 }); await p.keyboard.press("Backspace"); await p.click("#applySettings"); await wait(200);
    check("빈 값 적용 → 에러, 팝업 유지", (await toasts()).some((t) => t.includes("1일 이상")) && !(await hidden("settingsOverlay")));
    await p.type("#lookbackDays", "30"); await p.click("#applySettings"); await wait(600);
    check("적용 → 닫힘 + 문구 갱신", (await hidden("settingsOverlay")) && (await txt("#criteriaText")).includes("최근 30일"));
  },
};

SUITES.template = {
  title: "메일 양식 (언어별)",
  async run({ p }) {
    const { toasts, hidden } = helpers(p);
    await helpers(p).closeAutoPopup();
    await p.click("#openMailTemplate"); await wait(150);
    await p.click("#mtSubject"); await p.keyboard.press("End");
    await p.click('.placeholder-chips button[data-key="업체명"]'); await wait(100);
    check("자리표시자 삽입", (await p.$eval("#mtSubject", (e) => e.value)).endsWith("{{업체명}}"));
    await p.click("#saveTemplate"); await wait(400);
    check("양식 저장 → 토스트 (창은 유지)", !(await hidden("mailOverlay")) && (await toasts()).some((t) => t.includes("한국어 메일 양식")));
    await p.click('[data-template-lang="en"]'); await wait(100);
    check("영어 양식 탭", (await p.$eval("#mtBody", (e) => e.value)).includes("Dear {{업체명}}"));
    await p.click("#mtSubject"); await p.keyboard.press("End"); await p.keyboard.type(" #EN");
    await p.click('[data-template-lang="zh"]'); await wait(100);
    check("중국어 양식 탭", (await p.$eval("#mtBody", (e) => e.value)).includes("您好"));
    await p.click('[data-template-lang="en"]'); await wait(100);
    check("탭 바꿔도 고치던 내용 유지", (await p.$eval("#mtSubject", (e) => e.value)).endsWith("#EN"));
    await p.click("#saveTemplate"); await wait(400);
    check("영어 양식 저장", (await toasts()).some((t) => t.includes("English 메일 양식")));
    await p.$eval("#mtBody", (e) => { e.value = "품목 목록 없이"; });
    await p.click("#saveTemplate"); await wait(300);
    check("{{품목목록}} 없으면 저장 안 됨", (await toasts()).some((t) => t.includes("{{품목목록}}")));
    await p.keyboard.press("Escape"); await wait(150);
    await p.click("#openMailTemplate"); await wait(150);
    await p.click('[data-template-lang="en"]'); await wait(100);
    check("다시 열면 저장된 영어 양식", (await p.$eval("#mtSubject", (e) => e.value)).endsWith("#EN") && (await p.$eval("#mtBody", (e) => e.value)).includes("{{품목목록}}"));
  },
};

SUITES.layout = {
  title: "화면 공통 (중복 id · 모바일)",
  seed: () => ({ "inboundLabels.json": LABELS, "vendors.json": VENDORS }),
  async run({ p }) {
    await helpers(p).closeAutoPopup();
    // 같은 id 가 두 번 있으면 엉뚱한 칸이 동작한다 (지정 탭 보기 상자가 메인 라벨 필터와 겹쳤던 버그)
    for (const open of ["#openLabelManager", "#openVendorManager", "#openGuide", "#openOrderBtn"]) {
      await p.click(open); await wait(200);
      // 탭을 누르면 팝업을 다시 그리므로 매번 새로 찾아서 누른다
      for (const tab of ["list", "assign"]) {
        const btn = await p.$(`.overlay:not([hidden]) [data-mgr-tab="${tab}"]`);
        if (btn) { await btn.click(); await wait(100); }
      }
      await p.keyboard.press("Escape"); await wait(100);
    }
    const dupIds = await p.evaluate(() => { const c = {}; document.querySelectorAll("[id]").forEach((e) => { c[e.id] = (c[e.id] || 0) + 1; }); return Object.keys(c).filter((k) => c[k] > 1); });
    check("중복 id 없음", dupIds.length === 0, dupIds.join(","));
    await p.setViewport({ width: 400, height: 860 }); await wait(300);
    check("모바일 가로 스크롤 없음", !(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  },
};

// ── 실행 ──────────────────────────────────────────────

async function runSuite(name, browser, port) {
  const suite = SUITES[name];
  console.log(`\n[${name}] ${suite.title}`);
  const seed = suite.seed ? await suite.seed() : undefined;
  const server = await startSampleServer(port, { seed });
  let page;
  try {
    if (suite.browser === false) return await suite.run({ server });
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", async (d) => { errors.push("native dialog: " + d.message()); await d.accept(); });
    await page.goto(server.url, { waitUntil: "networkidle0" });
    await wait(400);
    await suite.run({ p: page, server });
    check("페이지 에러/네이티브 알림창 없음", errors.length === 0, errors.join(" | "));
  } finally {
    if (page) await page.close().catch(() => {});
    await server.stop();
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const [k, s] of Object.entries(SUITES)) console.log(`  ${k.padEnd(10)} ${s.title}`);
    return;
  }
  const unknown = args.filter((a) => !SUITES[a]);
  if (unknown.length) {
    console.error(`모르는 묶음: ${unknown.join(", ")}\n가능한 묶음: ${Object.keys(SUITES).join(", ")}`);
    process.exit(1);
  }
  const names = args.length ? args : Object.keys(SUITES);
  const started = Date.now();
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  try {
    let port = 3380;
    for (const name of names) await runSuite(name, browser, port++);
  } finally {
    await browser.close();
  }
  console.log(`\n${names.join(", ")} — ${Math.round((Date.now() - started) / 1000)}초`);
  console.log(fails ? `${fails}개 실패` : "모두 통과");
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
