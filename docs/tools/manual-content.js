// 사용 설명서(Word) 내용. build-manual.js 가 화면 캡처 폴더를 넘겨 호출한다.
// 내용을 고치려면 아래 children 배열의 문단/표를 수정하세요.
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType, PageBreak, Footer, PageNumber, LevelFormat,
  TableOfContents,
} = require("docx");

let SHOTS; // build() 에서 지정
const FONT = "Malgun Gothic";
const INK = "18191B", MUTED = "6F737A", LINE = "E3E2DE";

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
function img(name, widthPx = 600) {
  const file = path.join(SHOTS, name);
  const { w, h } = pngSize(file);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    keepNext: true,
    spacing: { before: 120, after: 80 },
    children: [new ImageRun({ type: "png", data: fs.readFileSync(file), transformation: { width: widthPx, height: Math.round((h / w) * widthPx) } })],
  });
}
function caption(text) {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text, size: 17, color: MUTED })] });
}
// "**굵게**" 표기를 TextRun 으로 바꾼다
function runs(text, opts = {}) {
  return text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) =>
    part.startsWith("**") ? new TextRun({ text: part.slice(2, -2), bold: true, ...opts }) : new TextRun({ text: part, ...opts })
  );
}
const p = (text, opts = {}) => new Paragraph({ spacing: { after: 120, line: 320 }, children: runs(text), ...opts });
const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun(text)] });
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
const bullet = (text) => new Paragraph({ numbering: { reference: "bullets", level: 0 }, spacing: { after: 80, line: 300 }, children: runs(text) });
let stepList = 0;
function steps(items) {
  const ref = `steps${stepList++}`;
  numberingConfigs.push({ reference: ref, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 440, hanging: 300 } } } }] });
  return items.map((t) => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 100, line: 300 }, children: runs(t) }));
}
let numberingConfigs = [
  { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 440, hanging: 260 } } } }] },
];

const cellBorders = { top: { style: BorderStyle.SINGLE, size: 4, color: LINE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE }, left: { style: BorderStyle.SINGLE, size: 4, color: LINE }, right: { style: BorderStyle.SINGLE, size: 4, color: LINE } };
function table(header, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const mk = (cells, isHead, isLast) => new TableRow({
    tableHeader: isHead,
    cantSplit: true,
    children: cells.map((c, i) => new TableCell({
      width: { size: Math.round((widths[i] / total) * 9000), type: WidthType.DXA },
      borders: cellBorders,
      shading: isHead ? { type: ShadingType.CLEAR, fill: "F3F3F1", color: "auto" } : c.fill ? { type: ShadingType.CLEAR, fill: c.fill, color: "auto" } : undefined,
      margins: { top: 90, bottom: 90, left: 120, right: 120 },
      children: [new Paragraph({ keepNext: !isLast, children: runs(typeof c === "string" ? c : c.text, { bold: isHead || c.bold, size: 19, color: c.color }) })],
    })),
  });
  return new Table({ width: { size: 9000, type: WidthType.DXA }, rows: [mk(header, true, false), ...rows.map((r, i) => mk(r, false, i === rows.length - 1))] });
}
function callout(title, lines, fill = "EEF1FE", bar = "4F6CF5") {
  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [new TableRow({ children: [new TableCell({
      width: { size: 9000, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill, color: "auto" },
      borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, left: { style: BorderStyle.SINGLE, size: 24, color: bar } },
      margins: { top: 140, bottom: 140, left: 200, right: 200 },
      children: [
        new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: title, bold: true, size: 21 })] }),
        ...lines.map((l) => new Paragraph({ spacing: { after: 40, line: 300 }, children: runs(l, { size: 19 }) })),
      ],
    })] })],
  });
}
const gap = () => new Paragraph({ spacing: { after: 120 }, children: [] });

