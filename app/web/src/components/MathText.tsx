import { Fragment, useMemo } from 'react';
import { renderMathToHtml, splitInline, splitMath } from '@/lib/math-text';

interface MathTextProps {
  /** AI 응답 원문. 수식 구분자를 포함할 수 있다. */
  children: string;
  className?: string;
}

/**
 * 수식이 섞인 텍스트를 렌더한다.
 * 텍스트 구간은 개행을 유지하고, 수식 구간만 KaTeX HTML 로 바꾼다.
 */
export function MathText({ children, className }: MathTextProps) {
  const segments = useMemo(() => {
    const parsed = splitMath(children);
    // 블록 수식은 그 자체로 위아래 여백을 가진다. 인접한 개행까지 그대로 두면
    // 빈 줄이 하나 더 들어간 것처럼 보이므로 한 개만 흡수한다.
    return parsed.map((segment, index) => {
      if (segment.kind !== 'text') return segment;
      const previous = parsed[index - 1];
      const next = parsed[index + 1];
      let value = segment.value;
      if (previous?.kind === 'math' && previous.display) value = value.replace(/^\n/, '');
      if (next?.kind === 'math' && next.display) value = value.replace(/\n$/, '');
      return { ...segment, value };
    });
  }, [children]);

  return (
    <div className={className}>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') {
          return <Fragment key={index}>{renderInline(segment.value)}</Fragment>;
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
      })}
    </div>
  );
}

function renderInline(value: string) {
  return splitInline(value).map((token, index) => {
    switch (token.kind) {
      case 'bold':
        return (
          <strong key={index} className="font-semibold text-slate-900">
            {token.value}
          </strong>
        );
      case 'code':
        return (
          <code key={index} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em]">
            {token.value}
          </code>
        );
      default:
        // 개행을 살린다(부모에 whitespace-pre-wrap 적용).
        return (
          <span key={index} className="whitespace-pre-wrap">
            {token.value}
          </span>
        );
    }
  });
}
