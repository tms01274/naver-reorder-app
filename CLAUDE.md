# 아틀리에 말리 재고·발주 관리 (naver-reorder-app)

이 파일은 Claude Code 가 어느 PC 에서든 이 프로젝트를 이어서 작업할 수 있도록 맥락을 정리한 것이다.
작업 중 새로 정해진 사항이나 주의점이 생기면 이 파일도 함께 갱신하고 커밋한다.

## 한눈에

- 네이버 스마트스토어(글라스아트/스테인드글라스 재료 판매) 판매 속도로 **발주 필요 품목·권장 수량**을 알려주는 로컬 웹앱.
- 브랜드명: **아틀리에 말리** (화면 제목/헤더에 사용). 바탕화면 아이콘 이름은 알아보기 쉽게 "재고 발주 도우미" 유지.
- 사용자: 매장 PC 를 쓰는 **비개발자**(버튼이 많으면 어려워함). 관리자(저장소 주인)는 원격으로 GitHub push 만으로 배포.
- 사용자와의 대화·화면 문구는 **한국어**, 화면 문구는 쉬운 해요체.
- **모니터링 우선** (관리자 지시): 사용자가 버튼을 눌러 관리하게 하기보다, 네이버 데이터를 보고 프로그램이 알아서 따라가게 만든다. 사람은 잘못된 것만 고치게(되돌리기). 예: 발주 뒤 스마트스토어 재고가 늘면 자동 입고 처리.

## 구조

| 경로 | 내용 |
|---|---|
| `server.js` | Express 서버. `/api/products`(네이버 상품+주문 → 발주 계산, 3분 캐시, `?fresh=1` 로 캐시 무시), `/api/suppliers/:id`(품목의 vendorId·labelId·리드타임), `/api/labels`·`/api/vendors`(+`/assign` 일괄 지정), `/api/mail-template`, `/api/whats-new`(+`/seen`), `/docs` 정적 제공 |
| `src/orders.js` | 발주 기록(`data/orders.json`). 입고 안 된 수량은 `/api/products` 에서 들어올 재고로 더해 발주 필요·권장 수량을 다시 계산(`applyPendingOrder`). 발주할 때 네이버 재고(`stockAtOrder`)를 남겨 두고, 팔린 수량을 빼고도 재고가 발주 수량의 절반 이상 늘면 **자동 입고**(`autoReceiveArrived`, 되돌리면 `noAuto`). 사람이 입고를 눌렀는데 재고가 안 늘면 알림(`receivedButStockNotRaised`) |
| `src/orderDrafts.js` | 메일을 복사했는데 '발주 완료로 처리'를 안 한 발주서(`data/order-drafts.json`, 업체별). 첫 화면 '오늘 할 일'에 알림, 처리하면 지워짐 |
| `src/vendors.js` | 거래 업체(이름·이메일). 서버 시작 시 예전 품목별 업체명/이메일을 업체 목록으로 옮김 |
| 발주 흐름 | 화면의 "발주서 만들기": 업체 선택 → 그 업체 품목(발주 필요는 미리 체크)·수량 수정 → 메일 한 통 분량 생성 → 받는 사람·제목·본문 각각 복사해 **네이버 웹메일**에 붙여넣기 (매장은 웹메일 사용, 앱이 직접 발송하지 않음). 메일 양식은 `{{품목목록}}` 필수 |
| 해외 업체 | 업체마다 발주서 언어(`lang`: ko/en/zh). 메일 양식은 언어별(`src/mailTemplate.js` 의 `DEFAULT_TEMPLATES`, 자리표시자는 언어 상관없이 한글 키). 품목별 `vendorItemName`(업체용 품명)이 있으면 발주서에 그 이름 사용 — 자동 번역은 하지 않음. 보내는 사람: `SENDER_NAME`(ko) / `SENDER_NAME_EN`(en·zh) |
| `src/naverClient.js` | 네이버 커머스API (주문 조회는 24시간 단위로 나눠 호출) |
| `src/mockData.js` | `MOCK_MODE=true` 일 때 샘플 데이터 |
| `src/reorderLogic.js` | 판매 속도·남은 일수·권장 수량 계산 |
| `src/changelog.js` | 앱 안 "업데이트 내용" 기록 (최신이 맨 위) |
| `src/suppliers.js`, `inboundLabels.js`, `settings.js`, `mailTemplate.js`, `uiState.js` | `data/*.json` 읽기/쓰기 |
| `public/` | 화면 (index.html / style.css / app.js, 빌드 없음) |
| `windows-autostart/launch.ps1` | 바탕화면 아이콘이 실행: git 업데이트 → 서버 켜기/재시작 → 브라우저 열기 |
| `windows-autostart/create-shortcut.ps1` | 바탕화면 아이콘 1개 생성, 예전 아이콘 삭제 (서버 시작 시 자동 실행) |
| `docs/아틀리에말리-사용설명서.docx` | 사용 설명서 (앱의 가이드 창에서 내려받기) |
| `docs/tools/` | 설명서 생성(`build-manual.js`)·화면 테스트(`e2e-test.js`) 도구. 별도 `npm install` 필요 |
| `data/` (git 제외) | PC 별 저장 데이터. `.env` (git 제외) 에 네이버 API 키 |

