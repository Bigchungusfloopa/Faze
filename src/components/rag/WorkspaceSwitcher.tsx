"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Users, Plus, LogIn } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { useWorkspaces } from "@/hooks/useWorkspaces"

const PERSONAL_VALUE = "__personal__"

export interface WorkspaceScope {
  workspaceId: string | null
  name: string
}

export function WorkspaceSwitcher({
  scope,
  onScopeChange,
}: {
  scope: WorkspaceScope
  onScopeChange: (scope: WorkspaceScope) => void
}) {
  const { data: workspaces = [], create, join } = useWorkspaces()
  const [dialog, setDialog] = useState<"create" | "join" | null>(null)
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")

  const closeDialog = () => {
    setDialog(null)
    setName("")
    setPassword("")
  }

  const handleSelect = (value: string) => {
    if (value === "__create__") return setDialog("create")
    if (value === "__join__") return setDialog("join")
    if (value === PERSONAL_VALUE) return onScopeChange({ workspaceId: null, name: "Personal" })
    const ws = workspaces.find((w) => w.id === value)
    if (ws) onScopeChange({ workspaceId: ws.id, name: ws.name })
  }

  const handleCreate = () => {
    create.mutate(
      { name, password },
      {
        onSuccess: (data) => {
          toast.success(`Workspace "${data.name}" created.`)
          onScopeChange({ workspaceId: data.id, name: data.name })
          closeDialog()
        },
        onError: (e: Error) => toast.error(e.message),
      }
    )
  }

  const handleJoin = () => {
    join.mutate(
      { name, password },
      {
        onSuccess: (data) => {
          toast.success(`Joined "${data.name}".`)
          onScopeChange({ workspaceId: data.id, name: data.name })
          closeDialog()
        },
        onError: (e: Error) => toast.error(e.message),
      }
    )
  }

  return (
    <>
      <Select value={scope.workspaceId ?? PERSONAL_VALUE} onValueChange={handleSelect}>
        <SelectTrigger className="w-full rounded-xl border border-white/12 bg-white/[0.05] text-sm font-medium">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-xl border border-white/10 bg-[#141416]">
          <SelectItem value={PERSONAL_VALUE} className="font-medium">Personal</SelectItem>
          {workspaces.map((w) => (
            <SelectItem key={w.id} value={w.id} className="font-medium">
              <span className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5" /> {w.name}
              </span>
            </SelectItem>
          ))}
          <SelectItem value="__create__" className="font-bold text-white">
            <span className="flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> Create workspace</span>
          </SelectItem>
          <SelectItem value="__join__" className="font-bold text-white">
            <span className="flex items-center gap-1.5"><LogIn className="w-3.5 h-3.5" /> Join workspace</span>
          </SelectItem>
        </SelectContent>
      </Select>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="rounded-3xl border border-white/10 bg-[#111113]/95 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="font-heading font-semibold text-xl">
              {dialog === "create" ? "Create a workspace" : "Join a workspace"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Workspace name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. cs305-study-group" />
            </div>
            <div className="space-y-1.5">
              <Label>{dialog === "create" ? "Set a password" : "Password"}</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Shared with anyone who should join" />
              {dialog === "create" && (
                <p className="text-xs text-muted-foreground">
                  Anyone with this name and password can join. Every document any member uploads here becomes visible
                  and searchable to everyone in the workspace.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={dialog === "create" ? handleCreate : handleJoin}
              disabled={!name.trim() || !password || create.isPending || join.isPending}
              className="font-heading font-bold"
            >
              {dialog === "create" ? "Create" : "Join"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
