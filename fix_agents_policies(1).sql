-- Run ONCE in Supabase > SQL Editor, AFTER schema_v2.sql (it defines is_admin()).
-- Your housing site and the marketplace share one Supabase project, so every student
-- who signs up on the marketplace is an "authenticated" user there. The housing
-- agents rules I gave you earlier allowed ANY authenticated user to edit agents.
-- This limits agent add/edit/delete and agent photos to admins only.

drop policy if exists "agents admin write" on public.agents;
create policy "agents admin write" on public.agents
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "agent photos admin write" on storage.objects;
create policy "agent photos admin write" on storage.objects
  for all to authenticated
  using (bucket_id = 'agent-photos' and public.is_admin())
  with check (bucket_id = 'agent-photos' and public.is_admin());
