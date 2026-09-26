import { NextResponse } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";

/** Workspaces the caller is a member of. RLS (workspaces_select) already scopes this to membership. */
export async function GET() {
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("workspace_members")
    .select("role, joined_at, workspaces(id, name, created_at)")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: false });

  if (error) {
    console.error("workspaces list error:", error);
    return NextResponse.json({ error: "Failed to list workspaces." }, { status: 500 });
  }

  return NextResponse.json({ data });
}

/** Create a new workspace. The caller becomes its owner. */
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

  const { data, error } = await supabase.rpc("create_workspace", { p_name: name, p_password: password });

  if (error) {
    // Postgres reports the unique-name collision as a generic duplicate-key
    // error; give the caller something they can actually act on.
    const message = error.code === "23505" ? `A workspace named "${name}" already exists.` : error.message;
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json({ data: data?.[0] });
}
