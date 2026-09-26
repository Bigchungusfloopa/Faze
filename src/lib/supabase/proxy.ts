import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  // Next.js 16 requirement: use asynchronous cookie handling
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )

          supabaseResponse = NextResponse.next({
            request,
          })

          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // getClaims(). getClaims() still refreshes an expired session (and writes
  // the new cookies via setAll), but verifies the JWT locally against the
  // cached signing key instead of a network call to Auth on every request.
  const { data: claimsData } = await supabase.auth.getClaims()
  const user = claimsData?.claims?.sub ? { id: claimsData.claims.sub } : null

  const pathname = request.nextUrl.pathname

  // Every /api/ route used to be public by default here, relying on each
  // individual route handler to call getUser() itself. That is a full data
  // leak the moment one route forgets to -- as api/vault/debug/route.ts did.
  // Protected by default now; only the auth callback and signup need to be
  // reachable before a session exists.
  const isPublicRoute =
    pathname === '/' ||
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/reset' ||
    pathname === '/api/auth/callback' ||
    pathname === '/api/auth/signup'

  if (!user && !isPublicRoute) {
    // Unauthenticated users attempting to access the root / or any other 
    // root/app route are redirected to /login
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}
