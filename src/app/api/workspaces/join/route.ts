import { NextResponse } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";

/** Join an existing workspace by name + shared password. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const name = (body?.name as string | undefined)?.trim();
  const password = body?.password as string | undefined;

  if (!name || !password) {
    return NextResponse.json({ error: "name and password are required." }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("join_workspace", { p_name: name, p_password: password });

  if (error) {
    // join_workspace() raises a plain, user-facing message for "no such
    // workspace" and "wrong password" -- pass it straight through.
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ data: data?.[0] });
}
