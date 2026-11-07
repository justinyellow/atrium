import { useState } from 'react';
import { post, queryClient } from '../lib/api';
import { useUserMap } from '../lib/hooks';
import type { Page, VerificationValue } from '../lib/types';
import { Popover, toast } from '../components/ui';
import { VerificationBadge, VerificationControls } from './newprops';
import { fmtDate, verificationState } from './dbutil';

export async function setPageVerification(pageId: string, body: { state: 'verified' | 'unverified' | null; until?: string | null }) {
  try {
    await post(`/pages/${pageId}/verification`, body);
    queryClient.invalidateQueries({ queryKey: ['page', pageId] });
    toast(body.state === 'verified' ? 'Page verified' : body.state === 'unverified' ? 'Marked as unverified' : 'Verification removed');
  } catch (e: any) {
    toast(e.message);
  }
}

/** "Verified" badge under a page title (Notion wiki verification). Full-access users can (re-)verify. */
export function PageVerification({ page }: { page: Page }) {
  const users = useUserMap();
  const [el, setEl] = useState<HTMLElement | null>(null);
  const v = page.props?.__verification as VerificationValue | undefined;
  const state = verificationState(v);
  if (!state) return null;
  const canManage = page.level === 'full';
  const by = v?.by ? users.get(v.by)?.name : null;
  return (
    <div className="page-verification">
      <button className={`verif-badge verif-${state}`} disabled={!canManage} onClick={(e) => setEl(e.currentTarget)} aria-haspopup={canManage ? 'menu' : undefined}>
        <VerificationBadge value={v} users={users} />
      </button>
      <span>
        {state === 'verified' && <>{by ? `by ${by}` : ''}{v?.until ? ` · until ${fmtDate(v.until.slice(0, 10))}` : ''}</>}
        {state === 'expired' && <>Verification expired{v?.until ? ` ${fmtDate(v.until.slice(0, 10))}` : ''}{canManage ? ' — re-verify to confirm it is still accurate' : ''}</>}
      </span>
      {el && (
        <Popover anchor={el} open onClose={() => setEl(null)} width={250}>
          <VerificationControls value={v}
            onSet={async ({ state: s, until }) => { setEl(null); await setPageVerification(page.id, { state: s, until: until ?? null }); }}
            onClear={async () => { setEl(null); await setPageVerification(page.id, { state: null }); }} />
        </Popover>
      )}
    </div>
  );
}

/** Page ⋯ menu entry: opens the verify popover. */
export function VerifyMenuSection({ page, anchor, onDone }: { page: Page; anchor: HTMLElement | null; onDone: () => void }) {
  const v = page.props?.__verification as VerificationValue | undefined;
  return (
    <Popover anchor={anchor} open onClose={onDone} placement="bottom-end" width={250}>
      <VerificationControls value={v}
        onSet={async ({ state, until }) => { onDone(); await setPageVerification(page.id, { state, until: until ?? null }); }}
        onClear={v ? async () => { onDone(); await setPageVerification(page.id, { state: null }); } : undefined} />
    </Popover>
  );
}
