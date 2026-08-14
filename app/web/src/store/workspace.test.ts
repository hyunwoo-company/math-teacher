/**
 * 스토어 + 목 API 통합 테스트.
 *
 * 목 클라이언트는 실제 SSE 바이트를 만들어 실제 파서를 통과시키므로,
 * 이 테스트는 "스트리밍 -> 파싱 -> 상태 반영" 경로 전체를 검증한다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_PROBLEM_COUNT } from '@/lib/mock/data';
import { buildTree } from '@/lib/tree';
import {
  LEFT_MAX,
  LEFT_MIN,
  useWorkspace,
  __internal,
  type ToastMessage,
} from '@/store/workspace';

const initial = useWorkspace.getState();

/** usage 합계(테스트 가독성용). */
function totalTokensOf(usage: { input_tokens?: number; output_tokens?: number } | null): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

function reset() {
  __internal.resetJobSubscriptions();
  useWorkspace.setState(initial, true);
  resetMockState();
  // 새로고침 복원(loadTree → restoreLastOpen)이 prefs 를 읽으므로 테스트 간 격리한다.
  window.localStorage.clear();
}

async function selectMockFile() {
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
}


/**
 * 작업이 끝날 때까지 기다린다.
 *
 * 작업 큐로 바뀐 뒤 생성 호출은 즉시 돌아오고 진행은 서버(목에서는 타이머)가
 * 이어간다. 테스트는 상태가 목표에 닿을 때까지 폴링한다.
 */
async function until(check: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('작업이 시간 안에 끝나지 않았습니다.');
}

