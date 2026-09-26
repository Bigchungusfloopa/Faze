"use client"

import { useState } from "react"
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

const loginSchema = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(1, { message: "Password is required" }),
})

type LoginFormValues = z.infer<typeof loginSchema>

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  })

  const watchedEmail = form.watch("email")
  const signupUrl = watchedEmail ? `/signup?email=${encodeURIComponent(watchedEmail)}` : "/signup"

  async function onSubmit(data: LoginFormValues) {
    setIsLoading(true)
    setErrorText(null)
    const { error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    })
    
    if (error) {
      setErrorText(error.message)
      setIsLoading(false)
    } else {
      router.replace("/research")
    }
  }


  return (
    <div className="glass-card p-7 rounded-3xl">
      <div className="mb-8">
        <h2 className="font-heading font-bold text-[28px] text-foreground mb-2">Welcome Back</h2>
        <p className="font-sans text-[16px] text-muted-foreground">Sign in to query your documents.</p>
      </div>

      <div className="space-y-6">
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link href="/reset" className="font-mono text-[12px] text-foreground underline hover:text-muted-foreground">
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Input 
                id="password" 
                type={showPassword ? "text" : "password"} 
                placeholder="••••••••" 
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

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Log In
          </Button>
        </form>
      </div>

      <div className="mt-8 text-center font-sans text-[14px] text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link href={signupUrl} className="text-foreground font-bold hover:underline">
          Sign up
        </Link>
      </div>
    </div>
  )
}
