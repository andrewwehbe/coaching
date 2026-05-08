import { requireCoach } from '@/lib/coach-guard';
import { PageHeader } from '../../ui';
import { NewClientForm } from './new-client-form';

export default async function NewClientPage() {
  await requireCoach();
  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-md w-full mx-auto">
      <PageHeader
        back={{ href: '/coach/clients', label: 'All clients' }}
        eyebrow="The roster grows"
        title="Add client"
      />
      <NewClientForm />
    </main>
  );
}
