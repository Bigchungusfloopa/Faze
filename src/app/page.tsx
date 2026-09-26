import Link from "next/link"
import { redirect } from "next/navigation"
import { FileText } from "lucide-react"
import { createClient, getAuthUser } from "@/lib/supabase/server"

const VIDEO_URL =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4"

export default async function HomePage() {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (user) redirect("/research")

  return (
    <div className="page-shell h-dvh items-center px-4 py-6 text-white">
      <video className="page-video-bg" autoPlay muted loop playsInline>
        <source src={VIDEO_URL} type="video/mp4" />
      </video>
      <div className="page-video-scrim" />

      <header className="flex w-full max-w-3xl items-center justify-center gap-4">
        <div className="grid h-11 w-11 place-items-center rounded-full bg-white text-black">
          <FileText size={20} />
        </div>
        <nav className="flex h-11 flex-1 max-w-md items-center justify-around rounded-full bg-white px-2 text-sm font-medium text-neutral-800">
          <Link href="/">Home</Link>
          <Link href="/research" className="opacity-60 hover:opacity-100">Chat</Link>
        </nav>
        <Link href="/login" className="flex h-11 items-center rounded-full bg-neutral-800 px-5 text-sm font-medium text-neutral-200 hover:bg-neutral-700">
          Sign in
        </Link>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center text-center">
        <h1 className="font-heading text-5xl font-semibold tracking-tight sm:text-7xl anim" style={{ ["--d" as string]: "0.1s" }}>
          Document<br />Intelligence
        </h1>
        <p className="mt-5 max-w-lg text-base text-neutral-300 anim" style={{ ["--d" as string]: "0.25s" }}>
          Upload PDFs, scans, tables and images. Ask questions and get answers grounded in your documents, with page-level citations — or a plain &quot;not in your documents.&quot;
        </p>
        <Link
          href="/research"
          className="mt-8 rounded-full bg-white px-7 py-3 text-sm font-semibold text-neutral-900 shadow-[0_0_30px_rgba(255,255,255,0.3)] transition hover:-translate-y-0.5 anim"
          style={{ ["--d" as string]: "0.4s" }}
        >
          Get Started
        </Link>
      </main>

      <footer className="grid w-full max-w-2xl grid-cols-3 gap-4 text-center">
        {[
          ["Hybrid", "Vector + keyword search"],
          ["Cited", "Source, page & section"],
          ["Grounded", "Abstains when unsure"],
        ].map(([v, l]) => (
          <div key={v}>
            <div className="font-heading text-xl">{v}</div>
            <div className="text-xs text-neutral-400">{l}</div>
          </div>
        ))}
      </footer>
    </div>
  )
}
