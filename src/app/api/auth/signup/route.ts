import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Creates an already-confirmed account, so signing up needs no confirmation
 * email. The client signs in with the same credentials right after. This is
 * the one pre-auth route that touches the admin client, so it accepts nothing
 * beyond name/email/password and validates all three.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (name.length < 2 || name.length > 100) {
    return NextResponse.json({ error: "Name must be 2–100 characters." }, { status: 400 });
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: "Invalid email address." }, { status: 400 });
  }
  if (password.length < 8 || password.length > 72) {
    return NextResponse.json({ error: "Password must be 8–72 characters." }, { status: 400 });
  }

  const { error } = await createAdminClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });

  if (error) {
    if (error.code === "email_exists" || /already been registered/i.test(error.message)) {
      return NextResponse.json({ error: "An account with this email already exists. Log in instead." }, { status: 409 });
    }
    console.error("signup createUser failed:", error.message);
    return NextResponse.json({ error: "Could not create account. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