// ───────────────────────── 본문 ─────────────────────────
function build(shotsDir) {
SHOTS = shotsDir;
stepList = 0;
numberingConfigs = numberingConfigs.slice(0, 1);
const children = [
  // 표지
  new Paragraph({ spacing: { before: 2600 }, children: [new TextRun({ text: "ATELIER MALI", size: 22, color: "4F6CF5", bold: true, characterSpacing: 60 })] }),
  new Paragraph({ spacing: { before: 120 }, children: [new TextRun({ text: "아틀리에 말리", size: 60, bold: true })] }),
  new Paragraph({ spacing: { after: 400 }, children: [new TextRun({ text: "재고 · 발주 관리 프로그램 사용 설명서", size: 36, color: "3A3C40" })] }),
  p("네이버 스마트스토어의 판매 속도를 계산해서 **지금 발주해야 할 품목**과 **권장 발주 수량**을 알려주는 프로그램입니다."),
  gap(),
  table(["항목", "내용"], [
    ["문서 버전", "2026년 9월 28일"],
    ["대상", "매장 PC 사용자 (1~8장) · 관리자 (9장)"],
    ["실행 방법", "바탕화면 **'재고 발주 도우미'** 아이콘 더블클릭"],
  ], [1, 3]),
  new Paragraph({ children: [new PageBreak()] }),
  new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: "목차", size: 34, bold: true })] }),
  new TableOfContents("목차", { hyperlink: true, headingStyleRange: "1-2" }),

  // 1
  h1("1. 한눈에 보기"),
  p("평소에는 아래 다섯 가지만 기억하면 됩니다."),
  table(["언제", "무엇을"], [
    ["프로그램을 켤 때", "바탕화면 **'재고 발주 도우미'** 아이콘 더블클릭 (업데이트·실행이 자동)"],
    ["발주할 품목을 볼 때", "첫 화면의 **'발주 필요'** 목록 확인 → 빨간색일수록 급함"],
    ["발주 메일을 보낼 때", "**'발주서 만들기'** → 업체 선택 → 품목·수량 확인 → 복사해서 네이버 메일로"],
    ["메일을 보낸 뒤", "발주서 맨 아래 **'발주 완료로 기록'** → 물건이 오면 **'발주 기록'**에서 **입고**"],
    ["새 기능이 생겼을 때", "상단 파란 **'새 업데이트'** 버튼 → 바뀐 내용 확인"],
  ], [1, 2.4]),
  gap(),
  callout("이런 버튼은 이제 누를 필요가 없어요", [
    "예전의 '재고 발주 도우미 열기', '재고 발주 도우미 업데이트' 아이콘, 그리고 프로그램 폴더 안의 '업데이트.bat'은 쓰지 않아도 됩니다. 새 아이콘 하나가 모두 대신해요.",
  ]),

  // 2
  h1("2. 프로그램 켜기"),
  h2("2-1. 평소 실행"),
  ...steps([
    "바탕화면의 **'재고 발주 도우미'** 아이콘(모니터에 그래프 그림)을 더블클릭합니다.",
    "2~3초 기다리면 인터넷 창에 프로그램 화면이 열립니다. 검은 창은 뜨지 않아요.",
    "새 버전이 있을 때는 자동으로 받아서 적용하느라 10초 정도 걸릴 수 있어요.",
  ]),
  p("아이콘은 하루에 몇 번을 눌러도 괜찮습니다. 이미 켜져 있으면 화면만 다시 열어요."),
  h2("2-2. 처음 한 번만 (예전 버전이 설치된 PC)"),
  ...steps([
    "바탕화면의 **'재고 발주 도우미 업데이트'** 아이콘을 한 번 누릅니다.",
    "검은 창이 끝나고 '아무 키나 누르세요'가 나오면 창을 닫습니다.",
    "바탕화면에 새 **'재고 발주 도우미'** 아이콘이 생기고, 예전 아이콘 두 개는 사라집니다.",
  ]),
  h2("2-3. 컴퓨터를 켰을 때"),
  p("로그인하면 프로그램이 자동으로 켜집니다. 화면을 보려면 아이콘을 누르면 됩니다."),
  h2("2-4. 업데이트 내용 · 가이드 버튼"),
  p("프로그램이 새 버전으로 바뀌면 상단 버튼이 **파란색 '새 업데이트 NEW'**로 바뀌고, 첫 화면 위에 안내 띠가 나타납니다."),
  img("00-highlight.png"),
  caption("새 소식이 있을 때 — 파란 버튼과 안내 띠"),
  ...steps([
    "파란 **'새 업데이트'** 버튼이나 안내 띠의 **'무엇이 바뀌었는지 보기'**를 누릅니다.",
    "**업데이트 내용** 탭에서 새로 바뀐 점을 확인합니다. 새 항목에는 NEW 표시가 붙어요.",
    "한 번 열어보면 버튼이 다시 평범한 **'가이드'** 버튼으로 돌아갑니다.",
  ]),
  p("평소에도 **'가이드'** 버튼을 누르면 간단한 **사용 가이드**를 볼 수 있어요. 사용 가이드 맨 위의 **'설명서 내려받기'**를 누르면 이 설명서(Word)를 받을 수 있어요."),
  img("07-guide.png", 470),
  caption("업데이트 내용 · 가이드 창"),

  // 3
  h1("3. 첫 화면 보는 법"),
  img("01-main.png"),
  caption("첫 화면 — 오늘의 발주"),
  h2("3-1. 위쪽 요약 카드"),
  table(["카드", "뜻"], [
    [{ text: "지금 발주 필요", color: "D6453D", bold: true }, "입고까지 걸리는 기간(리드타임) 안에 재고가 바닥날 품목. **오늘 발주하세요.**"],
    [{ text: "곧 발주 필요", color: "B7791F", bold: true }, "아직 여유는 있지만 며칠 안에 발주가 필요해질 품목"],
    ["전체 품목", "스토어에 등록된 전체 품목 수"],
    ["라벨 미지정", "입고유형(국내/수입 등) 라벨이 없는 품목 수. 누르면 라벨 관리 창이 열려요."],
  ], [1, 3]),
  p("카드를 누르면 아래 목록이 그 항목으로 바뀝니다."),
  h2("3-2. 목록의 색깔"),
  table(["표시", "뜻"], [
    [{ text: "● 품절 / 재고 없음", color: "D6453D", bold: true }, "재고가 0개"],
    [{ text: "● ○일 남음 (빨강)", color: "D6453D", bold: true }, "지금 발주해야 함"],
    [{ text: "● ○일 남음 (주황)", color: "B7791F", bold: true }, "곧 발주해야 함"],
    [{ text: "● ○일 남음 (초록)", color: "2F855A", bold: true }, "재고 넉넉함"],
    [{ text: "● 판매 없음 (회색)", color: "6F737A", bold: true }, "최근 판매 기록이 없어 계산할 수 없음"],
  ], [1.3, 2.7]),
  gap(),
  p("**권장 발주**는 리드타임과 안전 여유일수 동안 팔릴 양에서 현재 재고를 뺀 수량입니다. '–'는 지금 발주하지 않아도 된다는 뜻이에요."),
  h2("3-3. 탭 · 검색 · 라벨 필터"),
  bullet("**발주 필요 / 곧 필요 / 전체** 탭으로 목록을 바꿉니다. 급한 품목이 항상 위에 옵니다."),
  bullet("**품목 검색** 칸에 이름 일부를 입력하면 바로 걸러집니다."),
  bullet("**모든 라벨** 상자에서 '국내', '중국수입', '라벨 없음' 등을 골라 해당 품목만 볼 수 있어요."),
  img("02-search.png"),
  caption("'썬캐쳐'로 검색한 모습"),
  h2("3-4. 새로고침"),
  p("오른쪽 위 **새로고침**을 누르면 네이버에서 최신 재고·주문을 다시 받아옵니다. 받아오는 동안 '불러오는 중' 표시가 나와요."),

  // 4
  h1("4. 발주서 만들기 (업체별 발주 메일)"),
  p("업체를 고르면 **그 업체의 품목만** 나오고, 보낼 품목과 수량을 골라 **메일 한 통**으로 만듭니다. 처음 한 번은 5장처럼 업체를 등록하고 품목을 연결해 두세요."),
  h2("4-1. 품목과 수량 고르기"),
  img("08-order.png", 540),
  caption("업체를 고르면 그 업체 품목이 나와요 (발주 필요 품목은 미리 체크)"),
  ...steps([
    "첫 화면 오른쪽 위 **'발주서 만들기'**를 누릅니다.",
    "**업체 카드**를 누릅니다. 카드에 그 업체의 '발주 필요' 품목 수가 보여요.",
    "그 업체 품목이 나오고, **발주가 필요한 품목은 미리 체크**돼 있어요. 수량은 권장 발주 수량으로 채워져 있고, 칸을 눌러 고칠 수 있어요.",
    "보내지 않을 품목은 체크를 풀고, 다른 품목을 넣고 싶으면 아래 **'다른 품목 추가'** 칸에서 이름을 검색해 누릅니다.",
    "아래 '선택 ○개 품목 · 총 ○개'를 확인하고 **'메일 내용 만들기'**를 누릅니다.",
  ]),
  h2("4-2. 네이버 메일로 보내기"),
  img("09-mail.png", 540),
  caption("받는 사람 · 제목 · 본문을 각각 복사해서 붙여넣어요"),
  ...steps([
    "**'네이버 메일 열기'**를 눌러 새 창에서 메일 쓰기를 엽니다.",
    "**받는 사람** 옆 **복사** → 네이버 메일의 받는 사람 칸에 붙여넣기 (**Ctrl + V**)",
    "**제목**, **본문**도 같은 방법으로 복사해서 붙여넣습니다. 누르면 버튼이 초록색 '복사됨 ✓'으로 바뀌어요.",
    "내용을 확인하고 네이버 메일에서 **보내기**를 누릅니다.",
  ]),
  bullet("제목·본문은 붙여넣기 전에 이 화면에서 바로 고쳐도 돼요. 고친 내용 그대로 복사됩니다."),
  bullet("**'← 품목 다시 고르기'**를 누르면 고른 품목과 수량이 그대로 남아 있어요."),
  bullet("PC에 Outlook 같은 메일 프로그램을 쓴다면 **'PC 메일 프로그램으로 열기'**로 내용이 채워진 채 열 수 있어요."),
  h2("4-3. 해외 업체 (영어 · 중국어 발주서)"),
  p("업체마다 **발주서 언어**를 정해두면 그 나라 말로 된 발주서가 만들어져요. 메일 화면 제목 옆에 언어(English / 中文)가 표시됩니다."),
  table(["언어", "발주서 예시 (품목 한 줄)", "보내는 사람"], [
    ["한국어", "1. 썬캐쳐 아크릴판 M — 5개", "아틀리에 말리"],
    ["English", "1. Sun catcher acrylic M — 5 pcs", "Atelier Mali"],
    ["中文", "1. 亚克力板 M — 5 件", "Atelier Mali"],
  ], [0.8, 2.4, 1.1]),
  gap(),
  ...steps([
    "**업체 관리**에서 그 업체 줄의 언어 상자를 **English** 또는 **中文**으로 바꾸고 **저장**합니다.",
    "품목 상세의 **업체용 품명** 칸에 업체가 알아보는 이름(영어·중국어 이름이나 모델번호)을 적고 저장합니다. 비워두면 한국어 품명이 들어가요.",
    "평소처럼 **발주서 만들기**를 하면 그 언어의 양식으로 메일이 만들어져요.",
  ]),
  callout("업체용 품명은 한 번만 적어두면 돼요", ["프로그램이 품명을 자동으로 번역하지는 않아요. 업체가 알아보는 이름을 한 번 적어두면 다음 발주부터 계속 그 이름으로 나가요."]),

  h2("4-4. 발주 기록 · 입고 대기"),
  p("메일을 보낸 뒤 기록해 두면, 발주한 품목이 '입고 대기'로 표시되고 **같은 품목을 또 발주하지 않게** 알려줘요."),
  img("12-record.png", 540),
  caption("메일 화면 맨 아래 — '발주 완료로 기록'을 누른 모습"),
  ...steps([
    "네이버 메일로 발주 메일을 보냈으면, 발주서 맨 아래 **'발주 완료로 기록'**을 누릅니다.",
    "기록한 품목에는 첫 화면에서 **'발주함 5개 · 10/5 예정'** 표시가 붙고, **'입고 대기'** 탭에 모여요. 입고 예정일은 발주한 날 + 그 품목의 리드타임이에요.",
    "발주한 수량은 들어올 재고로 계산해서, 충분히 발주한 품목은 **'발주 필요'에서 빠져요.** 모자라게 발주했으면 남은 수량만 권장해요.",
  ]),
  img("13-pending.png"),
  caption("첫 화면 '입고 대기' 탭 — 파란 '발주함' 표시 (예정일이 지나면 주황색 '입고 지연')"),
  h2("4-5. 입고 처리"),
  img("14-orders.png", 540),
  caption("첫 화면 '발주 기록' 버튼으로 여는 창"),
  ...steps([
    "첫 화면 오른쪽 위 **'발주 기록'**을 누릅니다. 버튼 옆 숫자는 입고를 기다리는 품목 수예요.",
    "물건이 들어온 품목의 **'입고'**를 누릅니다. 한 번에 다 들어왔으면 **'모두 입고 완료'**를 누르세요.",
    "**네이버 스마트스토어의 재고 수량도 올려주세요.** 프로그램은 네이버 재고를 읽기만 하고 바꾸지 않아요.",
  ]),
  bullet("잘못 눌렀으면 **'되돌리기'**, 잘못 기록한 발주는 **'발주 취소'**(두 번 눌러야 취소)로 바로잡을 수 있어요."),
  bullet("**'전체 기록'** 탭에서 지난 발주 이력을 볼 수 있고, 업체가 여러 곳이면 업체별로 골라 볼 수 있어요."),

  // 5
  h1("5. 거래 업체 관리"),
  p("상단 **'업체 관리'**에서 발주를 보내는 업체와 이메일을 등록하고, 품목을 업체에 연결합니다. 업체가 없는 품목이 있으면 버튼 옆에 빨간 숫자가 보여요."),
  p("창은 **'업체 목록'**과 **'품목 연결'** 두 탭으로 나뉘어 있어요. 연결 안 된 품목이 있으면 '품목 연결' 탭부터 열립니다."),
  h2("5-1. 업체 목록 탭: 등록 · 수정 · 삭제"),
  img("11-vendor-list.png", 540),
  caption("업체 목록 탭 — 맨 위 칸에서 추가, 아래에서 수정·삭제"),
  ...steps([
    "맨 위 점선 줄에 업체 이름과 이메일을 넣고, 해외 업체면 언어(English / 中文)를 골라 **업체 추가**(또는 Enter)를 누릅니다. 이메일은 나중에 넣어도 돼요.",
    "이름 · 이메일 · 발주서 언어를 고치려면 그 줄에서 고치고 **저장**을 누릅니다. 줄마다 연결된 품목 수가 보여요.",
    "**삭제**는 두 번 눌러야 지워지고, 연결돼 있던 품목은 '업체 없음'으로 돌아가요.",
  ]),
  bullet("업체가 6개 이상이 되면 목록 위에 **업체 검색** 칸이 생겨요."),
  h2("5-2. 품목 연결 탭: 여러 품목을 한 번에 연결"),
  img("10-vendors.png", 540),
  caption("품목 연결 탭 — 품목을 골라 업체를 정하고 '연결'"),
  ...steps([
    "품목을 눌러 체크합니다. **품목 검색** 후 **전체 선택**하면 편해요.",
    "아래 줄 **'선택한 품목을'** 옆 상자에서 업체를 고르고 **'선택한 ○개 연결'**을 누릅니다.",
  ]),
  bullet("왼쪽 위 상자를 **'전체 품목'**으로 바꾸면 이미 연결된 품목도 보여요(오른쪽에 지금 업체 표시). 골라서 다른 업체로 한 번에 바꿀 수 있어요."),
  bullet("업체 상자 맨 아래 **'(업체 해제)'**를 고르면 선택한 품목의 업체 연결을 한 번에 풀 수 있어요."),
  h2("5-3. 품목 하나의 업체 · 라벨 바꾸기"),
  img("03-detail.png", 470),
  caption("목록에서 품목을 누르면 열리는 상세 창"),
  bullet("**거래 업체**, **입고유형 라벨**을 고르고 **저장**을 누릅니다."),
  bullet("**업체용 품명**에 업체가 알아보는 이름이나 모델번호를 적으면 발주서에 그 이름이 들어가요. (해외 업체에 특히 유용)"),
  bullet("**이 품목만의 리드타임**을 넣으면 라벨보다 우선합니다. 비우고 저장하면 다시 라벨의 리드타임을 써요."),
  bullet("**'이 업체에 발주서 만들기'**를 누르면 그 업체와 이 품목이 선택된 채로 발주서가 열려요."),

  // 6
  h1("6. 입고유형 라벨 관리"),
  p("국내 배송, 중국 수입처럼 **입고까지 걸리는 기간(리드타임)이 다른 품목을 라벨로 묶는** 기능입니다. 라벨의 리드타임으로 언제 발주해야 하는지 계산해요."),
  p("상단의 **라벨 관리** 버튼(또는 '라벨 미지정' 카드)으로 엽니다. 라벨이 없는 품목이 있으면 프로그램을 켤 때 자동으로 열립니다."),
  p("업체 관리와 같이 **'라벨 목록'**과 **'품목에 지정'** 두 탭으로 나뉘어 있어요."),
  h2("6-1. 라벨 목록 탭: 만들기 · 수정 · 삭제"),
  ...steps([
    "맨 위 점선 줄에 라벨 이름(예: 중국수입)과 리드타임(예: 20)을 입력하고 **라벨 추가**(또는 Enter)를 누릅니다.",
    "이름이나 리드타임을 고치려면 그 줄에서 고치고 **저장**을 누릅니다.",
    "**삭제**는 실수 방지를 위해 **두 번** 눌러야 지워집니다. 지운 라벨이 붙어 있던 품목은 '라벨 없음'으로 돌아가요.",
  ]),
  h2("6-2. 품목에 지정 탭: 여러 품목에 한 번에 지정"),
  img("04-labels.png", 540),
  caption("품목에 지정 탭 — 품목 2개를 골라 '국내'로 지정하려는 모습"),
  ...steps([
    "품목을 눌러 체크합니다. **품목 검색**으로 '스테인드글라스'처럼 비슷한 품목만 걸러낸 뒤 **전체 선택**하면 편해요.",
    "아래 줄 **'선택한 품목을'** 옆 상자에서 라벨을 고르고 **'선택한 ○개 지정'**을 누릅니다.",
  ]),
  bullet("**'전체 품목'**으로 바꾸면 이미 지정된 품목도 한꺼번에 다른 라벨로 바꾸거나, **'(라벨 해제)'**로 풀 수 있어요."),

  // 7
  h1("7. 판단 기준 · 메일 양식"),
  h2("7-1. 판단 기준"),
  img("05-settings.png", 340),
  caption("상단 '판단 기준' 버튼"),
  table(["항목", "뜻", "기본값"], [
    ["판매 속도 계산 기간", "최근 며칠간의 판매량으로 하루 평균 판매량을 계산할지", "14일"],
    ["안전 여유일수", "권장 발주 수량을 정할 때 리드타임에 더해 확보할 여유", "3일"],
  ], [1.3, 2.7, 0.8]),
  gap(),
  p("값을 바꾸고 **적용**을 눌러야 반영됩니다. 적용하지 않고 닫으면 바뀌지 않아요."),
  h2("7-2. 발주 메일 양식"),
  img("06-mail.png", 400),
  caption("상단 '메일 양식' 버튼"),
  p("발주서 메일의 기본 문구입니다. 위쪽 **언어 탭(한국어 · English · 中文)**마다 따로 저장되고, 업체의 언어에 맞는 양식이 쓰여요. 탭을 바꿔도 고치던 내용은 남아 있고, **양식 저장**은 지금 보고 있는 언어만 저장해요."),
  table(["넣는 칸", "메일에서 바뀌는 내용"], [
    ["{{업체명}}", "받는 업체 이름"],
    ["{{품목목록}}", "고른 품목과 수량 (한 줄에 하나씩: '1. 품목명 — 5개')"],
    ["{{품목수}} / {{총수량}}", "품목 개수 / 수량 합계"],
    ["{{날짜}}", "오늘 날짜"],
    ["{{보내는사람}}", "보내는 사람 이름 (기본: 한국어 '아틀리에 말리', 영어·중국어 'Atelier Mali')"],
  ], [1.3, 2.7]),
  gap(),
  bullet("위쪽 버튼을 누르면 커서 위치에 들어가요. 수정 후 **양식 저장**을 누르면 다음 발주서부터 적용됩니다."),
  bullet("**{{품목목록}}**은 꼭 남겨 두세요. 이 자리에 품목과 수량이 들어가요."),

  // 8
  h1("8. 문제가 생겼을 때"),
  table(["증상", "해결 방법"], [
    ["'프로그램 서버에 연결할 수 없어요'", "바탕화면 **'재고 발주 도우미'** 아이콘을 다시 누르세요. 프로그램이 다시 켜집니다."],
    ["'품목을 불러오지 못했어요'", "잠시 후 **새로고침**을 누르세요. 계속되면 관리자에게 화면을 캡처해 보내주세요. (네이버 연결 문제)"],
    ["'프로그램을 켜지 못했어요' 안내창", "프로그램 폴더의 **data** 폴더 안 **server-log.txt**, **launcher-log.txt** 두 파일을 관리자에게 보내주세요."],
    ["모든 품목이 '판매 없음'", "**판단 기준**의 판매 속도 계산 기간이 1 이상인지 확인하고 적용을 누르세요."],
    ["발주서에 업체 품목이 안 나옴", "**업체 관리**에서 그 품목을 업체에 연결했는지 확인하세요. 급하면 발주서의 '다른 품목 추가'로 넣을 수 있어요."],
    ["받는 사람이 비어 있음", "**업체 관리**에서 그 업체의 이메일을 넣고 저장하세요."],
    ["붙여넣기가 안 됨", "**복사** 버튼이 '복사됨 ✓'으로 바뀌었는지 확인하고, 네이버 메일 칸을 누른 뒤 **Ctrl + V**를 누르세요."],
    ["화면이 이상하게 보임", "인터넷 창에서 **Ctrl + F5**를 누르거나 아이콘을 다시 누르세요."],
  ], [1.4, 2.6]),
  gap(),
  callout("팝업 창 닫기", ["오른쪽 위 ×, 창 바깥 어두운 곳 클릭, 또는 키보드 **Esc** 키로 닫을 수 있어요."]),

  // 9
  h1("9. 관리자용 안내"),
  h2("9-1. 업데이트 배포"),
  bullet("GitHub 저장소 **tms01274/naver-reorder-app** 의 main 브랜치에 push하면 됩니다."),
  bullet("매장 PC는 아이콘을 누를 때마다 자동으로 받아 적용합니다. 따로 연락할 필요가 없어요."),
  bullet("저장소는 **공개(Public)** 상태여서 토큰이 필요 없습니다. 비공개로 바꾸면 매장 PC의 자동 업데이트가 멈추니 주의하세요."),
  bullet("비밀번호·API 키는 각 PC의 **.env** 파일에만 두고 절대 저장소에 올리지 마세요. (.env는 자동으로 제외됩니다)"),
  bullet(".env 를 고친 뒤 바탕화면 아이콘을 누르면 바뀐 것을 알아채고 자동으로 재시작해서 반영합니다."),
  bullet("사용자에게 보이는 변경을 올릴 때는 **src/changelog.js** 맨 위에 항목을 추가하세요. 매장 PC의 가이드 버튼이 파랗게 강조됩니다."),
  bullet("이 설명서는 **docs/tools** 폴더에서 **npm install** 후 **node build-manual.js**로 다시 만들 수 있어요. (화면 캡처 자동)"),
  h2("9-2. 새 PC에 설치"),
  ...steps([
    "PowerShell에서 Git 설치: **winget install --id Git.Git -e** (끝나면 PowerShell을 닫고 새로 열기)",
    "코드 받기: **git clone https://github.com/tms01274/naver-reorder-app.git C:\\naver-reorder-app** (토큰 필요 없음)",
    "C:\\naver-reorder-app 폴더의 **설치하기.bat** 더블클릭 (Node.js가 없으면 안내에 따라 설치 후 다시 실행)",
    "**.env** 파일에 네이버 API 키를 넣고 MOCK_MODE=false 로 변경",
    "바탕화면 **'재고 발주 도우미'** 아이콘으로 실행",
  ]),
  h2("9-3. 네이버 커머스API"),
  bullet("네이버 커머스API센터에 **호출을 허용할 PC의 공인 IP**가 등록돼 있어야 합니다. 등록되지 않은 PC에서는 '허용되지 않은 IP' 오류가 납니다."),
  bullet("인터넷 회선을 바꾸면 IP가 바뀔 수 있으니 다시 등록해야 합니다."),
  h2("9-4. 파일 위치"),
  table(["파일", "내용"], [
    ["data\\vendors.json", "거래 업체 (이름·이메일·발주서 언어)"],
    ["data\\suppliers.json", "품목별 연결 업체·업체용 품명·라벨·리드타임"],
    ["data\\mail-template.json", "언어별 발주 메일 양식"],
    ["data\\inboundLabels.json", "입고유형 라벨"],
    ["data\\settings.json", "판단 기준"],
    ["data\\ui-state.json", "마지막으로 확인한 업데이트 내용"],
    ["data\\server-log.txt / launcher-log.txt", "문제 확인용 기록"],
  ], [1.6, 2.4]),
  p("data 폴더와 .env 파일은 업데이트해도 바뀌지 않습니다. PC를 옮길 때는 이 두 가지를 복사하면 설정이 그대로 옮겨집니다."),
];

const doc = new Document({
  creator: "아틀리에 말리",
  title: "아틀리에 말리 재고·발주 관리 사용 설명서",
  numbering: { config: numberingConfigs },
  styles: {
    default: { document: { run: { font: FONT, size: 20, color: INK } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 34, bold: true, color: INK }, paragraph: { keepNext: true, keepLines: true, spacing: { before: 120, after: 240 } } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 25, bold: true, color: "3A3C40" }, paragraph: { keepNext: true, keepLines: true, spacing: { before: 320, after: 120 } } },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1300, bottom: 1300, left: 1400, right: 1400 } } },
    footers: {
      default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: "아틀리에 말리 · 재고 발주 관리   ", size: 16, color: MUTED }),
        new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED }),
      ] })] }),
    },
    children,
  }],
});

return doc;
}

module.exports = { build, Packer };
