-- Conversations belong to the scope they were asked in (personal or one
-- workspace), so the chat sidebar can list only the current scope's history
-- and a thread can never continue under a different scope's corpus.
alter table public.conversations
  add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;

create index if not exists conversations_owner_scope_idx
  on public.conversations (owner_id, workspace_id, updated_at desc);
