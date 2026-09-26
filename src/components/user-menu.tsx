"use client"

import { useState, useRef, useEffect } from "react"
import { createClient } from "@/lib/supabase/client"
import { logout } from "@/actions/auth"
import { LogOut } from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"

interface UserProfile {
  name: string | null
  email: string | null
  avatarUrl: string | null
}

export default function UserMenu() {
  const [open, setOpen] = useState(false)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      const meta = user.user_metadata ?? {}
      setProfile({
        name: meta.name ?? meta.full_name ?? null,
        email: user.email ?? null,
        avatarUrl: meta.avatar_url ?? null,
      })
    })
  }, [])

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener("mousedown", handleOutsideClick)
    return () => document.removeEventListener("mousedown", handleOutsideClick)
  }, [open])

  const handleLogout = async () => {
    setIsLoggingOut(true)
    await logout()
  }

  const label = profile?.name || profile?.email || ""
  const initials = label
    ? label.split(/[\s@.]+/).filter(Boolean).map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : "ME"

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-white/20 bg-white p-0 text-[12px] font-semibold text-black"
        suppressHydrationWarning
        aria-label="User menu"
        aria-expanded={open}
      >
        {profile?.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={profile.avatarUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <span className="leading-none">{initials}</span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="glass-strong absolute right-0 top-[calc(100%+8px)] z-[100] w-[230px] overflow-hidden rounded-2xl border border-white/10"
          >
            <div className="border-b border-white/10 px-4 py-3">
              <p className="truncate text-sm font-medium text-white">{profile?.name ?? profile?.email ?? "Loading…"}</p>
              {profile?.name && <p className="mt-0.5 truncate text-[11px] text-white/50">{profile.email}</p>}
            </div>
            <button
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-red-400 transition-colors hover:bg-red-500/15 disabled:opacity-50"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              {isLoggingOut ? "Signing out…" : "Log out"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
