import { redirect } from 'next/navigation';
import { readSession } from '@/lib/auth';
import { LogoutButton } from '@/components/logout-button';

export default async function CoachHome() {
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type !== 'coach') redirect('/today');

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-3xl w-full mx-auto">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Coach dashboard</h1>
        <LogoutButton />
      </header>
      <p className="text-neutral-400">Hi {user.name}. Dashboard lands in M3.</p>
    </main>
  );
}
