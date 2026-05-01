import Link from 'next/link';

import { requireCoach } from '@/lib/coach-guard';
import { NewClientForm } from './new-client-form';

export default async function NewClientPage() {
  await requireCoach();
  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <header className="mb-6">
        <Link href="/coach" className="text-sm text-muted hover:text-text transition-colors">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-2">Add client</h1>
      </header>
      <NewClientForm />
    </main>
  );
}
