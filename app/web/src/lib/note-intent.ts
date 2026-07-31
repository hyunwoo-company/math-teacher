/**
 * 채팅 문장에서 "오답노트에 추가" 의도를 파싱한다 (계약 6-A, AI 호출 0회).
 *
 * 예: "5번 6번 이현우 오답노트에 추가해줘"
 *   -> { problemNos: [5,6], noteQuery: "이현우", ... }
 *
 * 노트 이름 매칭은 여기서 하지 않는다(스토어가 노트 목록과 대조). 여기서는
 * **의도가 오답노트 추가인지**와 **문항 번호 / 노트 이름 후보**만 뽑는다.
 * 애매하면 `isAddIntent:false` 로 두어 일반 채팅으로 흘려보낸다(오탐 방지).
 */

import { detectProblemNos } from '@/lib/mention';

export interface NoteAddIntent {
  isAddIntent: boolean;
  problemNos: number[];
  /** 노트 이름 후보(학생명 등). 못 뽑으면 null → 스토어가 사용자에게 물어본다. */
  noteQuery: string | null;
}

/** "오답노트", "오답 노트" 뒤에 추가/담다 계열 동사가 오는 패턴. */
const ADD_INTENT_RE = /오답\s*노트[에]?\s*(?:.*?)(추가|담|넣|저장|등록)/;

/** "<이름> 오답노트" 에서 이름 후보를 뽑는다. */
const NOTE_NAME_RE = /([^\s,]{1,20})\s*(?:의)?\s*오답\s*노트/;

/** 노트 이름 후보에서 걸러낼 관용어(문항 표현이 이름으로 오인되지 않게). */
const NAME_STOPWORDS = new Set([
  '이',
  '그',
  '저',
  '내',
  '제',
  '해당',
  '이번',
  '위',
  '아래',
  '문제',
  '문항',
  '오답',
]);

/**
 * @param text 사용자 입력
 * @param availableNos 시험지의 문항 번호(오탐 방지)
 */
export function parseNoteAddIntent(text: string, availableNos: readonly number[]): NoteAddIntent {
  const empty: NoteAddIntent = { isAddIntent: false, problemNos: [], noteQuery: null };
  if (!text) return empty;
  if (!ADD_INTENT_RE.test(text)) return empty;

  const problemNos = detectProblemNos(text, availableNos);

  let noteQuery: string | null = null;
  const nameMatch = NOTE_NAME_RE.exec(text);
  if (nameMatch) {
    let candidate = (nameMatch[1] ?? '').trim();
    // 후보가 숫자/문항표현이면 이름이 아니다.
    candidate = candidate.replace(/[0-9#번째,]/g, '').trim();
    // 소유격 "의" 가 이름 끝에 붙어 잡히면 떼어 낸다("김민지의" -> "김민지").
    candidate = candidate.replace(/의$/, '').trim();
    if (candidate !== '' && !NAME_STOPWORDS.has(candidate)) {
      noteQuery = candidate;
    }
  }

  return { isAddIntent: true, problemNos, noteQuery };
}
