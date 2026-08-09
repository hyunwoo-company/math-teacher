/**
 * 복사 버튼 라벨 규약: 두 버튼 다 용도가 이름에 있어야 한다.
 *
 * 이름 없는 "복사" 는 실제로는 마크다운 원문이라 한글·워드에 붙이면 `\(x^2\)` 가
 * 그대로 붙는다. 무엇이 붙는지 이름만 보고 알 수 있게 소스에서 라벨을 고정한다.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILES = [
  'src/components/ai/AiPanel.tsx',
  'src/components/center/InlineSolutionPanel.tsx',
  'src/components/center/SolutionsTab.tsx',
  'src/components/center/VariantPanel.tsx',
];

describe('복사 버튼 라벨', () => {
  it.each(FILES)('%s 에 이름 없는 "복사" 버튼이 없다', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).not.toMatch(/label="복사"/);
  });

  it.each(FILES)('%s 에 두 용도 라벨이 모두 있다', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source).toContain('label="복사(AI 대화용)"');
    expect(source).toContain('label="복사(한글·워드용)"');
  });
});