## 작업 중에는 (관리자 지시: 속도 우선)

- 기능을 고치는 동안에는 **전체 화면 테스트(e2e) · 업데이트 기록 · 설명서 재생성을 하지 않는다.** 건마다 하면 너무 오래 걸린다.
- 작업 중 확인은 가볍게: 문법 검사(`node --check`), 필요하면 바뀐 부분만 빠르게 확인하고, 미리보기 창을 띄워 관리자가 직접 보게 한다.
- 아래 "커밋 요청을 받으면" 단계에서 그동안의 변경을 **한꺼번에** 테스트하고 정리한다.

## 커밋 요청을 받으면 (관리자 지시, 항상 이 순서)

1. **먼저 GitHub 최신 내용 확인**: `git fetch origin` → `git log HEAD..origin/main` 으로 다른 PC 에서 올린 커밋이 있는지 본다.
   있으면 작업 내용을 보존한 채 받아서 합친다 (`git stash` → `git merge --ff-only origin/main` 또는 `git pull --rebase` → `git stash pop`, 충돌은 양쪽 변경을 모두 살려서 해결). 받은 내용을 사용자에게 한 줄로 알린다.
2. **지난 push 이후 추가·수정된 기능의 테스트 묶음만** 돌린다 (관리자 지시: 전체 테스트는 오래 걸림). `cd docs/tools && node e2e-test.js <묶음...>` — 묶음 목록은 `node e2e-test.js --list`.
   - 새 기능/바뀐 동작은 해당 묶음에 검사를 추가·수정한 뒤 그 묶음을 돌린다. 한 번 통과하면 된다 (여러 번 반복하지 않음).
   - 어느 묶음인지: 라벨 관리 → `labels`, 첫 화면 목록·통계 → `main`, 업체 관리 → `vendors`, 발주서 → `order`, 발주 기록·입고 대기 → `records`, 품목 상세 → `detail`, 해외 업체·언어 → `overseas`, 판단 기준 → `settings`, 메일 양식 → `template`, 가이드·업데이트 기록 → `whatsnew`, 데이터 형식·옮기기 → `migration`, 오늘 할 일 카드·표/사진 보기 → `today`, 네이버 응답 해석(`src/naverClient.js`) → `naver`, 첫 화면 발주 완료 처리·자동 입고·깜빡 알림(`src/orders.js`, `src/orderDrafts.js`) → `monitor`, 공통 화면(팝업 구조, CSS, id) → `layout`.
   - 여러 화면이 함께 쓰는 코드(`fetchJson`, `render`, 공통 팝업, `server.js` 의 `/api/products` 등)를 고쳤을 때만 전체(`node e2e-test.js`)를 돌린다.
3. **지난 push 이후 바뀐 프로그램 내용을 한꺼번에 `src/changelog.js` 맨 위에 정리**한다. 관리자가 따로 말하지 않아도 매번 한다.
   - 매장 PC 사용자(비개발자)가 읽는 글: 쉬운 해요체, 무엇이 달라졌고 어떻게 쓰는지 위주. 내부 구조·파일명·버그 원인 같은 개발 용어는 쓰지 않는다.
   - id 는 날짜 기반으로 겹치지 않게 (같은 날 두 번째면 `2026-10-05-2`). 같은 날 아직 push 하지 않은 항목이 있으면 새로 만들지 말고 그 항목에 합친다.
   - 사용자에게 보이는 변화가 전혀 없는 커밋(문서·개발 도구만 등)은 항목을 추가하지 않는다.
   - 항목이 추가되면 매장 PC 의 가이드 버튼이 파랗게 강조되고, 사용자가 열어보면 원래대로 돌아간다.
