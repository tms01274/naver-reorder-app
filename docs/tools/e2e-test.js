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

  // 팝업 높이 (탭을 바꿔도 같아야 함)
  const modalHeight = () => p.evaluate(() => {
    const o = [...document.querySelectorAll('.overlay')].find(x => !x.hidden);
    return o ? Math.round(o.querySelector('.modal').getBoundingClientRect().height) : 0;
  });

  // 1. 첫 화면 / 자동 라벨 팝업 (라벨이 없으면 '라벨 목록' 탭부터)
  const overlaysOpen = await p.$$eval('.overlay', o => o.filter(x => getComputedStyle(x).display !== 'none').map(x => x.id));
  check('처음엔 라벨 팝업만 열림', JSON.stringify(overlaysOpen) === '["labelOverlay"]', JSON.stringify(overlaysOpen));
  check('제목 아틀리에 말리', (await p.title()).includes('아틀리에 말리'));
  check('라벨 없으면 목록 탭부터', (await txt('#labelManagerBody .tab.active')).startsWith('라벨 목록'));
  const hList = await modalHeight();
  await p.click('#labelManagerBody [data-mgr-tab="assign"]'); await wait(150);
  check('지정 탭: 라벨 먼저 만들라는 안내', !!(await p.$('#labelManagerBody .hint-box')));
  check('탭 바꿔도 팝업 높이 같음', (await modalHeight()) === hList, `${hList} / ${await modalHeight()}`);
  await p.click('#labelManagerBody [data-mgr-tab="list"]'); await wait(150);

  // 2. 라벨 추가: 빈값 → 에러 토스트, Enter 키로 추가
  await p.click('#createLabelBtn'); await wait(200);
  check('빈 라벨 추가 → 에러 토스트', (await toasts()).some(t => t.includes('모두 입력')));
  await p.type('#newLabelName', '국내'); await p.type('#newLabelLeadTime', '5'); await p.click('#createLabelBtn'); await wait(500);
  await p.type('#newLabelName', '중국수입'); await p.type('#newLabelLeadTime', '20'); await p.keyboard.press('Enter'); await wait(500);
  const labels = await p.$$eval('.label-edit-row[data-label-id] .label-edit-name', x => x.map(i => i.value));
  check('라벨 2개 추가 (버튼 + Enter)', JSON.stringify(labels) === '["국내","중국수입"]', JSON.stringify(labels));
  const cnId = await p.$$eval('.label-edit-row[data-label-id]', r => r[1].dataset.labelId);
  const krId = await p.$$eval('.label-edit-row[data-label-id]', r => r[0].dataset.labelId);

  // 3. 품목에 지정 탭: 검색 → 전체 선택 → 지정
  await p.click('#labelManagerBody [data-mgr-tab="assign"]'); await wait(200);
  const before = (await p.$$('#labelManagerBody .assign-row')).length;
  await p.type('#labelAssignSearch', '글라스아트'); await wait(200);
  const searched = (await p.$$('#labelManagerBody .assign-row')).length;
  check('미지정 품목 검색', searched > 0 && searched < before, `${before} → ${searched}`);
  check('검색 중 입력칸 포커스 유지', await p.$eval('#labelAssignSearch', e => document.activeElement === e));
  await p.click('#labelAssignCheckAll'); await wait(150);
  check('전체 선택 → 버튼 숫자', (await txt('#labelAssignBtn')).includes(String(searched)), await txt('#labelAssignBtn'));
  await p.click('#labelAssignBtn'); await wait(200);
  check('라벨 미선택 → 에러 토스트', (await toasts()).some(t => t.includes('라벨을 선택')));
  await p.select('#labelAssignTarget', cnId); await p.click('#labelAssignBtn'); await wait(600);
  check('지정 토스트 문구', (await toasts()).some(t => t.includes(`${searched}개 품목에 라벨을 지정했어요`)));
  const after = (await p.$$('#labelManagerBody .assign-row')).length;
  check('일괄 지정 후 남은 미지정', after === before - searched, `${before} - ${searched} → ${after}`);
  await p.click('#labelManagerBody .assign-row'); await wait(150);
  check('행 클릭으로 선택', (await txt('#labelAssignBtn')).includes('1개'));
  await p.select('#labelAssignTarget', krId); await p.click('#labelAssignBtn'); await wait(600);
  check('하나 더 지정', (await p.$$('#labelManagerBody .assign-row')).length === after - 1);
  // 전체 품목 보기 → 이미 지정된 품목 해제
  await p.select('#labelAssignFilter', 'all'); await wait(200);
  check('전체 품목 보기 (현재 라벨 표시)', (await p.$$('#labelManagerBody .assign-row')).length === before && !!(await p.$('#labelManagerBody .assign-current .label-chip:not(.none)')));
  const labeledRow = await p.$$eval('#labelManagerBody .assign-row', r => r.findIndex(x => !x.querySelector('.label-chip.none')));
  await (await p.$$('#labelManagerBody .assign-row'))[labeledRow].click(); await wait(150);
  await p.select('#labelAssignTarget', '__none__'); await p.click('#labelAssignBtn'); await wait(600);
  check('라벨 해제', (await toasts()).some(t => t.includes('1개 품목의 라벨을 해제했어요')));
  await p.select('#labelAssignFilter', 'none'); await wait(200);
  check('해제한 품목이 미지정으로 돌아옴', (await p.$$('#labelManagerBody .assign-row')).length === after);
  // 다시 지정해서 이후 검사 숫자 맞추기
  await p.click('#labelManagerBody .assign-row:last-child'); await p.select('#labelAssignTarget', cnId); await p.click('#labelAssignBtn'); await wait(600);

  // 4. 라벨 목록 탭: 수정 / 삭제 (두 번 눌러야 삭제)
  await p.click('#labelManagerBody [data-mgr-tab="list"]'); await wait(200);
  check('목록 탭에 라벨별 품목 수', (await p.$$eval('.label-edit-row[data-label-id] .small', x => x.map(e => e.textContent))).every(t => /품목 \d+개/.test(t)));
  const lt = await p.$('.label-edit-row[data-label-id] .label-edit-leadtime'); await lt.click({ clickCount: 3 }); await lt.type('3');
  await p.click('.label-edit-row[data-label-id] .update-label-btn'); await wait(500);
  check('라벨 리드타임 수정', await p.$eval('.label-edit-row[data-label-id] .label-edit-leadtime', e => e.value) === '3');
  await p.type('#newLabelName', '임시'); await p.type('#newLabelLeadTime', '1'); await p.click('#createLabelBtn'); await wait(500);
  const delBtn = async () => (await p.$$('.label-edit-row[data-label-id] .delete-label-btn'))[2];
  await (await delBtn()).click(); await wait(200);
  check('삭제 1번 누름 → 확인 상태', (await p.$$('.label-edit-row[data-label-id]')).length === 3 && (await (await delBtn()).evaluate(e => e.textContent)).includes('한 번 더'));
  await (await delBtn()).click(); await wait(500);
  check('두 번 누르면 삭제', (await p.$$('.label-edit-row[data-label-id]')).length === 2);
  // 라벨이 6개 이상이면 목록 검색칸
  for (const n of ['a1', 'a2', 'a3', 'a4']) { await p.type('#newLabelName', n); await p.type('#newLabelLeadTime', '1'); await p.click('#createLabelBtn'); await wait(400); }
  check('라벨 많으면 검색칸 보임', !!(await p.$('#labelManagerBody .list-search')));
  await p.type('#labelManagerBody .list-search', '중국'); await wait(150);
  check('목록 검색으로 줄 숨김', (await p.$$eval('.label-edit-row[data-label-id]', r => r.filter(x => !x.hidden).length)) === 1);
  await p.click('#labelManagerBody .list-search', { clickCount: 3 }); await p.keyboard.press('Backspace'); await wait(100);
  for (let i = 0; i < 4; i++) {
    const btn = async () => (await p.$$('.label-edit-row[data-label-id] .delete-label-btn'))[2];
    await (await btn()).click(); await wait(100); await (await btn()).click(); await wait(400);
  }
  check('추가 라벨 정리', (await p.$$('.label-edit-row[data-label-id]')).length === 2);

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
  const cnCount = await p.evaluate((id) => fetch('/api/products').then(r => r.json()).then(d => d.products.filter(x => x.labelId === id).length), cnId);
  check('라벨 필터 (전체 탭에도 적용)', await rows() === cnCount && cnCount > 0, `${await rows()} / ${cnCount}`);
  await p.select('#labelFilter', 'none'); await wait(100);
  check('라벨 없음 필터', await rows() === after - 1);
  await p.select('#labelFilter', 'all'); await wait(100);
  await p.click('#statUnlabeledCard'); await wait(200);
  check('라벨 미지정 카드 → 라벨 팝업 (지정 탭)', !(await hidden('labelOverlay')) && (await txt('#labelManagerBody .tab.active')).startsWith('품목에 지정'));
  await p.mouse.click(20, 450); await wait(200);
  check('바깥 클릭으로 닫힘', await hidden('labelOverlay'));

  // 7. 업체 관리: 목록 탭에서 추가 / 형식 검사 → 품목 연결 탭에서 일괄 연결
  await p.click('#openVendorManager'); await wait(200);
  check('업체 없으면 목록 탭부터', (await txt('#vendorManagerBody .tab.active')).startsWith('업체 목록'));
  await p.type('#newVendorName', '글라스월드'); await p.type('#newVendorEmail', 'wrong-email'); await p.click('#createVendorBtn'); await wait(300);
  check('이메일 형식 틀림 → 에러', (await toasts()).some(t => t.includes('이메일 주소 형식')));
  await p.click('#newVendorEmail', { clickCount: 3 }); await p.type('#newVendorEmail', 'order@glassworld.co.kr'); await p.keyboard.press('Enter'); await wait(500);
  await p.type('#newVendorName', '아크릴나라'); await p.click('#createVendorBtn'); await wait(500);
  const vendorNames = await p.$$eval('.vendor-edit-row[data-vendor-id] .vendor-edit-name', x => x.map(i => i.value));
  check('업체 2개 추가 (이메일 없이도 가능)', JSON.stringify(vendorNames) === '["글라스월드","아크릴나라"]', JSON.stringify(vendorNames));
  const gwId = await p.$$eval('.vendor-edit-row[data-vendor-id]', r => r[0].dataset.vendorId);
  const acId = await p.$$eval('.vendor-edit-row[data-vendor-id]', r => r[1].dataset.vendorId);
  const hVendorList = await modalHeight();
  await p.click('#vendorManagerBody [data-mgr-tab="assign"]'); await wait(200);
  check('업체 팝업도 탭 바꿔도 높이 같음', (await modalHeight()) === hVendorList && hVendorList === hList);
  await p.type('#vendorAssignSearch', '글라스아트'); await wait(200);
  const gaCount = (await p.$$('#vendorManagerBody .assign-row')).length;
  await p.click('#vendorAssignCheckAll'); await wait(150);
  await p.select('#vendorAssignTarget', gwId); await p.click('#vendorAssignBtn'); await wait(600);
  check('검색 → 전체 선택 → 업체 연결', (await toasts()).some(t => t.includes(`${gaCount}개 품목에 업체를 연결했어요`)), String(gaCount));
  await p.click('#vendorManagerBody [data-mgr-tab="list"]'); await wait(200);
  check('연결 후 품목 수 표시', (await p.$eval('.vendor-edit-row[data-vendor-id] .small', e => e.textContent)) === `품목 ${gaCount}개`);
  await p.keyboard.press('Escape'); await wait(200);
  check('목록에 업체 이름 표시', (await p.$$eval('.vendor-chip', x => x.map(e => e.textContent))).includes('글라스월드'));
  await p.click('#openVendorManager'); await wait(200);
  check('미연결 품목 있으면 연결 탭부터', (await txt('#vendorManagerBody .tab.active')).startsWith('품목 연결'));
  await p.keyboard.press('Escape'); await wait(150);

  // 8. 발주서 만들기: 업체 선택 → 품목·수량 → 메일 내용 → 복사
  await p.click('#openOrderBtn'); await wait(250);
  check('발주서: 처음엔 업체 선택만', (await p.$$('.vendor-card')).length === 2 && !(await p.$('.order-row')));
  check('메일 버튼 비활성 (업체 미선택)', await p.$eval('#orderToMail', e => e.disabled));
  await p.click(`[data-order-vendor="${gwId}"]`); await wait(250);
  const orderRows = (await p.$$('.order-row')).length;
  check('업체 품목만 나옴', orderRows === gaCount, `${orderRows}/${gaCount}`);
  const preChecked = await p.$$eval('.order-row', r => r.filter(x => x.querySelector('.order-check').checked).length);
  const needCount = await p.$eval(`[data-order-vendor="${gwId}"] .vendor-meta`, e => e.textContent);
  check('발주 필요 품목 미리 체크', needCount.includes(String(preChecked)), `${preChecked} / ${needCount}`);
  // 수량 바꾸기, 하나 체크 해제, 다른 업체 품목 추가
  const firstQty = await p.$('.order-row .order-qty');
  await firstQty.click({ clickCount: 3 }); await firstQty.type('50'); await wait(100);
  check('수량 칸 눌러도 체크 유지', await p.$eval('.order-row .order-check', e => e.checked));
  const firstName = await p.$eval('.order-row .order-name .name', e => e.textContent);
  const checkedRows = await p.$$('.order-row.checked');
  const lastChecked = checkedRows[checkedRows.length - 1];
  const removedName = await lastChecked.$eval('.order-name .name', e => e.textContent);
  await (await lastChecked.$('.order-name')).click(); await wait(100);
  check('이름 눌러 체크 해제', !(await lastChecked.$eval('.order-check', e => e.checked)));
  await p.type('#orderAddSearch', '낚싯줄'); await wait(150);
  await p.click('.order-add-item'); await wait(250);
  check('다른 품목 검색해서 추가 (체크됨)', await p.$$eval('.order-row', r => r.some(x => x.textContent.includes('낚싯줄') && x.querySelector('.order-check').checked)));
  const summary = await p.$eval('#orderSummary', e => e.textContent);
  await p.click('#orderToMail'); await wait(250);
  const to = await p.$eval('#orderTo', e => e.value);
  const subject = await p.$eval('#orderSubject', e => e.value);
  const body = await p.$eval('#orderMailBody', e => e.value);
  check('받는 사람 = 업체 이메일', to === 'order@glassworld.co.kr', to);
  check('제목에 날짜·건수', /\d{4}-\d{2}-\d{2}/.test(subject) && subject.includes('건'), subject);
  check('본문에 업체명', body.includes('글라스월드 담당자님'));
  check('본문에 바꾼 수량', body.includes(`${firstName} — 50개`));
  check('체크 해제한 품목은 빠짐', !body.includes(removedName));
  check('추가한 품목 포함', body.includes('낚싯줄'));
  check('본문 품목 수 = 요약', summary.includes(`${(body.match(/^\d+\. /gm) || []).length}개 품목`), summary);
  check('자리표시자 남지 않음', !/\{\{.+?\}\}/.test(subject + body));
  await p.click('[data-copy="orderMailBody"]'); await wait(200);
  const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
  check('본문 복사', clip === null ? (await p.$eval('[data-copy="orderMailBody"]', e => e.textContent)).includes('복사됨') : clip === body);
  check('네이버 메일 링크', (await p.$eval('#orderOpenNaver', a => a.href)).startsWith('https://mail.naver.com'));
  await p.click('#orderBack'); await wait(200);
  check('품목 다시 고르기 → 선택 유지', await p.$eval('.order-row .order-qty', e => e.value) === '50');
  await p.click(`[data-order-vendor="${acId}"]`); await wait(250);
  check('품목 없는 업체 → 안내 + 이메일 없음 경고', !!(await p.$('.order-table .empty-note')) && !!(await p.$('.warn-box')));
  check('선택 0개면 메일 버튼 비활성', await p.$eval('#orderToMail', e => e.disabled));
  await p.keyboard.press('Escape'); await wait(200);

  // 9. 상세: 업체 · 라벨 변경 / 리드타임 저장 / 상세에서 발주서
  await p.click('.product-row'); await wait(200);
  check('상세 열림', !(await hidden('detailOverlay')));
  await p.select('#detailVendor', acId);
  await p.select('#detailLabel', ''); await p.type('#productLeadTime', '4');
  await p.click('#saveSupplier'); await wait(600);
  check('상세 저장 → 토스트', (await toasts()).some(t => t.includes('저장했어요')));
  check('저장값 유지', await p.$eval('#detailVendor', e => e.value) === acId && await p.$eval('#productLeadTime', e => e.value) === '4');
  check('라벨 없음으로 변경됨', await p.$eval('#detailLabel', e => e.value) === '');
  check('리드타임 4일 반영', (await p.$$eval('.stat-box .value', v => v.map(x => x.textContent)))[2] === '4일');
  await p.click('#productLeadTime', { clickCount: 3 }); await p.keyboard.press('Backspace');
  await p.select('#detailLabel', cnId); await p.click('#saveSupplier'); await wait(600);
  check('리드타임 비우면 라벨값(20일) 사용', (await p.$$eval('.stat-box .value', v => v.map(x => x.textContent)))[2] === '20일');
  const detailName = await p.$eval('#detailBody h3', e => e.textContent);
  await p.click('#orderFromDetail'); await wait(300);
  check('상세 → 발주서: 그 업체 선택 + 품목 체크', await p.$eval(`[data-order-vendor="${acId}"]`, e => e.classList.contains('active'))
    && await p.$$eval('.order-row', (r, n) => r.some(x => x.textContent.includes(n) && x.querySelector('.order-check').checked), detailName));
  await p.click('#orderOverlay .btn-close'); await wait(150);
  check('X 로 발주서 닫힘', await hidden('orderOverlay'));

  // 9-2. 해외 업체: 발주서 언어 + 업체용 품명
  await p.click('#openVendorManager'); await wait(200);
  await p.click('#vendorManagerBody [data-mgr-tab="list"]'); await wait(200);
  const acRow = `.vendor-edit-row[data-vendor-id="${acId}"]`;
  await p.type(`${acRow} .vendor-edit-email`, 'sales@acryl.cn');
  await p.select(`${acRow} .vendor-edit-lang`, 'en');
  await p.click(`${acRow} .update-vendor-btn`); await wait(500);
  check('업체 언어 저장 (영어)', await p.$eval(`${acRow} .vendor-edit-lang`, e => e.value) === 'en');
  await p.keyboard.press('Escape'); await wait(200);
  await p.click('.tab[data-tab="all"]'); await p.type('#searchInput', detailName.slice(0, 8)); await wait(150);
  await p.click('.product-row'); await wait(250);
  await p.type('#vendorItemName', 'Sun catcher acrylic M'); await p.click('#saveSupplier'); await wait(600);
  check('업체용 품명 저장', await p.$eval('#vendorItemName', e => e.value) === 'Sun catcher acrylic M');
  await p.click('#orderFromDetail'); await wait(300);
  check('발주서 업체 카드에 언어 표시', (await p.$eval(`[data-order-vendor="${acId}"]`, e => e.textContent)).includes('English'));
  check('발주서 품목에 업체용 품명 표시', (await p.$$eval('.vendor-item-name', x => x.map(e => e.textContent))).some(t => t.includes('Sun catcher acrylic M')));
  const q = await p.$('.order-row.checked .order-qty'); await q.click({ clickCount: 3 }); await q.type('12');
  await p.click('#orderToMail'); await wait(250);
  const enSubject = await p.$eval('#orderSubject', e => e.value);
  const enBody = await p.$eval('#orderMailBody', e => e.value);
  check('영어 제목', enSubject.startsWith('[Purchase Order] Atelier Mali'), enSubject);
  check('영어 본문 (업체명·업체용 품명·pcs)', enBody.includes('Dear 아크릴나라') && enBody.includes('Sun catcher acrylic M — 12 pcs') && enBody.includes('Best regards'), enBody.slice(0, 120));
  check('영어 발주서에 한국어 품명 없음', !enBody.includes(detailName));
  check('받는 사람 = 바꾼 이메일', await p.$eval('#orderTo', e => e.value) === 'sales@acryl.cn');
  check('메일 화면에 언어 표시', (await p.$eval('#orderBody h3', e => e.textContent)).includes('English'));
  await p.keyboard.press('Escape'); await wait(150);
  // 중국어로 바꾸면 중국어 양식
  await p.click('#openVendorManager'); await wait(200);
  await p.click('#vendorManagerBody [data-mgr-tab="list"]'); await wait(200);
  await p.select(`${acRow} .vendor-edit-lang`, 'zh'); await p.click(`${acRow} .update-vendor-btn`); await wait(500);
  await p.keyboard.press('Escape'); await wait(150);
  await p.click('#openOrderBtn'); await wait(200); await p.click(`[data-order-vendor="${acId}"]`); await wait(200);
  await p.click('#orderToMail'); await wait(250);
  const zhBody = await p.$eval('#orderMailBody', e => e.value);
  check('중국어 본문 (件)', zhBody.includes('您好') && /— \d+ 件/.test(zhBody), zhBody.slice(0, 80));
  await p.keyboard.press('Escape'); await wait(150);
  await p.click('#searchInput', { clickCount: 3 }); await p.keyboard.press('Backspace'); await wait(100);

  // 10. 판단 기준
  await p.click('#openSettings'); await wait(150);
  check('판단 기준 값 채워짐', await p.$eval('#lookbackDays', e => e.value) === '14');
  await p.click('#lookbackDays', { clickCount: 3 }); await p.keyboard.press('Backspace'); await p.click('#applySettings'); await wait(200);
  check('빈 값 적용 → 에러, 팝업 유지', (await toasts()).some(t => t.includes('1일 이상')) && !(await hidden('settingsOverlay')));
  await p.type('#lookbackDays', '30'); await p.click('#applySettings'); await wait(600);
  check('적용 → 닫힘 + 문구 갱신', await hidden('settingsOverlay') && (await txt('#criteriaText')).includes('최근 30일'));

  // 11. 메일 양식: 자리표시자 삽입 + 저장
  await p.click('#openMailTemplate'); await wait(150);
  await p.click('#mtSubject'); await p.keyboard.press('End');
  await p.click('.placeholder-chips button[data-key="업체명"]'); await wait(100);
  check('자리표시자 삽입', (await p.$eval('#mtSubject', e => e.value)).endsWith('{{업체명}}'));
  await p.click('#saveTemplate'); await wait(400);
  check('양식 저장 → 토스트 (창은 유지)', !(await hidden('mailOverlay')) && (await toasts()).some(t => t.includes('한국어 메일 양식')));
  // 언어 탭: 영어로 바꿨다 돌아와도 고치던 내용 유지, 언어별 저장
  await p.click('[data-template-lang="en"]'); await wait(100);
  check('영어 양식 탭', (await p.$eval('#mtBody', e => e.value)).includes('Dear {{업체명}}'));
  await p.click('#mtSubject'); await p.keyboard.press('End'); await p.keyboard.type(' #EN');
  await p.click('[data-template-lang="zh"]'); await wait(100);
  check('중국어 양식 탭', (await p.$eval('#mtBody', e => e.value)).includes('您好'));
  await p.click('[data-template-lang="en"]'); await wait(100);
  check('탭 바꿔도 고치던 내용 유지', (await p.$eval('#mtSubject', e => e.value)).endsWith('#EN'));
  await p.click('#saveTemplate'); await wait(400);
  check('영어 양식 저장', (await toasts()).some(t => t.includes('English 메일 양식')));
  await p.$eval('#mtBody', e => { e.value = '품목 목록 없이'; });
  await p.click('#saveTemplate'); await wait(300);
  check('{{품목목록}} 없으면 저장 안 됨', (await toasts()).some(t => t.includes('{{품목목록}}')));
  await p.keyboard.press('Escape'); await wait(150);
  await p.click('#openMailTemplate'); await wait(150);
  await p.click('[data-template-lang="en"]'); await wait(100);
  check('다시 열면 저장된 영어 양식', (await p.$eval('#mtSubject', e => e.value)).endsWith('#EN') && (await p.$eval('#mtBody', e => e.value)).includes('{{품목목록}}'));
  await p.keyboard.press('Escape'); await wait(150);

  // 12. 새로고침
  await p.click('#refreshBtn'); await wait(600);
  check('새로고침 후 정상', await rows() > 0);

  // 같은 id 가 두 번 있으면 엉뚱한 칸이 동작한다 (지정 탭 보기 상자가 메인 라벨 필터와 겹쳤던 버그)
  for (const open of ['#openLabelManager', '#openVendorManager']) { await p.click(open); await wait(200); await p.keyboard.press('Escape'); await wait(100); }
  const dupIds = await p.evaluate(() => { const c = {}; document.querySelectorAll('[id]').forEach(e => { c[e.id] = (c[e.id] || 0) + 1; }); return Object.keys(c).filter(k => c[k] > 1); });
  check('중복 id 없음', dupIds.length === 0, dupIds.join(','));
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
  check("설명서 카드가 사용 가이드 맨 위", await p.$eval("#guideHowto", (e) => e.firstElementChild.classList.contains("manual-card") && e.firstElementChild.textContent.includes("자세한 사용 설명서")));
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

// 예전 버전 데이터(품목마다 업체명/이메일, 품목 하나짜리 메일 양식)가 새 형식으로 옮겨지는지
async function migrationFlow() {
  console.log("\n[예전 데이터 옮기기]");
  const server = await startSampleServer(3396, {
    seed: {
      "suppliers.json": {
        "2001": { supplierName: "글라스월드", supplierEmail: "Order@GlassWorld.co.kr", labelId: "x" },
        "2002": { supplierName: "글라스월드 (영업)", supplierEmail: "order@glassworld.co.kr" },
        "2003": { supplierName: "아크릴나라", supplierEmail: "" },
        "2004": { supplierName: "", supplierEmail: "", leadTimeDays: 4 },
        "2005": { leadTimeDays: 2 },
      },
      "mail-template.json": { subject: "[발주] {{품목명}}", body: "{{품목명}} {{수량}}개 부탁드려요" },
    },
  });
  try {
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
  } finally {
    await server.stop();
  }
}

(async () => {
  await migrationFlow();
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
