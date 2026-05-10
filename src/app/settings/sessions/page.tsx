import { redirect } from 'next/navigation';
import Link from 'next/link';
import { cookies } from 'next/headers';

import { readSession, SESSION_COOKIE } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { LogoutButton } from '@/components/logout-button';
import { SessionList } from './session-list';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SessionsPage() {
  const user = await readSession();
  if (!user) redirect('/login');

  const cookieStore = await cookies();
  const currentToken = cookieStore.get(SESSION_COOKIE)?.value ?? null;

  const supa = db();
  const { data: rows } = await supa
    .from('sessions')
    .select('id, created_at, last_used_at, expires_at, last_used_ip, last_used_ua')
    .eq('user_type', user.type)
    .eq('user_id', user.id)
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .order('last_used_at', { ascending: false });

  const sessions = (rows ?? []).map((s) => ({
    id: s.id,
    createdAt: s.created_at,
    lastUsedAt: s.last_used_at,
    expiresAt: s.expires_at,
    lastUsedIp: s.last_used_ip,
    lastUsedUa: s.last_used_ua,
    isCurrent: s.id === currentToken,
  }));

  const homeHref = user.type === 'coach' ? '/coach' : '/today';

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <div className="flex items-center justify-between mb-5">
        <Link href={homeHref} className="text-sm text-muted hover:text-text transition-colors">
          ← Back
        </Link>
        <LogoutButton />
      </div>

      <header className="mb-5">
        <p className="text-[10px] uppercase tracking-[0.22em] text-faint">Sessions</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Active devices</h1>
        <p className="mt-2 text-sm text-muted">
          Anything that doesn&rsquo;t look like one of yours, revoke. The current
          session is highlighted.
        </p>
      </header>

      <SessionList sessions={sessions} />
    </main>
  );
}
