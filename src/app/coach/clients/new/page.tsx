import Link from 'next/link';

import { requireCoach } from '@/lib/coach-guard';
import { NewClientForm } from './new-client-form';

export default async function NewClientPage() {
  await requireCoach();
  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <header className="mb-6">
        <Link href="/coach" className="text-sm text-neutral-400 hover:text-neutral-200">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Add client</h1>
      </header>
      <NewClientForm />
    </main>
  );
}
