/**
 * 목 모드에서 UI 전체 흐름을 실제로 렌더해 확인한다.
 * (브라우저 육안 확인 대신 쓰는 검증 수단)
 *
 * pdf.js 는 jsdom 에서 canvas 렌더가 불가능하므로 뷰어만 대역으로 바꾼다.
 * 나머지(트리/탭/문제 선택/스트리밍/사용량)는 실제 컴포넌트를 쓴다.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '@/components/Workspace';
import { resetMockState } from '@/lib/mock/client';
import { UPLOAD_NOTICE } from '@/lib/upload-notice';
import { useWorkspace } from '@/store/workspace';

vi.mock('@/components/center/PdfViewer', () => ({
  PdfViewer: ({ fileUrl }: { fileUrl: string }) => (
    <div data-testid="pdf-viewer-stub">PDF 뷰어 대역: {fileUrl}</div>
  ),
}));

const initial = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

async function openWorkspace() {
  const user = userEvent.setup();
  render(<Workspace />);
  // 루트 폴더가 보이면 env + tree 로딩이 끝난 것이다.
  await screen.findByText('2026-1학기', {}, { timeout: 5000 });
  return user;
}

/** 폴더를 펼쳐 시험지를 열고, 파일 상세 로딩까지 기다린다. */
async function openSampleFile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('treeitem', { name: /공통수학1/ }));
  await user.click(await screen.findByRole('treeitem', { name: /풍문고/ }));
  // 문제 번호 목록이 뜨면 fileDetail 로딩이 끝난 것이다.
  await screen.findByRole('button', { name: '22번 문제' }, { timeout: 5000 });
}

