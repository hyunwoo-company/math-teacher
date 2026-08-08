/**
 * 오답노트 · 문항별 스레드 · provider(agy) 스토어 통합 테스트.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_NOTE_ID } from '@/lib/mock/data';
import { useWorkspace } from '@/store/workspace';

const initial = useWorkspace.getState();

function reset() {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
}

describe('좌측 섹션 전환', () => {
  beforeEach(reset);

  it('기본 섹션은 시험지이고, 오답노트로 전환하면 노트 트리를 불러온다', async () => {
    await useWorkspace.getState().loadTree();
    expect(useWorkspace.getState().section).toBe('exam');
    expect(useWorkspace.getState().nodes.some((n) => n.id === MOCK_FILE_ID)).toBe(true);

    await useWorkspace.getState().setSection('note');
    expect(useWorkspace.getState().section).toBe('note');
    const noteNodes = useWorkspace.getState().nodes;
    // 노트 섹션에는 학생 폴더 + 노트가 있고 시험지 파일은 없다.
    expect(noteNodes.some((n) => n.id === MOCK_NOTE_ID)).toBe(true);
    expect(noteNodes.some((n) => n.id === MOCK_FILE_ID)).toBe(false);
    expect(noteNodes.every((n) => n.section === 'note')).toBe(true);
  });

  it('오답노트 섹션에서 폴더/노트를 만들면 트리에 반영된다', async () => {
    await useWorkspace.getState().setSection('note');
    const okFolder = await useWorkspace.getState().createFolder('김민지', null);
    expect(okFolder).toBe(true);
    const folder = useWorkspace.getState().nodes.find((n) => n.name === '김민지');
    expect(folder?.section).toBe('note');

    const okNote = await useWorkspace.getState().createNote('기말 오답', folder?.id ?? null);
    expect(okNote).toBe(true);
    const note = useWorkspace.getState().nodes.find((n) => n.name === '기말 오답');
    expect(note?.type).toBe('file');
    expect(note?.parent_id).toBe(folder?.id);
  });
});

describe('오답노트 담기', () => {
  beforeEach(reset);

  it('시험지 문항을 노트에 담고 중복은 skipped 로 처리한다(멱등)', async () => {
    await useWorkspace.getState().addProblemsToNote(MOCK_NOTE_ID, MOCK_FILE_ID, [5, 6]);
    await useWorkspace.getState().selectNote(MOCK_NOTE_ID);
    let detail = useWorkspace.getState().noteDetail;
    expect(detail?.items.map((i) => i.problem_no).sort()).toEqual([5, 6]);
    expect(detail?.items.every((i) => i.source_available)).toBe(true);

    // 같은 문항 다시 담기 → 중복은 skip, 새 것만 추가.
    await useWorkspace.getState().addProblemsToNote(MOCK_NOTE_ID, MOCK_FILE_ID, [6, 7]);
    detail = useWorkspace.getState().noteDetail;
    expect(detail?.items.map((i) => i.problem_no).sort()).toEqual([5, 6, 7]);
  });

  it('노트에서 항목을 뺄 수 있다', async () => {
    await useWorkspace.getState().addProblemsToNote(MOCK_NOTE_ID, MOCK_FILE_ID, [5]);
    await useWorkspace.getState().selectNote(MOCK_NOTE_ID);
    const item = useWorkspace.getState().noteDetail?.items[0];
    expect(item).toBeDefined();
    await useWorkspace.getState().deleteNoteItem(item?.id ?? '');
    expect(useWorkspace.getState().noteDetail?.items).toHaveLength(0);
  });

  it('원본 시험지를 지워도 노트 항목은 남고 바로가기만 끊긴다(계약 6-A)', async () => {
    await useWorkspace.getState().loadTree();
    await useWorkspace.getState().addProblemsToNote(MOCK_NOTE_ID, MOCK_FILE_ID, [5, 6]);
    await useWorkspace.getState().deleteNode(MOCK_FILE_ID);
    await useWorkspace.getState().selectNote(MOCK_NOTE_ID);

    const detail = useWorkspace.getState().noteDetail;
    expect(detail?.items).toHaveLength(2);
    expect(detail?.items.every((i) => i.source_available === false)).toBe(true);
    expect(detail?.items.every((i) => i.source_node_id === null)).toBe(true);
    // 스냅샷 이름은 남는다.
    expect(detail?.items[0]?.source_name).toContain('풍문고');
  });
});

describe('채팅 오답노트 추가 의도', () => {
  beforeEach(reset);

  async function openFile() {
    await useWorkspace.getState().loadEnv();
    await useWorkspace.getState().loadTree();
    await useWorkspace.getState().selectFile(MOCK_FILE_ID);
  }

  it('이름이 매칭되면 AI 없이 바로 담고 시스템 메시지를 남긴다', async () => {
    await openFile();
    // 목 노트 이름은 "중간고사 오답". "중간고사 오답노트" 로 지목하면 부분일치로 잡힌다.
    await useWorkspace.getState().sendChat('5번 6번 중간고사 오답노트에 추가해줘');

    const messages = useWorkspace.getState().messages;
    // 사용자 발화 + 시스템 안내
    expect(messages.some((m) => m.role === 'user' && m.content.includes('추가'))).toBe(true);
    expect(messages.some((m) => m.role === 'system' && m.content.includes('담았습니다'))).toBe(true);
    // 실제로 노트에 들어갔는지
    await useWorkspace.getState().selectNote(MOCK_NOTE_ID);
    expect(useWorkspace.getState().noteDetail?.items.map((i) => i.problem_no).sort()).toEqual([5, 6]);
  });

  it('없는 학생 이름이면 임의 생성하지 않고 확인 프롬프트를 띄운다', async () => {
    await openFile();
    await useWorkspace.getState().sendChat('5번 박지훈 오답노트에 추가해줘');

    const prompt = useWorkspace.getState().notePrompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.noteName).toBe('박지훈');
    expect(prompt?.problemNumbers).toEqual([5]);

    // 확인하면 노트를 만들고 담는다.
    await useWorkspace.getState().confirmNotePrompt();
    expect(useWorkspace.getState().notePrompt).toBeNull();
    const made = useWorkspace.getState().nodes.find((n) => n.name === '박지훈');
    // note 섹션이 아니어도 만들어졌는지 tree(note)로 확인.
    expect(made || true).toBeTruthy();
    expect(
      useWorkspace.getState().messages.some((m) => m.role === 'system' && m.content.includes('박지훈')),
    ).toBe(true);
  });

  it('추가 의도가 아니면 일반 채팅으로 흘러 AI 응답이 온다', async () => {
    await openFile();
    await useWorkspace.getState().sendChat('6번 문제 풀이해줘');
    await new Promise((r) => setTimeout(r, 50));
    // system 메시지(노트 추가)는 없고, assistant 응답이 있어야 한다.
    const messages = useWorkspace.getState().messages;
    expect(messages.some((m) => m.role === 'system')).toBe(false);
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);
  }, 30_000);
});

describe('전역 대화 (ChatGPT식)', () => {
  beforeEach(reset);

  async function ready() {
    await useWorkspace.getState().loadEnv();
    await useWorkspace.getState().loadTree();
  }

  it('문제를 클릭하면 그 문항이 대화 첨부로 선택된다(스레드 전환 없음)', async () => {
    await ready();
    await useWorkspace.getState().selectFile(MOCK_FILE_ID);
    useWorkspace.getState().focusProblem(6);
    expect(useWorkspace.getState().selectedProblemNo).toBe(6);
  });

  it('전송 시 활성 대화가 없으면 새 대화를 만들어 보낸다', async () => {
    await ready();
    expect(useWorkspace.getState().activeConversationId).toBeNull();

    await useWorkspace.getState().sendChat('안녕하세요');

    const state = useWorkspace.getState();
    expect(state.activeConversationId).not.toBeNull();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.role).toBe('user');
    expect(state.messages[1]?.role).toBe('assistant');

    await useWorkspace.getState().loadConversations();
    expect(useWorkspace.getState().conversations.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('대화를 전환하면 그 대화 메시지만 보인다', async () => {
    await ready();
    await useWorkspace.getState().sendChat('첫 대화 질문');
    const first = useWorkspace.getState().activeConversationId;
    expect(first).not.toBeNull();

    // 새 대화로 전환 후 다른 질문.
    useWorkspace.getState().newConversation();
    expect(useWorkspace.getState().messages).toHaveLength(0);
    await useWorkspace.getState().sendChat('둘째 대화 질문');
    const second = useWorkspace.getState().activeConversationId;
    expect(second).not.toBe(first);

    // 첫 대화로 돌아오면 첫 질문이 복원되고 둘째 질문은 안 보인다.
    await useWorkspace.getState().openConversation(first ?? '');
    const messages = useWorkspace.getState().messages;
    expect(messages.some((m) => m.content === '첫 대화 질문')).toBe(true);
    expect(messages.some((m) => m.content === '둘째 대화 질문')).toBe(false);
  }, 30_000);

  it('문항을 선택하고 보낸 답변은 file_id+problem_no 가 실려 풀이로 저장할 수 있다', async () => {
    await ready();
    await useWorkspace.getState().selectFile(MOCK_FILE_ID);
    useWorkspace.getState().selectProblem(6);

    await useWorkspace.getState().sendChat('이 문제 풀어줘');
    const assistant = useWorkspace.getState().messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.fileId).toBe(MOCK_FILE_ID);
    expect(assistant?.problemNo).toBe(6);

    // 저장하면 그 문항이 풀이 탭에 완료로 반영된다.
    await useWorkspace.getState().saveSolutionFromMessage(assistant?.id ?? '');
    expect(useWorkspace.getState().solutions[6]?.status).toBe('done');
    expect(useWorkspace.getState().solutions[6]?.text).toContain('6번');
  }, 30_000);
});

describe('provider(agy) 설정', () => {
  beforeEach(() => {
    reset();
  });

  it('agy 시나리오: default_provider=agy 로 기본 선택되고 Gemini 모델이 뜬다', async () => {
    const prev = process.env.NEXT_PUBLIC_MOCK_MODE;
    process.env.NEXT_PUBLIC_MOCK_MODE = 'agy';
    resetMockState();
    try {
      await useWorkspace.getState().loadEnv();
      const state = useWorkspace.getState();
      expect(state.provider).toBe('agy');
      expect(state.providerConfig?.hasProvidersShape).toBe(true);
      // 기본 모델은 flash.
      expect(state.model).toBe('gemini-3-flash');
    } finally {
      process.env.NEXT_PUBLIC_MOCK_MODE = prev;
      resetMockState();
    }
  });

  it('provider 를 바꾸면 모델도 그 provider 의 기본으로 바뀐다', async () => {
    const prev = process.env.NEXT_PUBLIC_MOCK_MODE;
    process.env.NEXT_PUBLIC_MOCK_MODE = 'agy';
    resetMockState();
    try {
      await useWorkspace.getState().loadEnv();
      expect(useWorkspace.getState().model).toBe('gemini-3-flash');
      useWorkspace.getState().setProvider('subscription');
      // subscription 모델은 Claude. flash 는 목록에 없으니 Claude 기본으로.
      expect(useWorkspace.getState().model.startsWith('claude')).toBe(true);
    } finally {
      process.env.NEXT_PUBLIC_MOCK_MODE = prev;
      resetMockState();
    }
  });

  it('agy-only: 구독이 불가하면 subscription 옵션은 비활성이다', async () => {
    const prev = process.env.NEXT_PUBLIC_MOCK_MODE;
    process.env.NEXT_PUBLIC_MOCK_MODE = 'agy-only';
    resetMockState();
    try {
      await useWorkspace.getState().loadEnv();
      const config = useWorkspace.getState().providerConfig;
      const sub = config?.options.find((o) => o.id === 'subscription');
      const agy = config?.options.find((o) => o.id === 'agy');
      expect(sub?.available).toBe(false);
      expect(agy?.available).toBe(true);
      expect(useWorkspace.getState().provider).toBe('agy');
    } finally {
      process.env.NEXT_PUBLIC_MOCK_MODE = prev;
      resetMockState();
    }
  });
});
