import { notFound } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { PageHeader } from '../../../ui';
import { ProfileForm } from './profile-form';

type Params = Promise<{ id: string }>;

export const dynamic = 'force-dynamic';

export default async function ProfilePage(props: { params: Params }) {
  await requireCoach();
  const { id } = await props.params;
  const supa = db();

  const { data: client } = await supa
    .from('clients')
    .select('id, name, training_age, primary_goal, equipment, exercise_blacklist')
    .eq('id', id)
    .maybeSingle();
  if (!client) notFound();

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <PageHeader
        back={{ href: `/coach/clients/${id}`, label: 'Back to client' }}
        eyebrow="Profile"
        title={client.name}
      />

      <p className="text-sm text-muted mb-6 max-w-prose">
        Inputs the recommender uses to interpret stalls and propose changes.
        Training age gates the swap timing; goal biases the volume/intensity
        branches; equipment constrains swap candidates; the blacklist hard-blocks
        exercises (injuries or hated lifts).
      </p>

      <ProfileForm
        clientId={client.id}
        initial={{
          training_age: client.training_age as
            | 'novice'
            | 'intermediate'
            | 'advanced'
            | null,
          primary_goal: client.primary_goal as
            | 'hypertrophy'
            | 'strength'
            | 'fat_loss'
            | 'general'
            | null,
          equipment: client.equipment as
            | 'full_gym'
            | 'home_gym'
            | 'dumbbells_only'
            | 'bodyweight'
            | null,
          exercise_blacklist: (client.exercise_blacklist ?? []) as string[],
        }}
      />
    </main>
  );
}
