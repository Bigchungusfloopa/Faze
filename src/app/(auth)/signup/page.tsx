"use client"

import { useState, useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, Eye, EyeOff } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"

const signupSchema = z.object({
  name: z.string().min(2, { message: "Name must be at least 2 characters" }),
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(8, { message: "Password must be at least 8 characters" }),
})

type SignupFormValues = z.infer<typeof signupSchema>

export default function SignupPage() {
  const [isLoading, setIsLoading] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const form = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: "", email: "", password: "" },
  })

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const email = params.get('email')
    if (email) form.setValue("email", email)
  }, [form])

  async function onSubmit(data: SignupFormValues) {
    setIsLoading(true)
    setErrorText(null)
    
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      setErrorText((await res.json().catch(() => null))?.error ?? "Could not create account.")
      setIsLoading(false)
      return
    }

    const { error } = await supabase.auth.signInWithPassword({ email: data.email, password: data.password })
    if (error) {
      setErrorText(error.message)
      setIsLoading(false)
      return
    }
    router.replace("/research")
  }

  return (
    <div className="glass-card p-7 rounded-3xl">
      <div className="mb-8">
        <h2 className="font-heading font-bold text-[28px] text-foreground mb-2">Create Account</h2>
        <p className="font-sans text-[16px] text-muted-foreground">Start asking your documents questions.</p>
      </div>

      <div className="space-y-6">
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Full Name</Label>
          <Input 
            id="name" 
            placeholder="John Doe" 
            {...form.register("name")}
            className={form.formState.errors.name ? "border-[#FF3B30]" : ""}
          />
          {form.formState.errors.name && (
            <p className="font-sans text-[14px] text-[#FF3B30]">{form.formState.errors.name.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email address</Label>
          <Input 
            id="email" 
            placeholder="you@example.com" 
            {...form.register("email")}
            className={form.formState.errors.email ? "border-[#FF3B30]" : ""}
          />
          {form.formState.errors.email && (
            <p className="font-sans text-[14px] text-[#FF3B30]">{form.formState.errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input 
              id="password" 
              type={showPassword ? "text" : "password"} 
              placeholder="Min. 8 characters" 
              {...form.register("password")}
              className={form.formState.errors.password ? "border-[#FF3B30] pr-10" : "pr-10"}
            />
            <button 
              type="button" 
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          </div>
          {form.formState.errors.password && (
            <p className="font-sans text-[14px] text-[#FF3B30]">{form.formState.errors.password.message}</p>
          )}
        </div>

        {errorText && (
          <div className="bg-[#FF3B30] text-white p-3 rounded-[12px] text-[14px] font-sans">
            {errorText}
          </div>
        )}

        <Button type="submit" className="w-full mt-2" disabled={isLoading}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create account
        </Button>
      </form>
      </div>

      <div className="mt-8 text-center font-sans text-[14px] text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="text-foreground font-bold hover:underline">
          Log in
        </Link>
      </div>
    </div>
  )
}
