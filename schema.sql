-- Campus Market: run this whole file once in Supabase -> SQL Editor.

-- ---------- Tables ----------
create table if not exists public.listings (
  id           uuid primary key default gen_random_uuid(),
  seller_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  seller_name  text not null default 'Student' check (char_length(seller_name) <= 60),
  title        text not null check (char_length(title) between 3 and 100),
  description  text check (char_length(description) <= 1000),
  price        numeric(12,2) not null check (price >= 0),
  category     text not null,
  condition    text not null,
  image_url    text,
  image_path   text,
  status       text not null default 'available' check (status in ('available','sold')),
  created_at   timestamptz not null default now()
);

-- Seller contact lives in its own table so only logged-in students can read it
-- (keeps phone numbers away from anonymous scrapers).
create table if not exists public.contacts (
  listing_id uuid primary key references public.listings(id) on delete cascade,
  contact    text not null check (char_length(contact) between 5 and 120)
);

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.listings(id) on delete cascade,
  reporter_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  reason      text not null check (char_length(reason) between 3 and 300),
  created_at  timestamptz not null default now()
);

create index if not exists listings_created_idx on public.listings (created_at desc);
create index if not exists listings_category_idx on public.listings (category);

-- ---------- Row Level Security ----------
alter table public.listings enable row level security;
alter table public.contacts enable row level security;
alter table public.reports  enable row level security;

-- listings: anyone can browse; only the owner can write
create policy "listings are public" on public.listings
  for select using (true);
create policy "owner inserts listing" on public.listings
  for insert to authenticated with check (auth.uid() = seller_id);
create policy "owner updates listing" on public.listings
  for update to authenticated using (auth.uid() = seller_id) with check (auth.uid() = seller_id);
create policy "owner deletes listing" on public.listings
  for delete to authenticated using (auth.uid() = seller_id);

-- contacts: logged-in users can read; only the listing owner can add/change
create policy "logged-in users read contacts" on public.contacts
  for select to authenticated using (true);
create policy "owner adds contact" on public.contacts
  for insert to authenticated
  with check (exists (select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid()));
create policy "owner updates contact" on public.contacts
  for update to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_id and l.seller_id = auth.uid()));

-- reports: logged-in users can file; nobody can read them from the website
-- (read them in the Supabase dashboard as admin)
create policy "users file reports" on public.reports
  for insert to authenticated with check (auth.uid() = reporter_id);

-- ---------- Image storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-images', 'listing-images', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy "anyone can view listing images" on storage.objects
  for select using (bucket_id = 'listing-images');
create policy "users upload to their own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'listing-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users delete their own images" on storage.objects
  for delete to authenticated
  using (bucket_id = 'listing-images' and (storage.foldername(name))[1] = auth.uid()::text);