4. **설명서에 나오는 화면·사용법이 바뀌었을 때만** `node build-manual.js` 로 설명서 재생성 (`manual-content.js` 에서 문구 수정). 설명서와 상관없는 수정이면 건너뛴다.
5. 커밋하고 **바로 push 까지 한다** (관리자 지시: 커밋 요청 = 커밋 + push). 매장 PC 는 아이콘을 누를 때 자동으로 받아 적용

## 꼭 지켜야 할 것 (과거에 문제가 됐던 부분)

- **저장소는 공개(Public)** 이다. 매장 PC 가 토큰 없이 업데이트를 받기 위해서다. 비밀값·개인정보를 커밋하지 말 것. 비공개로 바꾸면 매장 PC 자동 업데이트가 멈춘다.
- **매장 PC 에서 사람이 해야 하는 작업이 필요한 해결책은 피한다.** push 만으로 적용되게 만든다.
- `.ps1` 파일은 **UTF-8 BOM** 으로 저장 (Windows PowerShell 5.1 이 한글을 깨뜨리지 않도록).
- 실행 중인 `.bat` 은 git 이 파일을 바꾸면 도중부터 새 내용을 읽어 오작동할 수 있다. `업데이트.bat`, `windows-autostart/start-server.bat` 은 가급적 수정하지 않는다. (`launch.ps1` 은 PowerShell 이 전체를 먼저 읽으므로 안전)
- CSS 에서 `display` 를 준 요소도 `hidden` 속성이면 숨겨지도록 `[hidden] { display: none !important; }` 를 유지 (팝업이 처음부터 떠 있던 버그가 두 번 있었음).
- 모든 API 호출은 `fetchJson` 으로: 실패해도 화면이 멈추지 않고 안내를 띄운다. 품목을 못 불러와도 라벨 관리는 동작해야 한다.
- 판단 기준(판매 속도 계산 기간)은 1 이상만 저장·사용. 예전 버그로 0 이 저장된 PC 가 있었다.
- 네이버 커머스API 는 **허용된 공인 IP** 에서만 호출된다. 개발 PC 에서는 `GW.IP_NOT_ALLOWED` 로 실패하는 게 정상일 수 있으니 `MOCK_MODE=true` 또는 테스트 도구의 샘플 데이터로 확인한다.

## 첫 화면 리디자인 (2026-09-29 완료)

시안 A(오늘 할 일)와 C(사진과 그래프)를 합쳤다: 맨 위 "오늘 할 일" 카드 + 목록의 [표 | 사진] 전환(선택은 `/api/ui-state` 에 저장).
- 네이버 응답 형태 (개발 PC 58.227.158.117 도 네이버에 IP 등록됨, 실제 데이터로 확인 가능):
  - 상품 사진: `channelProducts[0].representativeImage.url` (원본이 수 MB 라 목록에서는 `?type=m510` 을 붙여 작게 받는다)
  - 주문: `data.contents[].content.{order, productOrder, delivery}` — 예전엔 이 경로를 잘못 읽어 판매량이 전부 0 이었다 (9/29 수정)
- 하루에 주문이 몰린 품목은 "대량 주문 포함" 표시(`spikeInfo`), 품절인데 판매 기록이 없으면 권장 수량 대신 "직접 정하기".

## 현재 상태 / 남은 일 (2026-09-29 기준)

- 매장 PC 는 예전 방식(아이콘 2개, 주소에 토큰 포함)으로 설치돼 있다. 한 번 "업데이트" 아이콘을 누르면 새 원클릭 아이콘으로 바뀌고, 이후 `launch.ps1` 이 git 주소의 토큰도 지운다.
- 매장 PC 의 안전 여유일수가 0 으로 저장돼 있었다 (원래 값 3 으로 다시 적용 필요).
- 라벨이 없는 품목이 99개 정도 있다 → 라벨 관리의 일괄 지정으로 처리.
