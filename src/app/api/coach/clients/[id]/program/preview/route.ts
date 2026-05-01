import { NextResponse } from 'next/server';

import { readSession } from '@/lib/auth';
import { parseSheet } from '@/lib/sheet-parser';

type Params = Promise<{ id: string }>;

export async function POST(req: Request, ctx: { params: Params }) {
  const user = await readSession();
  if (!user || user.type !== 'coach') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: _clientId } = await ctx.params;

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, errors: [{ row: 0, message: 'No file uploaded.' }] },
      { status: 400 }
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const result = parseSheet(buf);

  if (!result.ok) {
    return NextResponse.json({ ok: false, errors: result.errors });
  }
  return NextResponse.json({
    ok: true,
    program: result.program,
    filename: file.name,
  });
}