describe('좌측 2섹션 (시험지 / 오답노트)', () => {
  it('상단에 [시험지]/[오답노트] 탭이 보이고 기본은 시험지다', async () => {
    await openWorkspace();
    const examTab = screen.getByRole('tab', { name: '시험지' });
    const noteTab = screen.getByRole('tab', { name: '오답노트' });
    expect(examTab).toHaveAttribute('aria-selected', 'true');
    expect(noteTab).toHaveAttribute('aria-selected', 'false');
  });

  it('오답노트 탭으로 전환하면 노트 트리가 뜨고 [+ 노트] 가 보인다', async () => {
    const user = await openWorkspace();
    await user.click(screen.getByRole('tab', { name: '오답노트' }));

    // 목 노트 섹션: 학생 폴더 "이현우" + 노트 "중간고사 오답"
    expect(await screen.findByRole('treeitem', { name: /이현우/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ 노트' })).toBeInTheDocument();
    // 시험지 파일은 이 섹션에 없다.
    expect(screen.queryByRole('treeitem', { name: /풍문고/ })).toBeNull();
    expect(useWorkspace.getState().section).toBe('note');
  });

  it('오답노트 섹션에서 새 노트를 만들면 트리에 나타난다', async () => {
    const user = await openWorkspace();
    await user.click(screen.getByRole('tab', { name: '오답노트' }));
    await screen.findByRole('treeitem', { name: /이현우/ });

    await user.click(screen.getByRole('button', { name: '+ 노트' }));
    const dialog = await screen.findByRole('dialog', { name: '새 오답노트' });
    await user.type(within(dialog).getByRole('textbox'), '단원평가 오답');
    await user.click(within(dialog).getByRole('button', { name: '만들기' }));

    expect(await screen.findByRole('treeitem', { name: /단원평가 오답/ })).toBeInTheDocument();
  }, 30_000);

  it('노트를 클릭하면 중앙에 항목 목록(비어 있음)이 뜬다', async () => {
    const user = await openWorkspace();
    await user.click(screen.getByRole('tab', { name: '오답노트' }));
    // 루트 폴더(이현우)는 자동으로 펼쳐져 있어 노트가 바로 보인다.
    await user.click(await screen.findByRole('treeitem', { name: /중간고사 오답/ }));

    expect(await screen.findByText('아직 담긴 오답이 없습니다')).toBeInTheDocument();
    expect(useWorkspace.getState().openKind).toBe('note');
  }, 30_000);

  it('오답노트에 담고 나면 항목·원본 바로가기가 보인다', async () => {
    const user = await openWorkspace();
    // 먼저 시험지에서 3번을 담는다.
    await openSampleFile(user);
    await user.click(screen.getByRole('button', { name: '3번 문제' }));
    // [오답노트에 담기] 는 담기 모드로 들어가는 버튼이다. 보고 있던 문항이
    // 미리 골라지므로 곧바로 확정 버튼을 누르면 된다.
    await user.click(await screen.findByRole('button', { name: '오답노트에 담기' }));
    await user.click(await screen.findByRole('button', { name: '1개 담기' }));
    const pickDialog = await screen.findByRole('dialog', { name: /오답노트에 담기/ });
    // 노트 목록은 비동기로 불러온다. 노트는 체크박스로 고르고 확인을 눌러 담는다
    // (여러 노트에 한 번에 담을 수 있다).
    await user.click(await within(pickDialog).findByRole('checkbox', { name: /중간고사 오답/ }));
    await user.click(within(pickDialog).getByRole('button', { name: '담기' }));

    // 오답노트 섹션에서 그 노트를 연다.
    await user.click(screen.getByRole('tab', { name: '오답노트' }));
    await user.click(await screen.findByRole('treeitem', { name: /중간고사 오답/ }));

    expect(await screen.findByText('3번')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '원본 바로가기' })).toBeEnabled();
    expect(screen.getByText(/풍문고/)).toBeInTheDocument();
  }, 45_000);
});

describe('워크스페이스 화면 (목 모드)', () => {
  it('구독이 가능한 데스크톱 환경에서는 온보딩 없이 3분할 화면을 보여준다', async () => {
    await openWorkspace();

    expect(screen.getByRole('tree', { name: '시험지 폴더 트리' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /전체 문제풀이/ })).toBeInTheDocument();
    expect(screen.getByText('왼쪽에서 시험지를 선택하세요')).toBeInTheDocument();
    expect(screen.getByText('구독 모드 · API 요금 청구 없음')).toBeInTheDocument();
  });

  it('기본 공급자는 구독이고, 과금 안내는 뜨지 않는다', async () => {
    await openWorkspace();

    const providerSelect = screen.getByLabelText('공급자 선택');
    expect(providerSelect).toHaveValue('subscription');
    expect(useWorkspace.getState().provider).toBe('subscription');
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByText(/사용량만큼 요금이 청구됩니다/)).toBeNull();
  });

  it('공급자를 API 키로 바꾸면 문항당/전체 예상 금액 안내가 뜬다', async () => {
    const user = await openWorkspace();
    await openSampleFile(user);

    await user.selectOptions(screen.getByLabelText('공급자 선택'), 'apikey');

    const notice = await screen.findByRole('note');
    expect(within(notice).getByText(/사용량만큼 요금이 청구됩니다/)).toBeInTheDocument();
    // Opus 5 기준 문항당 약 ₩51, 22문항 약 ₩1,132 (실측 기반 추정)
    expect(notice.textContent).toMatch(/문항당 약\s*₩51/);
    expect(notice.textContent).toMatch(/22문항 전체 약\s*₩1,13\d/);
    // 정확한 청구액처럼 보이지 않게 추정임을 밝힌다.
    expect(within(notice).getByText(/실측 기반 추정/)).toBeInTheDocument();
    // 구독과의 대비도 함께 알린다.
    expect(notice.textContent).toMatch(/구독 모드로 바꾸면 API 요금 청구가 없습니다/);
    expect(notice.textContent).toMatch(/사용량 한도를 소비/);
  });

  it('모델을 바꾸면 예상 금액도 따라 바뀐다', async () => {
    const user = await openWorkspace();
    await openSampleFile(user);
    await user.selectOptions(screen.getByLabelText('공급자 선택'), 'apikey');

    const before = (await screen.findByRole('note')).textContent ?? '';
    await user.selectOptions(screen.getByLabelText('모델 선택'), 'claude-haiku-4-5');
    const after = (await screen.findByRole('note')).textContent ?? '';

    expect(after).not.toBe(before);
    expect(after).toContain('Claude Haiku 4.5');
  });

  it('파일을 고르지 않았으면 전체 예상 금액은 생략하고 문항당만 보여준다', async () => {
    const user = await openWorkspace();
    await user.selectOptions(screen.getByLabelText('공급자 선택'), 'apikey');

    const notice = await screen.findByRole('note');
    expect(notice.textContent).toMatch(/문항당 약/);
    expect(notice.textContent).not.toMatch(/전체 약/);
  });

  it('채팅에 "6번"만 써도 그 문항이 함께 첨부된다', async () => {
    const user = await openWorkspace();
    await openSampleFile(user);

    const input = await screen.findByPlaceholderText(/질문을 입력하세요/);
    await user.type(input, '6번 문제에 이상한 점이 없어?');

    // 보내기 전에 무엇이 첨부되는지 알려 준다.
    expect(screen.getByText('6번 문항을 함께 보냅니다')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '전송' }));
    await waitFor(() => expect(useWorkspace.getState().chatSending).toBe(false), {
      timeout: 30_000,
    });

    // 사용자/AI 메시지 모두 6번 태그가 붙는다.
    const messages = useWorkspace.getState().messages;
    expect(messages[0]?.problemNo).toBe(6);
    expect(messages[1]?.problemNo).toBe(6);
    expect(screen.getAllByText('· 6번').length).toBeGreaterThanOrEqual(1);
    // 목 백엔드가 problem_no 를 받았는지 응답 내용으로 확인한다.
    expect(messages[1]?.content).toContain('6번 문제');
  }, 60_000);

  it('문항을 직접 클릭해 골랐으면 문장 속 번호보다 그것을 우선한다', async () => {
    const user = await openWorkspace();
    await openSampleFile(user);

    await user.click(await screen.findByRole('button', { name: '3번 문제' }));
    const input = await screen.findByPlaceholderText(/질문을 입력하세요/);
    await user.type(input, '6번이랑 비교해서 설명해줘');

    // 이미 3번이 걸려 있으므로 감지 안내는 뜨지 않는다.
    expect(screen.queryByText('6번 문항을 함께 보냅니다')).toBeNull();

    await user.click(screen.getByRole('button', { name: '전송' }));
    await waitFor(() => expect(useWorkspace.getState().chatSending).toBe(false), {
      timeout: 30_000,
    });
    expect(useWorkspace.getState().messages[0]?.problemNo).toBe(3);
  }, 60_000);

  it('오탐 문장("3단계", "[3점]")에는 문항을 첨부하지 않는다', async () => {
    const user = await openWorkspace();
    await openSampleFile(user);

    const input = await screen.findByPlaceholderText(/질문을 입력하세요/);
    // user-event 에서 '[' 는 수정자 문법이라 '[[' 로 이스케이프한다.
    await user.type(input, '3단계까지 이해했는데 [[3점] 문항 기준이 뭐야?');
    expect((input as HTMLTextAreaElement).value).toBe('3단계까지 이해했는데 [3점] 문항 기준이 뭐야?');
    expect(screen.queryByText(/문항을 함께 보냅니다/)).toBeNull();

    await user.click(screen.getByRole('button', { name: '전송' }));
    await waitFor(() => expect(useWorkspace.getState().chatSending).toBe(false), {
      timeout: 30_000,
    });
    expect(useWorkspace.getState().messages[0]?.problemNo).toBeNull();
  }, 60_000);

  it('업로드 위치를 하단에 표시하고, 기본은 최상위다', async () => {
    await openWorkspace();
    expect(screen.getByText('업로드 위치')).toBeInTheDocument();
    expect(screen.getByText('→ 최상위')).toBeInTheDocument();
    expect(screen.getByText(/폴더를 클릭하면 그 안에 만듭니다/)).toBeInTheDocument();
  });

  it('업로드 안내 문구가 좌측 패널 하단에 보인다', async () => {
    const user = await openWorkspace();
    expect(screen.getByText(/문항만 있는 PDF/)).toBeInTheDocument();

    // 오답노트 섹션은 PDF 업로드 대상이 아니라 안내를 걸지 않는다.
    await user.click(screen.getByRole('tab', { name: '오답노트' }));
    await screen.findByRole('treeitem', { name: /이현우/ });
    expect(screen.queryByText(/문항만 있는 PDF/)).toBeNull();
  }, 15_000);

  it('폴더를 클릭하면 업로드 위치가 그 폴더로 바뀐다', async () => {
    const user = await openWorkspace();

    await user.click(screen.getByRole('treeitem', { name: /공통수학1/ }));
    expect(await screen.findByText('→ 공통수학1')).toBeInTheDocument();
    expect(useWorkspace.getState().focusedNodeId).toBe('folder-common1');

    // 다른 폴더를 누르면 대상도 따라간다.
    await user.click(screen.getByRole('treeitem', { name: /미적분/ }));
    expect(await screen.findByText('→ 미적분')).toBeInTheDocument();
  });

  it('파일을 클릭하면 그 파일이 든 폴더가 업로드 위치가 된다', async () => {
    const user = await openWorkspace();
    await openSampleFile(user);
    // 파일은 공통수학1 안에 있다.
    expect(await screen.findByText('→ 공통수학1')).toBeInTheDocument();
  });

  it('하단 [+ 파일 업로드] 는 표시된 폴더로 올린다', async () => {
    const user = await openWorkspace();
    await user.click(screen.getByRole('treeitem', { name: /미적분/ }));
    await screen.findByText('→ 미적분');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    // 파일 선택 다이얼로그는 열 수 없으므로, 버튼을 눌러 대상이 정해진 뒤 change 를 발생시킨다.
    await user.click(screen.getByRole('button', { name: '+ 파일 업로드' }));
    await user.upload(input, new File(['%PDF-1.4'], '기말고사.pdf', { type: 'application/pdf' }));

    // 이제 곧장 올리지 않고 위치를 확인받는다. 추론한 폴더가 미리 골라져 있으므로 그대로 확정한다.
    await screen.findByText('"기말고사.pdf" 을(를) 어디에 올릴까요?');
    await user.click(screen.getByRole('button', { name: '업로드' }));

    await waitFor(() => expect(useWorkspace.getState().pendingOp).toBeNull(), { timeout: 15_000 });

    const uploaded = useWorkspace
      .getState()
      .nodes.find((node) => node.name === '기말고사.pdf');
    expect(uploaded?.parent_id).toBe('folder-calculus');
    // 토스트가 어느 폴더에 넣었는지 알려 주고, 답안지 혼입 안내를 함께 붙인다.
    expect(useWorkspace.getState().toast?.message).toBe('미적분 에 1개 업로드했습니다.');
    expect(useWorkspace.getState().toast?.hint).toBe(UPLOAD_NOTICE);
  }, 30_000);

  it('폴더 우클릭 → 파일 업로드도 그 폴더로 올린다', async () => {
    const user = await openWorkspace();

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('treeitem', { name: /모의고사/ }),
    });
    await user.click(await screen.findByRole('menuitem', { name: '파일 업로드' }));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['%PDF-1.4'], '6월모의.pdf', { type: 'application/pdf' }));

    // 우클릭으로 폴더를 지정했어도 한 번 확인한다(그 폴더가 기본으로 골라져 있다).
    await screen.findByText('"6월모의.pdf" 을(를) 어디에 올릴까요?');
    await user.click(screen.getByRole('button', { name: '업로드' }));

    await waitFor(() => expect(useWorkspace.getState().pendingOp).toBeNull(), { timeout: 15_000 });

    const uploaded = useWorkspace.getState().nodes.find((node) => node.name === '6월모의.pdf');
    expect(uploaded?.parent_id).toBe('folder-mock-exam');
  }, 30_000);

  it('업로드 위치 확인 창에서 다른 폴더로 바꿔 올릴 수 있다', async () => {
    const user = await openWorkspace();
    // 추론 대상을 미적분으로 만들어 둔다.
    await user.click(screen.getByRole('treeitem', { name: /미적분/ }));
    await screen.findByText('→ 미적분');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.click(screen.getByRole('button', { name: '+ 파일 업로드' }));
    await user.upload(input, new File(['%PDF-1.4'], '옮겨담기.pdf', { type: 'application/pdf' }));

    // 추론 결과(미적분)가 미리 골라져 있지만, 여기서 모의고사로 바꾼다.
    await screen.findByText('"옮겨담기.pdf" 을(를) 어디에 올릴까요?');
    expect(screen.getByRole('radio', { name: /미적분/ })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /모의고사/ }));
    await user.click(screen.getByRole('button', { name: '업로드' }));

    await waitFor(() => expect(useWorkspace.getState().pendingOp).toBeNull(), { timeout: 15_000 });

    const uploaded = useWorkspace.getState().nodes.find((node) => node.name === '옮겨담기.pdf');
    expect(uploaded?.parent_id).toBe('folder-mock-exam');
  }, 30_000);

  it('업로드 위치 확인 창을 취소하면 올리지 않는다', async () => {
    const user = await openWorkspace();
    const before = useWorkspace.getState().nodes.length;

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.click(screen.getByRole('button', { name: '+ 파일 업로드' }));
    await user.upload(input, new File(['%PDF-1.4'], '안올릴것.pdf', { type: 'application/pdf' }));

    await screen.findByText('"안올릴것.pdf" 을(를) 어디에 올릴까요?');
    await user.click(screen.getByRole('button', { name: '취소' }));

    expect(useWorkspace.getState().nodes).toHaveLength(before);
    expect(
      useWorkspace.getState().nodes.find((node) => node.name === '안올릴것.pdf'),
    ).toBeUndefined();
  }, 30_000);

  it('PDF 가 아닌 파일은 이유를 알려주고 거부한다', async () => {
    await openWorkspace();
    // 파일 선택 창은 accept 속성이 걸러 주지만, 드래그&드롭은 그 필터를 타지 않는다.
    // 그 경로(=스토어 액션)를 직접 검증한다.
    await useWorkspace
      .getState()
      .uploadFiles([new File(['hello'], '메모.txt', { type: 'text/plain' })], null);

    expect(useWorkspace.getState().toast?.kind).toBe('error');
    expect(useWorkspace.getState().toast?.message).toContain('PDF 파일만');
    expect(useWorkspace.getState().nodes.some((node) => node.name === '메모.txt')).toBe(false);
  }, 30_000);

  it('폴더 트리를 중첩해 그리고 접기/펼치기가 동작한다', async () => {
    const user = await openWorkspace();

    const root = screen.getByRole('treeitem', { name: /2026-1학기/ });
    expect(root).toHaveAttribute('aria-level', '1');
    expect(root).toHaveAttribute('aria-expanded', 'true');

    // 루트는 펼쳐져 있으므로 자식 폴더가 보인다.
    const subject = screen.getByRole('treeitem', { name: /공통수학1/ });
    expect(subject).toHaveAttribute('aria-level', '2');
    expect(subject).toHaveAttribute('aria-expanded', 'false');

    // 자식 폴더는 접혀 있으므로 그 안의 파일은 아직 없다.
    expect(screen.queryByRole('treeitem', { name: /풍문고/ })).toBeNull();

    // 펼치기
    await user.click(subject);
    const file = await screen.findByRole('treeitem', { name: /풍문고/ });
    expect(file).toHaveAttribute('aria-level', '3');

    // 다시 접기
    await user.click(subject);
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: /풍문고/ })).toBeNull());

    // 루트도 접으면 하위가 전부 사라진다.
    await user.click(root);
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: /공통수학1/ })).toBeNull());
  });

  it('빈 폴더에는 "비어 있음" 을 표시한다', async () => {
    const user = await openWorkspace();
    await user.click(screen.getByRole('treeitem', { name: /미적분/ }));
    expect(await screen.findByText('비어 있음')).toBeInTheDocument();
  });

  it('파일을 클릭하면 가운데에 문서가 열린다', async () => {
    const user = await openWorkspace();
    await openSampleFile(user);

    // 헤더 = 파일 이름 + 메타
    const heading = await screen.findByRole('heading', {
      name: '[2026-1-1-M][공수1][풍문고].pdf',
    });
    const headerRow = heading.parentElement as HTMLElement;
    expect(within(headerRow).getByText('7쪽')).toBeInTheDocument();
    expect(within(headerRow).getByText('22문항')).toBeInTheDocument();
    expect(within(headerRow).getByText('텍스트 추출')).toBeInTheDocument();
    expect(
      screen.getByText('2026-1학기 / 공통수학1 / [2026-1-1-M][공수1][풍문고].pdf'),
    ).toBeInTheDocument();

    // PDF 탭이 기본이고 뷰어가 붙는다.
    expect(screen.getByTestId('pdf-viewer-stub')).toBeInTheDocument();
    // 문제 번호 목록(22개)이 나온다.
    expect(screen.getByRole('button', { name: '22번 문제' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1번 문제' })).toBeInTheDocument();
  });

  it('문제를 클릭하면 그 문항이 대화 첨부 컨텍스트로 선택된다', async () => {
    const user = await openWorkspace();
    await openSampleFile(user);

    await user.click(await screen.findByRole('button', { name: '7번 문제' }));

    // 전역 대화이지만 문항을 고르면 그 문항이 첨부 컨텍스트로 걸린다.
    expect(useWorkspace.getState().selectedProblemNo).toBe(7);
    // 중앙 패널이 선택을 알린다.
    expect(await screen.findByText('7번 문제가 선택되었습니다.')).toBeInTheDocument();
  });

  it(
    '전체 문제풀이를 누르면 진행률이 오르고 풀이가 화면에 쌓인다',
    async () => {
      const user = await openWorkspace();
      await openSampleFile(user);

      await user.click(screen.getByRole('button', { name: /전체 문제풀이/ }));

      // 중단 버튼으로 전환되고 진행률이 표시된다.
      expect(await screen.findByRole('button', { name: '풀이 중단' })).toBeInTheDocument();
      await screen.findByText(/풀이 중 \d+\/22/, {}, { timeout: 10_000 });

      // 풀이 탭으로 자동 전환된다.
      await waitFor(() => expect(useWorkspace.getState().activeTab).toBe('solutions'));

      // 진행 중에 "생성 중" 배지가 보인다.
      await screen.findByText('생성 중', {}, { timeout: 10_000 });

      // 끝나면 22/22 가 된다.
      await waitFor(
        () => expect(useWorkspace.getState().solve.doneCount).toBe(22),
        { timeout: 90_000 },
      );
      expect(await screen.findByText('완료 22/22')).toBeInTheDocument();
      // 22개 행 모두 "풀이 완료" 배지가 붙는다.
      expect(screen.getAllByText('풀이 완료')).toHaveLength(22);

      // 1번 문제를 펼치면 KaTeX 로 렌더된 풀이가 보인다.
      const firstRow = screen.getByRole('button', { name: '1번 문제 풀이 펼치기' });
      await user.click(firstRow);
      const panel = firstRow.closest('li');
      expect(panel).not.toBeNull();
      await waitFor(() => {
        expect(panel?.querySelector('.katex')).not.toBeNull();
        expect(panel?.querySelector('.katex-display')).not.toBeNull();
      });
      // 마크다운 굵게 표기가 강조로 렌더된다.
      expect(within(panel as HTMLElement).getByText('1단계.').tagName).toBe('STRONG');
    },
    150_000,
  );

  it('채팅을 보내면 사용자 메시지와 AI 응답이 순서대로 표시된다', async () => {
    const user = await openWorkspace();
    await openSampleFile(user);

    const input = await screen.findByPlaceholderText(/질문을 입력하세요/);
    await user.type(input, '3번 문제 풀이 알려줘');
    await user.click(screen.getByRole('button', { name: '전송' }));

    expect(await screen.findByText('3번 문제 풀이 알려줘')).toBeInTheDocument();
    await waitFor(
      () => expect(useWorkspace.getState().chatSending).toBe(false),
      { timeout: 30_000 },
    );
    expect(await screen.findByText(/핵심은/)).toBeInTheDocument();
  }, 60_000);

  it('Shift+Enter 는 줄바꿈, Enter 는 전송이다', async () => {
    const user = await openWorkspace();
    await openSampleFile(user);

    const input = await screen.findByPlaceholderText(/질문을 입력하세요/);
    await user.type(input, '첫 줄{Shift>}{Enter}{/Shift}둘째 줄');
    expect((input as HTMLTextAreaElement).value).toBe('첫 줄\n둘째 줄');
    expect(useWorkspace.getState().messages).toHaveLength(0);

    await user.type(input, '{Enter}');
    await waitFor(() => expect(useWorkspace.getState().messages.length).toBeGreaterThan(0));
    expect(useWorkspace.getState().messages[0]?.content).toBe('첫 줄\n둘째 줄');
  }, 30_000);

  it('폴더 삭제 시 하위가 모두 지워진다는 경고와 함께 확인을 받는다', async () => {
    const user = await openWorkspace();

    const root = screen.getByRole('treeitem', { name: /2026-1학기/ });
    await user.pointer({ keys: '[MouseRight]', target: root });

    await user.click(await screen.findByRole('menuitem', { name: '삭제' }));

    const dialog = await screen.findByRole('dialog', { name: '삭제 확인' });
    expect(within(dialog).getByText(/모두 함께 삭제/)).toBeInTheDocument();
    expect(within(dialog).getByText(/하위 폴더 2개와 파일 1/)).toBeInTheDocument();
    expect(within(dialog).getByText('이 작업은 되돌릴 수 없습니다.')).toBeInTheDocument();

    // 취소하면 아무것도 지워지지 않는다.
    await user.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(screen.getByRole('treeitem', { name: /2026-1학기/ })).toBeInTheDocument();

    // 다시 열어 삭제를 확정한다.
    await user.pointer({ keys: '[MouseRight]', target: root });
    await user.click(await screen.findByRole('menuitem', { name: '삭제' }));
    const dialog2 = await screen.findByRole('dialog', { name: '삭제 확인' });
    await user.click(within(dialog2).getByRole('button', { name: '삭제' }));

    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: /2026-1학기/ })).toBeNull(),
    );
  }, 30_000);

  it('왼쪽 메뉴를 접으면 트리가 숨고, 재열기 버튼으로 다시 펼친다', async () => {
    const user = await openWorkspace();

    // 처음엔 트리가 보인다.
    expect(screen.getByRole('tree', { name: '시험지 폴더 트리' })).toBeInTheDocument();

    // 접기: 트리가 사라지고 접힘 상태가 저장된다.
    await user.click(screen.getByRole('button', { name: '왼쪽 메뉴 접기' }));
    await waitFor(() =>
      expect(screen.queryByRole('tree', { name: '시험지 폴더 트리' })).toBeNull(),
    );
    expect(useWorkspace.getState().leftCollapsed).toBe(true);

    // 재열기 바가 남는다.
    const reopen = screen.getByRole('button', { name: '왼쪽 메뉴 펼치기' });
    expect(reopen).toHaveAttribute('aria-expanded', 'false');

    // 펼치기: 트리가 다시 보인다.
    await user.click(reopen);
    expect(await screen.findByRole('tree', { name: '시험지 폴더 트리' })).toBeInTheDocument();
    expect(useWorkspace.getState().leftCollapsed).toBe(false);
  });

  it('우측 프롬프트 패널을 접으면 숨고, 재열기 버튼으로 다시 펼친다', async () => {
    const user = await openWorkspace();

    // 우측 패널 내용(전체 문제풀이 버튼)이 보인다.
    expect(screen.getByRole('button', { name: /전체 문제풀이/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '프롬프트 패널 접기' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /전체 문제풀이/ })).toBeNull(),
    );
    expect(useWorkspace.getState().rightCollapsed).toBe(true);

    const reopen = screen.getByRole('button', { name: '프롬프트 패널 펼치기' });
    expect(reopen).toHaveAttribute('aria-expanded', 'false');

    await user.click(reopen);
    expect(await screen.findByRole('button', { name: /전체 문제풀이/ })).toBeInTheDocument();
    expect(useWorkspace.getState().rightCollapsed).toBe(false);
  });

  it('컨텍스트 메뉴로 새 폴더를 만든다', async () => {
    const user = await openWorkspace();

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('treeitem', { name: /모의고사/ }),
    });
    await user.click(await screen.findByRole('menuitem', { name: '새 폴더' }));

    const dialog = await screen.findByRole('dialog', { name: '새 폴더' });
    await user.type(within(dialog).getByRole('textbox'), '9월');
    await user.click(within(dialog).getByRole('button', { name: '만들기' }));

    expect(await screen.findByRole('treeitem', { name: /9월/ })).toBeInTheDocument();
  }, 30_000);
});
