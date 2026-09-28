# 아틀리에 말리 재고·발주 관리 (naver-reorder-app)

이 파일은 Claude Code 가 어느 PC 에서든 이 프로젝트를 이어서 작업할 수 있도록 맥락을 정리한 것이다.
작업 중 새로 정해진 사항이나 주의점이 생기면 이 파일도 함께 갱신하고 커밋한다.

## 한눈에

- 네이버 스마트스토어(글라스아트/스테인드글라스 재료 판매) 판매 속도로 **발주 필요 품목·권장 수량**을 알려주는 로컬 웹앱.
- 브랜드명: **아틀리에 말리** (화면 제목/헤더에 사용). 바탕화면 아이콘 이름은 알아보기 쉽게 "재고 발주 도우미" 유지.
- 사용자: 매장 PC 를 쓰는 **비개발자**(버튼이 많으면 어려워함). 관리자(저장소 주인)는 원격으로 GitHub push 만으로 배포.
- 사용자와의 대화·화면 문구는 **한국어**, 화면 문구는 쉬운 해요체.

## 구조

| 경로 | 내용 |
|---|---|
| `server.js` | Express 서버. `/api/products`(네이버 상품+주문 → 발주 계산, 3분 캐시, `?fresh=1` 로 캐시 무시), `/api/suppliers/:id`, `/api/labels`(+`/assign` 일괄 지정), `/api/mail-template`, `/api/whats-new`(+`/seen`), `/docs` 정적 제공 |
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

## 배포 흐름

1. 코드 수정 → `cd docs/tools && node e2e-test.js` 로 **모두 통과** 확인
2. 사용자에게 보이는 변경이면 **`src/changelog.js` 맨 위에 항목 추가** (id 는 날짜 기반, 겹치지 않게). 매장 PC 의 가이드 버튼이 파랗게 강조되고, 열어보면 원래대로 돌아간다.
3. 화면이 바뀌었으면 `node build-manual.js` 로 설명서 재생성 (`manual-content.js` 에서 문구 수정)
4. main 에 커밋 · push → 매장 PC 는 아이콘을 누를 때 자동으로 받아 적용

## 꼭 지켜야 할 것 (과거에 문제가 됐던 부분)

- **저장소는 공개(Public)** 이다. 매장 PC 가 토큰 없이 업데이트를 받기 위해서다. 비밀값·개인정보를 커밋하지 말 것. 비공개로 바꾸면 매장 PC 자동 업데이트가 멈춘다.
- **매장 PC 에서 사람이 해야 하는 작업이 필요한 해결책은 피한다.** push 만으로 적용되게 만든다.
- `.ps1` 파일은 **UTF-8 BOM** 으로 저장 (Windows PowerShell 5.1 이 한글을 깨뜨리지 않도록).
- 실행 중인 `.bat` 은 git 이 파일을 바꾸면 도중부터 새 내용을 읽어 오작동할 수 있다. `업데이트.bat`, `windows-autostart/start-server.bat` 은 가급적 수정하지 않는다. (`launch.ps1` 은 PowerShell 이 전체를 먼저 읽으므로 안전)
- CSS 에서 `display` 를 준 요소도 `hidden` 속성이면 숨겨지도록 `[hidden] { display: none !important; }` 를 유지 (팝업이 처음부터 떠 있던 버그가 두 번 있었음).
- 모든 API 호출은 `fetchJson` 으로: 실패해도 화면이 멈추지 않고 안내를 띄운다. 품목을 못 불러와도 라벨 관리는 동작해야 한다.
- 판단 기준(판매 속도 계산 기간)은 1 이상만 저장·사용. 예전 버그로 0 이 저장된 PC 가 있었다.
- 네이버 커머스API 는 **허용된 공인 IP** 에서만 호출된다. 개발 PC 에서는 `GW.IP_NOT_ALLOWED` 로 실패하는 게 정상일 수 있으니 `MOCK_MODE=true` 또는 테스트 도구의 샘플 데이터로 확인한다.

## 현재 상태 / 남은 일 (2026-09-28 기준)

- 매장 PC 는 예전 방식(아이콘 2개, 주소에 토큰 포함)으로 설치돼 있다. 한 번 "업데이트" 아이콘을 누르면 새 원클릭 아이콘으로 바뀌고, 이후 `launch.ps1` 이 git 주소의 토큰도 지운다.
- 매장 PC 의 안전 여유일수가 0 으로 저장돼 있었다 (원래 값 3 으로 다시 적용 필요).
- 라벨이 없는 품목이 99개 정도 있다 → 라벨 관리의 일괄 지정으로 처리.
