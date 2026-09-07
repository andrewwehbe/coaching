import { redirect } from 'next/navigation';

/**
 * Editing moved into the client page as the "Edit program" tab, so the plan
 * and the editor no longer live at different URLs. This route stays as a
 * redirect rather than a 404 because it's linked from older notes and from
 * anything the coach bookmarked.
 */
type Params = Promise<{ id: string }>;

export default async function EditProgramRedirect(props: { params: Params }) {
  const { id } = await props.params;
  redirect(`/coach/clients/${id}?tab=edit`);
}