describe('워크스페이스 스토어 (목 API)', () => {
  beforeEach(() => {
    reset();
  });

  it('환경을 불러와 모델 목록을 채운다', async () => {
    await useWorkspace.getState().loadEnv();
    const { env, envStatus, model } = useWorkspace.getState();
    expect(envStatus).toBe('ready');
    expect(env?.models.length).toBeGreaterThan(0);
    expect(env?.usd_krw).toBe(1400);
    expect(model).toBe('claude-opus-5');
  });

  it('기본 공급자는 구독이고, 구독이 가능한 환경에서는 그대로 유지된다', async () => {
    expect(useWorkspace.getState().provider).toBe('subscription');
    await useWorkspace.getState().loadEnv();
    expect(useWorkspace.getState().env?.subscription.available).toBe(true);
    expect(useWorkspace.getState().provider).toBe('subscription');
  });

  it('구독을 쓸 수 없는 환경(웹)에서는 provider 를 apikey 로 정규화한다', async () => {
    const previous = process.env.NEXT_PUBLIC_MOCK_MODE;
    process.env.NEXT_PUBLIC_MOCK_MODE = 'web';
    resetMockState();
    try {
      expect(useWorkspace.getState().provider).toBe('subscription');
      await useWorkspace.getState().loadEnv();

      const { env, provider } = useWorkspace.getState();
      expect(env?.subscription.available).toBe(false);
      // 'subscription' 을 그대로 두면 백엔드가 409 를 주고 select 가 빈칸이 된다.
      expect(provider).toBe('apikey');
    } finally {
      process.env.NEXT_PUBLIC_MOCK_MODE = previous;
      resetMockState();
    }
  });

  it('저장된 prefs 의 subscription 도 구독 불가 환경에서는 정규화된다', async () => {
    const previous = process.env.NEXT_PUBLIC_MOCK_MODE;
    process.env.NEXT_PUBLIC_MOCK_MODE = 'web';
    resetMockState();
    try {
      window.localStorage.setItem(
        'math-teacher.uiPrefs',
        JSON.stringify({ provider: 'subscription', model: 'claude-opus-5' }),
      );
      // env 를 먼저 받은 뒤 하이드레이트되는 순서에서도 정규화가 걸려야 한다.
      await useWorkspace.getState().loadEnv();
      useWorkspace.getState().hydratePrefs();
      expect(useWorkspace.getState().provider).toBe('apikey');
    } finally {
      window.localStorage.clear();
      process.env.NEXT_PUBLIC_MOCK_MODE = previous;
      resetMockState();
    }
  });

  it('구독 호출은 usage 는 받지만 금액은 세지 않는다(cost 가 null)', async () => {
    await useWorkspace.getState().loadEnv();
    await selectMockFile();
    await useWorkspace.getState().startSolve([1]);
    await until(() => useWorkspace.getState().solutions[1]?.status === 'done');

    const { solutions, totals } = useWorkspace.getState();
    // 백엔드 실측: 구독도 usage 는 실제 값이 오고 cost 만 null 이다.
    expect(solutions[1]?.usage?.output_tokens).toBeGreaterThan(0);
    expect(solutions[1]?.cost).toBeNull();
    expect(totals.billedCalls).toBe(0);
    expect(totals.subscriptionCalls).toBe(1);
    expect(totals.usd).toBe(0);
    expect(totalTokensOf(totals.usage)).toBeGreaterThan(0);
  }, 30_000);

  it('트리를 불러와 2단 중첩으로 조립한다', async () => {
    await useWorkspace.getState().loadTree();
    const { nodes, treeStatus } = useWorkspace.getState();
    expect(treeStatus).toBe('ready');

    const roots = buildTree(nodes);
    const semester = roots.find((item) => item.node.name === '2026-1학기');
    expect(semester).toBeDefined();
    const subject = semester?.children.find((item) => item.node.name === '공통수학1');
    expect(subject).toBeDefined();
    expect(subject?.children[0]?.node.type).toBe('file');
    expect(subject?.children[0]?.depth).toBe(2);
  });

  it('루트 폴더는 처음에 펼쳐진 상태로 둔다', async () => {
    await useWorkspace.getState().loadTree();
    const { expanded, nodes } = useWorkspace.getState();
    const rootFolders = nodes.filter((node) => node.type === 'folder' && node.parent_id === null);
    for (const folder of rootFolders) expect(expanded[folder.id]).toBe(true);
  });

  it('파일을 선택하면 문제 22개를 채운다', async () => {
    await selectMockFile();
    const { fileDetail, fileStatus, solutions } = useWorkspace.getState();
    expect(fileStatus).toBe('ready');
    expect(fileDetail?.problems).toHaveLength(MOCK_PROBLEM_COUNT);
    expect(Object.keys(solutions)).toHaveLength(MOCK_PROBLEM_COUNT);
    expect(solutions[1]?.status).toBe('empty');
  });

  it('문제를 클릭하면 채팅 컨텍스트와 뷰어 포커스가 걸린다', async () => {
    await selectMockFile();
    useWorkspace.getState().focusProblem(7);
    const { selectedProblemNo, focusRequest } = useWorkspace.getState();
    expect(selectedProblemNo).toBe(7);
    expect(focusRequest?.no).toBe(7);
    expect(focusRequest?.page).toBe(2); // 4문항/쪽 배치
  });

  it(
    '전체 문제풀이: 진행률이 오르고 delta 가 누적되어 22개가 완료된다',
    async () => {
      await selectMockFile();

      const progressSnapshots: number[] = [];
      const sawStreamingText: string[] = [];
      const unsubscribe = useWorkspace.subscribe((state) => {
        progressSnapshots.push(state.solve.doneCount);
        const running = Object.values(state.solutions).find((entry) => entry?.status === 'running');
        if (running && running.streamingText) sawStreamingText.push(running.streamingText);
      });

      await useWorkspace.getState().startSolve(null);
      await until(
        () =>
          useWorkspace.getState().solve.doneCount === MOCK_PROBLEM_COUNT &&
          !useWorkspace.getState().solve.running,
      );
      unsubscribe();

      const { solve, solutions, totals, activeTab } = useWorkspace.getState();

      // 전체 풀이를 시작하면 풀이 탭으로 전환된다.
      expect(activeTab).toBe('solutions');
      expect(solve.total).toBe(MOCK_PROBLEM_COUNT);
      expect(solve.doneCount).toBe(MOCK_PROBLEM_COUNT);
      expect(solve.running).toBe(false);
      expect(solve.error).toBeNull();

      // 진행률이 0 -> 22 로 단조 증가했다.
      expect(Math.max(...progressSnapshots)).toBe(MOCK_PROBLEM_COUNT);
      expect(progressSnapshots).toContain(1);
      expect(progressSnapshots).toContain(11);

      // delta 가 조각조각 누적되는 중간 상태를 실제로 관찰했다.
      // (문항이 바뀌면 누적 텍스트가 0 으로 돌아가므로 인덱스끼리 비교하지 않고
      //  관찰된 길이의 최소/최대를 본다.)
      expect(sawStreamingText.length).toBeGreaterThan(20);
      const lengths = sawStreamingText.map((text) => text.length);
      expect(Math.max(...lengths)).toBeGreaterThan(Math.min(...lengths));

      // 모든 문제에 풀이 본문이 들어왔고 수식 구분자가 살아 있다.
      for (let no = 1; no <= MOCK_PROBLEM_COUNT; no += 1) {
        const entry = solutions[no];
        expect(entry?.status).toBe('done');
        expect(entry?.text).toContain('\\[');
        expect(entry?.text).toContain('\\(');
        expect(entry?.streamingText).toBe('');
      }

      // 구독 모드(목 기본값)이므로 과금 호출은 0, 구독 호출만 센다.
      expect(totals.billedCalls).toBe(0);
      expect(totals.subscriptionCalls).toBe(MOCK_PROBLEM_COUNT);
    },
    120_000,
  );

  it(
    'API 키 모드로 풀면 토큰과 비용이 누적된다',
    async () => {
      await useWorkspace.getState().loadEnv();
      await selectMockFile();
      useWorkspace.getState().setProvider('apikey');

      await useWorkspace.getState().startSolve([1, 2]);
      await until(
        () =>
          useWorkspace.getState().solutions[1]?.status === 'done' &&
          useWorkspace.getState().solutions[2]?.status === 'done',
      );

      const { totals, solutions } = useWorkspace.getState();
      expect(totals.billedCalls).toBe(2);
      expect(totals.usd).toBeGreaterThan(0);
      expect(totals.krw).toBeGreaterThan(0);
      expect((totals.usage?.input_tokens ?? 0) > 0).toBe(true);
      expect(solutions[1]?.cost?.total_krw).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    '중단 버튼을 누르면 스트림이 멈춘다',
    async () => {
      await selectMockFile();

      // 작업 생성은 즉시 끝난다(진행은 서버 큐에서 계속된다).
      await useWorkspace.getState().startSolve(null);
      // 몇 개 처리될 때까지 기다렸다가 취소한다.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(useWorkspace.getState().solve.running).toBe(true);
      const running = useWorkspace
        .getState()
        .jobs.find((job) => job.status === 'running' || job.status === 'queued');
      expect(running).toBeDefined();
      await useWorkspace.getState().cancelJob(running!.id);

      const { solve } = useWorkspace.getState();
      expect(solve.running).toBe(false);
      expect(solve.aborted).toBe(true);
      expect(solve.doneCount).toBeLessThan(MOCK_PROBLEM_COUNT);
      // running 으로 남은 항목이 없어야 한다.
      expect(
        Object.values(useWorkspace.getState().solutions).some((entry) => entry?.status === 'running'),
      ).toBe(false);
    },
    60_000,
  );

  it(
    '채팅: 사용자 메시지 후 AI 응답이 스트리밍으로 채워진다',
    async () => {
      await selectMockFile();
      useWorkspace.getState().selectProblem(3);

      await useWorkspace.getState().sendChat('3번 문제 왜 실근이 없나요?');

      const { messages, chatSending } = useWorkspace.getState();
      expect(chatSending).toBe(false);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe('user');
      expect(messages[0]?.content).toBe('3번 문제 왜 실근이 없나요?');
      expect(messages[0]?.problemNo).toBe(3);
      expect(messages[1]?.role).toBe('assistant');
      expect(messages[1]?.streaming).toBe(false);
      expect(messages[1]?.content).toContain('3번 문제');
      expect(messages[1]?.content).toContain('\\[');
    },
    60_000,
  );

  it('폴더 생성 / 이름 변경 / 삭제가 트리에 반영된다', async () => {
    await useWorkspace.getState().loadTree();

    const created = await useWorkspace.getState().createFolder('2026-2학기', null);
    expect(created).toBe(true);
    const added = useWorkspace.getState().nodes.find((node) => node.name === '2026-2학기');
    expect(added).toBeDefined();

    await useWorkspace.getState().renameNode(added?.id ?? '', '2026-2학기(수정)');
    expect(
      useWorkspace.getState().nodes.find((node) => node.id === added?.id)?.name,
    ).toBe('2026-2학기(수정)');

    await useWorkspace.getState().deleteNode(added?.id ?? '');
    expect(useWorkspace.getState().nodes.find((node) => node.id === added?.id)).toBeUndefined();
  });

  it('폴더를 삭제하면 하위 파일과 선택 상태도 정리된다', async () => {
    await selectMockFile();
    expect(useWorkspace.getState().selectedFileId).toBe(MOCK_FILE_ID);

    await useWorkspace.getState().deleteNode('folder-2026-1');

    const { nodes, selectedFileId, fileDetail } = useWorkspace.getState();
    expect(nodes.find((node) => node.id === MOCK_FILE_ID)).toBeUndefined();
    expect(nodes.find((node) => node.id === 'folder-common1')).toBeUndefined();
    expect(selectedFileId).toBeNull();
    expect(fileDetail).toBeNull();
  });

  it('자기 하위 폴더로는 옮길 수 없다', async () => {
    await useWorkspace.getState().loadTree();
    const moved = await useWorkspace.getState().moveNode('folder-2026-1', 'folder-common1');
    expect(moved).toBe(false);
    expect(useWorkspace.getState().toast?.kind).toBe('error');
    expect(
      useWorkspace.getState().nodes.find((node) => node.id === 'folder-2026-1')?.parent_id,
    ).toBeNull();
  });

  it('다른 폴더로 옮기면 parent_id 가 바뀐다', async () => {
    await useWorkspace.getState().loadTree();
    const moved = await useWorkspace.getState().moveNode(MOCK_FILE_ID, 'folder-june');
    expect(moved).toBe(true);
    expect(
      useWorkspace.getState().nodes.find((node) => node.id === MOCK_FILE_ID)?.parent_id,
    ).toBe('folder-june');
  });

  it('파일 없이 풀이를 시작하면 안내 토스트를 띄운다', async () => {
    await useWorkspace.getState().startSolve(null);
    expect(useWorkspace.getState().toast?.message).toContain('파일을 선택');
    expect(useWorkspace.getState().solve.running).toBe(false);
  });
});

describe('오답노트 담기 모드', () => {
  beforeEach(() => {
    reset();
  });

  it('담기 모드를 다시 켜면 이전 선택이 남지 않는다', () => {
    const store = useWorkspace.getState();
    store.startNotePicking();
    store.toggleNotePick(3);
    store.toggleNotePick(5);
    expect(useWorkspace.getState().notePicked).toEqual([3, 5]);

    // 담지 않고 모달만 닫은 상황: stopNotePicking 이 불리지 않는다.
    // 이 상태에서 담기 모드를 다시 켜면 선택은 비어 있어야 한다.
    useWorkspace.getState().startNotePicking();
    expect(useWorkspace.getState().notePicked).toEqual([]);
  });
});

describe('트리 다중 이동 (moveNodes)', () => {
  beforeEach(() => {
    reset();
  });

  /** 토스트는 상태 한 칸을 덮어쓰므로, 구독해서 "몇 건이 떴는지"를 센다. */
  function collectToasts(): { toasts: ToastMessage[]; stop: () => void } {
    const toasts: ToastMessage[] = [];
    const stop = useWorkspace.subscribe((state) => {
      if (state.toast && !toasts.includes(state.toast)) toasts.push(state.toast);
    });
    return { toasts, stop };
  }

  it('여러 노드를 한 번에 옮기고 트리는 한 번만 새로 고친다', async () => {
    await useWorkspace.getState().loadTree();
    const getTree = vi.spyOn(api, 'getTree');
    const update = vi.spyOn(api, 'updateNode');

    await useWorkspace.getState().moveNodes(
      [MOCK_FILE_ID, 'folder-calculus', 'folder-common1'],
      'folder-june',
    );

    expect(update).toHaveBeenCalledTimes(3);
    expect(getTree).toHaveBeenCalledTimes(1);

    const { nodes } = useWorkspace.getState();
    for (const id of [MOCK_FILE_ID, 'folder-calculus', 'folder-common1']) {
      expect(nodes.find((node) => node.id === id)?.parent_id).toBe('folder-june');
    }
    // 받는 폴더는 펼쳐서 옮긴 결과가 바로 보이게 한다.
    expect(useWorkspace.getState().expanded['folder-june']).toBe(true);

    getTree.mockRestore();
    update.mockRestore();
  });

  it('일부가 실패해도 나머지는 옮기고 실패만 알린다', async () => {
    await useWorkspace.getState().loadTree();
    const { toasts, stop } = collectToasts();

    // folder-2026-1 은 folder-common1 의 조상이라 실패하고, folder-june 은 성공해야 한다.
    await useWorkspace.getState().moveNodes(['folder-2026-1', 'folder-june'], 'folder-common1');
    stop();

    const { nodes } = useWorkspace.getState();
    expect(nodes.find((node) => node.id === 'folder-2026-1')?.parent_id).toBeNull();
    expect(nodes.find((node) => node.id === 'folder-june')?.parent_id).toBe('folder-common1');

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('error');
    expect(toasts[0]?.message).toContain('1개');
  });

  it('이미 그 폴더에 있는 노드는 서버를 부르지 않는다', async () => {
    await useWorkspace.getState().loadTree();
    const update = vi.spyOn(api, 'updateNode');
    const getTree = vi.spyOn(api, 'getTree');

    // MOCK_FILE_ID 의 부모가 이미 folder-common1 이다.
    await useWorkspace.getState().moveNodes([MOCK_FILE_ID, MOCK_FILE_ID], 'folder-common1');

    expect(update).not.toHaveBeenCalled();
    expect(getTree).not.toHaveBeenCalled();

    update.mockRestore();
    getTree.mockRestore();
  });
});

describe('패널 레이아웃 prefs (좌측 너비 / 좌·우 접기)', () => {
  beforeEach(() => {
    reset();
  });

  it('setLeftWidth 는 값을 반영하고 prefs 로 저장한다', () => {
    useWorkspace.getState().setLeftWidth(360);
    expect(useWorkspace.getState().leftWidth).toBe(360);

    const raw = window.localStorage.getItem('math-teacher.uiPrefs');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '{}').leftWidth).toBe(360);
  });

  it('setLeftWidth 는 최소/최대 범위로 클램프한다', () => {
    useWorkspace.getState().setLeftWidth(10);
    expect(useWorkspace.getState().leftWidth).toBe(LEFT_MIN);

    useWorkspace.getState().setLeftWidth(9999);
    expect(useWorkspace.getState().leftWidth).toBe(LEFT_MAX);
  });

  it('좌/우 접기 토글은 상태를 뒤집고 prefs 로 저장한다', () => {
    expect(useWorkspace.getState().leftCollapsed).toBe(false);
    expect(useWorkspace.getState().rightCollapsed).toBe(false);

    useWorkspace.getState().toggleLeftCollapsed();
    useWorkspace.getState().toggleRightCollapsed();
    expect(useWorkspace.getState().leftCollapsed).toBe(true);
    expect(useWorkspace.getState().rightCollapsed).toBe(true);

    const saved = JSON.parse(window.localStorage.getItem('math-teacher.uiPrefs') ?? '{}');
    expect(saved.leftCollapsed).toBe(true);
    expect(saved.rightCollapsed).toBe(true);

    // 다시 누르면 펼침으로 복귀한다.
    useWorkspace.getState().toggleLeftCollapsed();
    expect(useWorkspace.getState().leftCollapsed).toBe(false);
  });

  it('hydratePrefs 는 저장된 leftWidth/접힘 상태를 복원한다', () => {
    window.localStorage.setItem(
      'math-teacher.uiPrefs',
      JSON.stringify({ leftWidth: 340, leftCollapsed: true, rightCollapsed: true }),
    );
    useWorkspace.getState().hydratePrefs();

    const { leftWidth, leftCollapsed, rightCollapsed } = useWorkspace.getState();
    expect(leftWidth).toBe(340);
    expect(leftCollapsed).toBe(true);
    expect(rightCollapsed).toBe(true);
  });
});
