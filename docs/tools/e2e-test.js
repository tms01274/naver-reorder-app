// 화면 동작 테스트 (Chrome 으로 실제 버튼을 눌러 확인)
//
//   cd docs/tools
//   npm install          (처음 한 번)
//   node e2e-test.js
//
// 샘플 품목으로 임시 서버를 띄워서 테스트하므로 실제 데이터는 건드리지 않는다.
// 기능을 고친 뒤에는 이 테스트가 모두 PASS 인지 확인하고 커밋하세요.

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const { findChrome, startSampleServer, wait } = require("./sample-server");

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
  if (!cond) fails++;
};

async function mainFlow(url) {
  console.log("\n[메인 화면 · 라벨 · 상세 · 판단 기준 · 메일 양식]");
  const b = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  const p = await b.newPage(); await p.setViewport({ width: 1366, height: 900 });
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', async d => { errors.push('native dialog: ' + d.message()); await d.accept(); });
  const toasts = async () => p.$$eval('.toast', t => t.map(x => x.textContent));
  const hidden = id => p.$eval('#' + id, e => e.hidden);
  const txt = sel => p.$eval(sel, e => e.textContent.trim());
  const rows = async () => (await p.$$('.product-row')).length;
  await p.goto(url, { waitUntil: 'networkidle0' }); await wait(500);

  // 1. 첫 화면 / 자동 라벨 팝업
  const overlaysOpen = await p.$$eval('.overlay', o => o.filter(x => getComputedStyle(x).display !== 'none').map(x => x.id));
  check('처음엔 라벨 팝업만 열림', JSON.stringify(overlaysOpen) === '["labelOverlay"]', JSON.stringify(overlaysOpen));
  check('제목 아틀리에 말리', (await p.title()).includes('아틀리에 말리'));
  check('안내 박스(라벨 먼저 만들기)', !!(await p.$('.hint-box')));

  // 2. 라벨 추가: 빈값 → 에러 토스트, Enter 키로 추가
  await p.click('#createLabelBtn'); await wait(200);
  check('빈 라벨 추가 → 에러 토스트', (await toasts()).some(t => t.includes('모두 입력')));
  await p.type('#newLabelName', '국내'); await p.type('#newLabelLeadTime', '5'); await p.click('#createLabelBtn'); await wait(500);
  await p.type('#newLabelName', '중국수입'); await p.type('#newLabelLeadTime', '20'); await p.keyboard.press('Enter'); await wait(500);
  const labels = await p.$$eval('.label-edit-row[data-label-id] .label-edit-name', x => x.map(i => i.value));
  check('라벨 2개 추가 (버튼 + Enter)', JSON.stringify(labels) === '["국내","중국수입"]', JSON.stringify(labels));

  // 3. 일괄 지정: 검색 → 전체 선택 → 지정
  const before = (await p.$$('.unlabeled-row')).length;
  await p.type('#unlabeledSearch', '글라스아트'); await wait(200);
  const searched = (await p.$$('.unlabeled-row')).length;
  check('미지정 품목 검색', searched > 0 && searched < before, `${before} → ${searched}`);
  check('검색 중 입력칸 포커스 유지', await p.$eval('#unlabeledSearch', e => document.activeElement === e));
  await p.click('#checkAllUnlabeled'); await wait(150);
  check('전체 선택 → 버튼 숫자', (await txt('#bulkAssignBtn')).includes(String(searched)), await txt('#bulkAssignBtn'));
  await p.click('#bulkAssignBtn'); await wait(200);
  check('라벨 미선택 → 에러 토스트', (await toasts()).some(t => t.includes('라벨을 선택')));
  const cnId = await p.$$eval('.label-edit-row[data-label-id]', r => r[1].dataset.labelId);
  const krId = await p.$$eval('.label-edit-row[data-label-id]', r => r[0].dataset.labelId);
  await p.select('#bulkLabelSelect', cnId); await p.click('#bulkAssignBtn'); await wait(600);
  const after = (await p.$$('.unlabeled-row')).length;
  check('일괄 지정 후 남은 미지정', after === before - searched, `${before} - ${searched} → ${after}`);
  await p.click('.unlabeled-row'); await wait(150);
  check('행 클릭으로 선택', (await txt('#bulkAssignBtn')).includes('1개'));
  await p.select('#bulkLabelSelect', krId); await p.click('#bulkAssignBtn'); await wait(600);
  check('하나 더 지정', (await p.$$('.unlabeled-row')).length === after - 1);
  
  // 4. 라벨 수정 / 삭제 (두 번 눌러야 삭제)
  const lt = await p.$('.label-edit-row[data-label-id] .label-edit-leadtime'); await lt.click({ clickCount: 3 }); await lt.type('3');
  await p.click('.label-edit-row[data-label-id] .update-label-btn'); await wait(500);
  check('라벨 리드타임 수정', await p.$eval('.label-edit-row[data-label-id] .label-edit-leadtime', e => e.value) === '3');
  await p.type('#newLabelName', '임시'); await p.type('#newLabelLeadTime', '1'); await p.click('#createLabelBtn'); await wait(500);
  const delBtn = async () => (await p.$$('.label-edit-row[data-label-id] .delete-label-btn'))[2];
  await (await delBtn()).click(); await wait(200);
  check('삭제 1번 누름 → 확인 상태', (await p.$$('.label-edit-row[data-label-id]')).length === 3 && (await (await delBtn()).evaluate(e => e.textContent)).includes('한 번 더'));
  await (await delBtn()).click(); await wait(500);
  check('두 번 누르면 삭제', (await p.$$('.label-edit-row[data-label-id]')).length === 2);

  // 5. Esc 로 닫기
  await p.keyboard.press('Escape'); await wait(200);
  check('Esc 로 팝업 닫힘', await hidden('labelOverlay'));

  // 6. 메인: 통계, 탭, 검색, 라벨 필터
  const stat = async id => Number(await txt('#' + id));
  const reorderN = await stat('statReorder'), soonN = await stat('statSoon'), allN = await stat('statAll');
  check('통계 = 탭 숫자', reorderN === Number(await txt('#tabCountReorder')) && allN === Number(await txt('#tabCountAll')));
  check('라벨 미지정 수 줄어듦', await stat('statUnlabeled') === after - 1, String(await stat('statUnlabeled')));
  check('발주 필요 목록 행 수', await rows() === reorderN);
  const firstStatus = await txt('.product-row .status');
  check('긴급한 순 정렬 (품절 먼저)', firstStatus === '품절', firstStatus);
  await p.click('.tab[data-tab="soon"]'); await wait(100);
  check('곧 필요 탭', await rows() === soonN);
  await p.click('.stat[data-tab="all"]'); await wait(100);
  check('통계 카드 클릭 → 전체 탭', await rows() === allN && await p.$eval('.tab[data-tab="all"]', e => e.classList.contains('active')));
  await p.type('#searchInput', '납선'); await wait(100);
  check('검색', await rows() === 2 && await txt('#tabCountAll') === '2', String(await rows()));
  await p.click('#searchInput', { clickCount: 3 }); await p.keyboard.press('Backspace'); await wait(100);
  await p.select('#labelFilter', cnId); await wait(100);
  check('라벨 필터 (전체 탭에도 적용)', await rows() === searched, String(await rows()));
  await p.select('#labelFilter', 'none'); await wait(100);
  check('라벨 없음 필터', await rows() === after - 1);
  await p.select('#labelFilter', 'all'); await wait(100);
  await p.click('#statUnlabeledCard'); await wait(200);
  check('라벨 미지정 카드 → 라벨 팝업', !(await hidden('labelOverlay')));
  await p.mouse.click(20, 450); await wait(200);
  check('바깥 클릭으로 닫힘', await hidden('labelOverlay'));
  
  // 7. 상세: 라벨 변경 / 리드타임 / 공급업체 저장
  await p.click('.product-row'); await wait(200);
  check('상세 열림', !(await hidden('detailOverlay')));
  await p.click('#sendMailBtn'); await wait(200);
  check('이메일 없이 메일 → 에러 토스트', (await toasts()).some(t => t.includes('이메일')));
  await p.select('#detailLabel', ''); await p.type('#supplierName', 'OO상사'); await p.type('#supplierEmail', 'a@b.com'); await p.type('#productLeadTime', '4');
  await p.click('#saveSupplier'); await wait(600);
  check('상세 저장 → 토스트', (await toasts()).some(t => t.includes('저장했어요')));
  check('저장값 유지', await p.$eval('#supplierName', e => e.value) === 'OO상사' && await p.$eval('#productLeadTime', e => e.value) === '4');
  check('라벨 없음으로 변경됨', await p.$eval('#detailLabel', e => e.value) === '');
  check('리드타임 4일 반영', (await p.$$eval('.stat-box .value', v => v.map(x => x.textContent)))[2] === '4일');
  await p.click('#productLeadTime', { clickCount: 3 }); await p.keyboard.press('Backspace');
  await p.select('#detailLabel', cnId); await p.click('#saveSupplier'); await wait(600);
  check('리드타임 비우면 라벨값(20일) 사용', (await p.$$eval('.stat-box .value', v => v.map(x => x.textContent)))[2] === '20일');
    await p.click('#detailOverlay .btn-close'); await wait(150);
  check('X 로 상세 닫힘', await hidden('detailOverlay'));

  // 8. 판단 기준
  await p.click('#openSettings'); await wait(150);
  check('판단 기준 값 채워짐', await p.$eval('#lookbackDays', e => e.value) === '14');
  await p.click('#lookbackDays', { clickCount: 3 }); await p.keyboard.press('Backspace'); await p.click('#applySettings'); await wait(200);
  check('빈 값 적용 → 에러, 팝업 유지', (await toasts()).some(t => t.includes('1일 이상')) && !(await hidden('settingsOverlay')));
  await p.type('#lookbackDays', '30'); await p.click('#applySettings'); await wait(600);
  check('적용 → 닫힘 + 문구 갱신', await hidden('settingsOverlay') && (await txt('#criteriaText')).includes('최근 30일'));

  // 9. 메일 양식: 자리표시자 삽입 + 저장
  await p.click('#openMailTemplate'); await wait(150);
  await p.click('#mtSubject'); await p.keyboard.press('End');
  await p.click('.placeholder-chips button[data-key="업체명"]'); await wait(100);
  check('자리표시자 삽입', (await p.$eval('#mtSubject', e => e.value)).endsWith('{{업체명}}'));
  await p.click('#saveTemplate'); await wait(400);
  check('양식 저장 → 닫힘', await hidden('mailOverlay') && (await toasts()).some(t => t.includes('메일 양식')));

  // 10. 새로고침
  await p.click('#refreshBtn'); await wait(600);
  check('새로고침 후 정상', await rows() > 0);

  check('페이지 에러/네이티브 알림창 없음', errors.length === 0, errors.join(' | '));

  // 모바일 화면
  await p.setViewport({ width: 400, height: 860 }); await wait(300);
    check('모바일 가로 스크롤 없음', !(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  await b.close();
}

async function whatsNewFlow(url, dataDir, entries) {
  console.log("\n[업데이트 내용 · 가이드]");
  const b = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  const p = await b.newPage();
  await p.setViewport({ width: 1366, height: 900 });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const state = async () => ({
    highlighted: await p.$eval("#openGuide", (e) => e.classList.contains("has-new")),
    banner: !(await p.$eval("#whatsNewBanner", (e) => e.hidden)),
  });
  const load = async () => { await p.goto(url, { waitUntil: "networkidle0" }); await wait(400); await p.keyboard.press("Escape"); await wait(200); };

  // 확인 기록 없음 → 강조
  fs.rmSync(path.join(dataDir, "ui-state.json"), { force: true });
  await load();
  let s = await state();
  check("새 소식 → 버튼 강조 + 안내 띠", s.highlighted && s.banner, JSON.stringify(s));
  await p.click("#whatsNewBannerBtn"); await wait(400);
  check("업데이트 내용 탭부터 열림", !(await p.$eval("#guideUpdates", (e) => e.hidden)));
  check("모든 기록에 NEW", (await p.$$(".changelog-entry.is-new")).length === entries);
  s = await state();
  check("열어보면 버튼 원래대로", !s.highlighted && !s.banner, JSON.stringify(s));
  await p.click('[data-guide-tab="howto"]'); await wait(150);
  check("사용 가이드 탭", !(await p.$eval("#guideHowto", (e) => e.hidden)));
  const dl = await p.$eval(".guide-download", (a) => a.href);
  const status = await p.evaluate((u) => fetch(u).then((r) => r.status), dl);
  check("Word 설명서 내려받기 링크", status === 200, String(status));
  await p.keyboard.press("Escape"); await wait(150);
  await p.click('.tab[data-tab="all"]'); await wait(100);
  check("가이드 연 뒤에도 메인 탭 정상", await p.$eval('.tab[data-tab="all"]', (e) => e.classList.contains("active")));

  await load();
  s = await state();
  check("다시 열어도 강조 안 됨", !s.highlighted && !s.banner, JSON.stringify(s));

  // 이전 기록까지만 확인한 상태 = 새 기록이 추가된 상황
  if (entries > 1) {
    const { CHANGELOG } = require(path.join(dataDir, "..", "src", "changelog.js"));
    fs.writeFileSync(path.join(dataDir, "ui-state.json"), JSON.stringify({ lastSeenChangelogId: CHANGELOG[1].id }));
    await load();
    s = await state();
    check("새 기록 추가 → 다시 강조", s.highlighted && s.banner, JSON.stringify(s));
    await p.click("#openGuide"); await wait(300);
    check("새 기록 하나만 NEW", (await p.$$(".changelog-entry.is-new")).length === 1);
  }
  check("페이지 에러 없음", errors.length === 0, errors.join(" | "));
  await b.close();
}

(async () => {
  const server = await startSampleServer(3398);
  try {
    await whatsNewFlow(server.url, path.join(server.dir, "data"), require(path.join(server.dir, "src", "changelog.js")).CHANGELOG.length);
    fs.rmSync(path.join(server.dir, "data"), { recursive: true, force: true }); // 메인 흐름은 빈 데이터에서 시작
    await mainFlow(server.url);
  } finally {
    await server.stop();
  }
  console.log(fails ? `\n${fails}개 실패` : "\n모두 통과");
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
