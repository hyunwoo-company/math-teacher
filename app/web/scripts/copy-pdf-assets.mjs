/**
 * pdf.js 런타임 에셋을 `public/pdfjs/` 로 복사한다.
 *
 * CDN 을 쓰지 않는 이유: 데스크톱(Tauri) 오프라인 동작이 요구사항이다.
 * - pdf.worker.min.mjs : 워커 스크립트 (필수)
 * - cmaps/             : CJK(한국어) CID 폰트 매핑 (한국 시험지 PDF 에 필요할 수 있음)
 * - standard_fonts/    : 임베드되지 않은 표준 폰트 대체
 *
 * `predev` / `prebuild` 에서 자동 실행된다.
 */
import { access, cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const pdfjsRoot = join(webRoot, 'node_modules', 'pdfjs-dist');
const outDir = join(webRoot, 'public', 'pdfjs');

/** @param {string} p */
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(pdfjsRoot))) {
    console.error('[copy-pdf-assets] pdfjs-dist 가 설치되어 있지 않습니다. npm install 먼저 실행하세요.');
    process.exitCode = 1;
    return;
  }

  await mkdir(outDir, { recursive: true });

  /** @type {Array<[string, string, boolean]>} 원본, 대상, 필수여부 */
  const targets = [
    // legacy 빌드를 쓴다: 최신 빌드는 Map.prototype.getOrInsertComputed 같은
    // 아주 최근 V8 기능을 요구해서 Tauri WebView 등 구형 엔진에서 렌더가 실패한다.
    [
      join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.min.mjs'),
      join(outDir, 'pdf.worker.min.mjs'),
      true,
    ],
    [join(pdfjsRoot, 'cmaps'), join(outDir, 'cmaps'), false],
    [join(pdfjsRoot, 'standard_fonts'), join(outDir, 'standard_fonts'), false],
  ];

  for (const [from, to, required] of targets) {
    if (!(await exists(from))) {
      const msg = `[copy-pdf-assets] 찾을 수 없음: ${from}`;
      if (required) throw new Error(msg);
      console.warn(`${msg} (건너뜀)`);
      continue;
    }
    await cp(from, to, { recursive: true });
    console.log(`[copy-pdf-assets] ${from} -> ${to}`);
  }
}

await main();
