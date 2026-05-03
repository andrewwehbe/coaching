import Link from 'next/link';

import { requireCoach } from '@/lib/coach-guard';
import { NewClientForm } from './new-client-form';

export default async function NewClientPage() {
  await requireCoach();
  return (
    <main className="flex flex-1 flex-col px-5 py-7 max-w-md w-full mx-auto">
      <Link href="/coach" className="text-sm text-muted hover:text-text transition-colors">
        ← All clients
      </Link>
      <header className="mt-3 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Add client</h1>
      </header>
      <NewClientForm />
    </main>
  );
}
