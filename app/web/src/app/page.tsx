import { Workspace } from '@/components/Workspace';

/**
 * 정적 export(Tauri) 전제이므로 이 페이지는 셸만 렌더한다.
 * 실제 데이터는 백엔드가 로컬/서버에서 뜬 뒤 클라이언트에서 가져온다.
 */
export default function Page() {
  return <Workspace />;
}
