import { redirect } from 'next/navigation';
import { readSession } from '@/lib/auth';

export default async function Home() {
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type === 'coach') redirect('/coach');
  if (!user.active) redirect('/deactivated');
  redirect('/today');
}
