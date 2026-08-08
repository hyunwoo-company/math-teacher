import { Fragment, useMemo, type ReactNode } from 'react';
import { parseBlocks, renderMathToHtml, splitInline, splitMath, type Block } from '@/lib/math-text';

interface MathTextProps {
  /** AI 응답 원문. 수식 구분자와 블록 마크다운(제목/목록)을 포함할 수 있다. */
  children: string;
  className?: string;
}

/**
 * 수식이 섞인 텍스트를 렌더한다.
 * 블록(제목/목록/문단/디스플레이 수식)으로 나눈 뒤, 각 블록의 텍스트는
 * 인라인 수식·굵게·코드까지 그대로 통과시킨다.
 */
export function MathText({ children, className }: MathTextProps) {
  const blocks = useMemo(() => parseBlocks(children), [children]);
  return <div className={className}>{blocks.map((block, index) => renderBlock(block, index))}</div>;
}

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

function headingClassName(level: number): string {
  switch (level) {
    case 1:
      return 'mt-4 mb-1 text-lg font-semibold text-slate-900 first:mt-0';
    case 2:
      return 'mt-3 mb-1 text-base font-semibold text-slate-900 first:mt-0';
    case 3:
      return 'mt-3 mb-1 text-sm font-semibold text-slate-900 first:mt-0';
    default:
      return 'mt-2 mb-1 text-sm font-medium text-slate-700 first:mt-0';
  }
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = HEADING_TAGS[block.level - 1] ?? 'h6';
      return (
        <Tag key={key} className={headingClassName(block.level)}>
          <RichContent source={block.content} />
        </Tag>
      );
    }
    case 'ul':
      return (
        <ul key={key} className="my-2 list-disc space-y-1 pl-5 marker:text-slate-400">
          {block.items.map((item, index) => (
            <li key={index}>
              <RichContent source={item} />
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} className="my-2 list-decimal space-y-1 pl-5 marker:text-slate-400">
          {block.items.map((item, index) => (
            <li key={index}>
              <RichContent source={item} />
            </li>
          ))}
        </ol>
      );
    case 'math':
      // 디스플레이 수식 블록. RichContent 가 KaTeX display 래퍼를 만든다.
      return <RichContent key={key} source={block.content} />;
    case 'paragraph':
      return (
        <p key={key} className="mt-2 whitespace-pre-wrap leading-relaxed first:mt-0">
          <RichContent source={block.content} />
        </p>
      );
    default:
      return null;
  }
}

/**
 * 한 블록의 텍스트를 인라인 수식/굵게/코드까지 렌더한다.
 *
 * 인라인(굵게/코드) 분리를 수식 분리보다 **바깥 레벨**로 둔다. 그래야
 * `**높이 $y$ 의 최댓값**` 처럼 굵게 범위가 인라인 수식을 감싸도 `**` 짝이
 * 서로 다른 수식 세그먼트로 갈라지지 않는다. 각 인라인 토큰(굵게/코드/일반)의
 * 내부 텍스트를 다시 `splitMath` 로 나눠 그 안의 수식만 KaTeX 로 렌더한다.
 */
function RichContent({ source }: { source: string }) {
  return (
    <>
      {splitInline(source).map((token, index) => {
        switch (token.kind) {
          case 'bold':
            return (
              <strong key={index} className="font-semibold text-slate-900">
                {renderTextWithMath(token.value, false)}
              </strong>
            );
          case 'code':
            return (
              <code
                key={index}
                className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em]"
              >
                {renderTextWithMath(token.value, false)}
              </code>
            );
          default:
            return <Fragment key={index}>{renderTextWithMath(token.value, true)}</Fragment>;
        }
      })}
    </>
  );
}

/**
 * 텍스트를 수식/일반 세그먼트로 나눠 렌더한다.
 * `wrapPlain` 이 참이면 일반 텍스트를 `whitespace-pre-wrap` span 으로 감싸 개행을
 * 살린다(문단용). 굵게/코드 안에서는 텍스트 노드를 strong/code 의 직계 자식으로
 * 두어야 하므로 감싸지 않는다.
 */
function renderTextWithMath(source: string, wrapPlain: boolean): ReactNode[] {
  return splitMath(source).map((segment, index) => {
    if (segment.kind === 'text') {
      return wrapPlain ? (
        <span key={index} className="whitespace-pre-wrap">
          {segment.value}
        </span>
      ) : (
        <Fragment key={index}>{segment.value}</Fragment>
      );
    }
    const html = renderMathToHtml(segment.value, segment.display);
    return segment.display ? (
      <div
        key={index}
        className="my-2 overflow-x-auto text-center"
        // KaTeX 가 생성한 HTML. 입력은 escape 되고 trust:false 이므로 태그 주입은 막힌다.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    ) : (
      <span key={index} dangerouslySetInnerHTML={{ __html: html }} />
    );
  });
}
