import { NextResponse } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";

/** Recent conversations for one scope: personal (no workspaceId) or a single workspace. */
export async function GET(request: Request) {
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get("workspaceId");

  let query = supabase
    .from("conversations")
    .select("id, title, updated_at")
    .eq("owner_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(50);
  query = workspaceId ? query.eq("workspace_id", workspaceId) : query.is("workspace_id", null);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
