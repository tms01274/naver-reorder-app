// 앱 아이콘 만들기: 스테인드글라스 썬캐쳐 (어두운 바탕 + 금색 납선 + 색유리 조각)
//
//   cd docs/tools && node build-icon.js
//
// → windows-autostart/app.ico (바탕화면 아이콘, 16~256px), public/favicon.png (브라우저 탭)
// 외부 패키지 없이 직접 그린다 (4×4 슈퍼샘플링으로 가장자리를 부드럽게).

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..", "..");

// 256 기준 좌표
const BG = [31, 36, 51]; // 바탕
const GOLD = [222, 186, 112]; // 납선 (골드 리드테이프)
const STRING = [196, 201, 214];
const CENTER = { x: 128, y: 146 };
const R_OUT = 88;
const R_IN = 30;
const R_MID = 60;
// 안쪽 고리 6조각, 바깥 고리 6조각 (반 칸 엇갈려서 색유리 모자이크처럼)
const INNER = [[245, 159, 103], [239, 122, 161], [155, 124, 245], [86, 182, 240], [76, 195, 160], [242, 201, 76]];
const OUTER = [[91, 124, 250], [76, 195, 160], [245, 159, 103], [239, 122, 161], [86, 182, 240], [155, 124, 245]];
const N = 6;
const CENTER_COLOR = [250, 228, 150];

function roundRectInside(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= 0 && y >= 0 && x <= size && y <= size;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// 한 점(256 기준)의 색 [r,g,b,a]
function sample(x, y) {
  if (!roundRectInside(x, y, 256, 56)) return [0, 0, 0, 0];
  let c = [...BG];
  const over = (col, a = 1) => { c = c.map((v, i) => v + (col[i] - v) * a); };

  // 매다는 줄 + 고리
  if (Math.abs(x - 128) <= 2.5 && y >= 14 && y <= 46) over(STRING);
  const ringD = Math.hypot(x - 128, y - 52);
  if (ringD >= 5 && ringD <= 10) over(GOLD);

  const dx = x - CENTER.x;
  const dy = y - CENTER.y;
  const d = Math.hypot(dx, dy);
  if (d <= R_OUT) {
    // 유리 조각
    const step = (Math.PI * 2) / N;
    const ang = (Math.atan2(dy, dx) + Math.PI * 2 + Math.PI / 2) % (Math.PI * 2);
    if (d <= R_IN) over(CENTER_COLOR);
    else if (d <= R_MID) over(INNER[Math.floor(ang / step) % N]);
    else over(OUTER[Math.floor(((ang + step / 2) % (Math.PI * 2)) / step) % N]);
    // 유리 느낌: 왼쪽 위가 살짝 밝게
    const shine = Math.max(0, 1 - Math.hypot(x - 96, y - 112) / 90);
    over([255, 255, 255], 0.28 * shine);
    // 납선: 가운데 원 테두리, 조각 사이 선
    if (Math.abs(d - R_IN) <= 3.5 || Math.abs(d - R_MID) <= 3.5) over(GOLD);
    const line = (a, r1, r2) => distToSegment(x, y, CENTER.x + Math.cos(a) * r1, CENTER.y + Math.sin(a) * r1, CENTER.x + Math.cos(a) * r2, CENTER.y + Math.sin(a) * r2) <= 3.5;
    for (let k = 0; k < N; k++) {
      const a = k * step - Math.PI / 2;
      if (line(a, R_IN, R_MID) || line(a - step / 2, R_MID, R_OUT)) over(GOLD);
    }
  }
  // 바깥 테두리
  if (Math.abs(d - R_OUT) <= 5) over(GOLD);
  // 고리와 원을 잇는 짧은 줄
  if (Math.abs(x - 128) <= 2.5 && y >= 60 && y <= CENTER.y - R_OUT) over(GOLD);
  return [...c, 255];
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  const scale = 256 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = sample((i + (sx + 0.5) / S) * scale, (j + (sy + 0.5) / S) * scale);
          // 투명한 가장자리 색이 섞여 어두워지지 않게 알파 곱해서 더한다
          for (let k = 0; k < 3; k++) acc[k] += c[k] * c[3];
          acc[3] += c[3];
        }
      }
      const o = (j * size + i) * 4;
      const a = acc[3] / (S * S);
      for (let k = 0; k < 3; k++) px[o + k] = acc[3] ? Math.round(acc[k] / acc[3]) : 0;
      px[o + 3] = Math.round(a);
    }
  }
  return px;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8bit
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ICO 안에 PNG 를 그대로 넣는다 (Windows Vista 이후 지원)
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, data: png(size, render(size)) }));
fs.writeFileSync(path.join(ROOT, "windows-autostart", "app.ico"), ico(images));
fs.writeFileSync(path.join(ROOT, "public", "favicon.png"), images.find((i) => i.size === 64).data);
fs.writeFileSync(path.join(require("os").tmpdir(), "mali-icon-preview.png"), images.find((i) => i.size === 256).data);
console.log("만들었어요: windows-autostart/app.ico, public/favicon.png (미리보기: 임시 폴더의 mali-icon-preview.png)");
