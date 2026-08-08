'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { useWorkspace } from '@/store/workspace';

/**
 * 전역(파일 무관) 자유 대화 목록 (ChatGPT식).
 *
 * - "+ 새 대화": 활성 대화를 비운다(실제 생성은 첫 전송 시).
 * - 목록 클릭 → 그 대화로 전환(메시지 복원).
 * - 제목 클릭(✎) → 이름 변경(인라인 입력).
 * - × → 대화 삭제.
 * - 활성 대화는 파란색으로 강조한다.
 */
export function ConversationList() {
  const conversations = useWorkspace((state) => state.conversations);
  const activeConversationId = useWorkspace((state) => state.activeConversationId);
  const openConversation = useWorkspace((state) => state.openConversation);
  const newConversation = useWorkspace((state) => state.newConversation);
  const renameConversation = useWorkspace((state) => state.renameConversation);
  const deleteConversation = useWorkspace((state) => state.deleteConversation);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  const startEdit = (id: string, title: string) => {
    setEditingId(id);
    setDraftTitle(title);
  };

  const commitEdit = () => {
    if (editingId != null && draftTitle.trim() !== '') {
      void renameConversation(editingId, draftTitle);
    }
    setEditingId(null);
    setDraftTitle('');
  };

  return (
    <div className="border-b border-slate-200 bg-slate-50">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="shrink-0 text-[11px] font-medium text-slate-500">대화</span>
        <button
          type="button"
          onClick={newConversation}
          className="ml-auto rounded border border-blue-300 bg-white px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:border-blue-400 hover:bg-blue-50"
        >
          + 새 대화
        </button>
      </div>

      {conversations.length === 0 ? (
        <p className="px-3 pb-1.5 text-[11px] text-slate-400">
          {activeConversationId == null
            ? '새 대화를 시작하세요. 첫 메시지를 보내면 대화가 만들어집니다.'
            : '대화가 시작되었습니다.'}
        </p>
      ) : (
        <ul className="max-h-40 overflow-y-auto px-2 pb-1.5">
          {conversations.map((conversation) => {
            const active = activeConversationId === conversation.id;
            const editing = editingId === conversation.id;
            return (
              <li key={conversation.id}>
                <div
                  className={clsx(
                    'group flex items-center gap-1 rounded px-2 py-1 text-[12px]',
                    active
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-700 hover:bg-blue-50',
                  )}
                >
                  {editing ? (
                    <input
                      autoFocus
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitEdit();
                        }
                        if (event.key === 'Escape') {
                          setEditingId(null);
                          setDraftTitle('');
                        }
                      }}
                      aria-label="대화 이름"
                      className="min-w-0 flex-1 rounded border border-slate-300 px-1 py-0.5 text-[12px] text-slate-800 outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => void openConversation(conversation.id)}
                      aria-pressed={active}
                      title={conversation.preview ?? conversation.title}
                      className="min-w-0 flex-1 truncate text-left"
                    >
                      {conversation.title}
                    </button>
                  )}

                  {!editing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(conversation.id, conversation.title)}
                        aria-label={`${conversation.title} 이름 변경`}
                        title="이름 변경"
                        className={clsx(
                          'shrink-0 rounded px-1 text-[11px] leading-none',
                          active
                            ? 'text-blue-100 hover:bg-blue-500'
                            : 'text-slate-400 hover:bg-slate-200',
                        )}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteConversation(conversation.id)}
                        aria-label={`${conversation.title} 삭제`}
                        title="삭제"
                        className={clsx(
                          'shrink-0 rounded px-1 text-[13px] leading-none',
                          active
                            ? 'text-blue-100 hover:bg-blue-500'
                            : 'text-slate-400 hover:bg-slate-200',
                        )}
                      >
                        ×
                      </button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
