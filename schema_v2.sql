-- Campus Market v2. Run this whole file ONCE in Supabase -> SQL Editor, AFTER schema.sql.
-- Adds: settings, admins, profiles, comments, escrow orders (Airtel / TNM), avatar storage.

-- ---------- Settings (editable by admin) ----------
create table if not exists public.settings (key text primary key, value text not null);
insert into public.settings (key, value) values
  ('free_until',  ((now() + interval '2 months')::date)::text),  -- 2 months free from today
  ('fee_percent', '3.5'),
  ('hold_hours',  '48'),     -- how long money is held after BOTH sides confirm
  ('airtel_number',''), ('airtel_name',''),
  ('tnm_number',''),    ('tnm_name','')
on conflict (key) do nothing;

-- ---------- Admins ----------
create table if not exists public.admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.admins enable row level security;  -- no policies: only is_admin() can see it

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;

-- ---------- Profiles ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  user_name     text not null default 'Student' check (char_length(user_name) between 1 and 60),
  business_name text check (char_length(business_name) <= 80),
  location      text check (char_length(location) <= 80),
  avatar_url    text,
  avatar_path   text,
  updated_at    timestamptz not null default now()
);
insert into public.profiles (id, user_name)
  select id, coalesce(nullif(left(raw_user_meta_data->>'full_name', 60), ''), 'Student') from auth.users
on conflict (id) do nothing;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, user_name)
  values (new.id, coalesce(nullif(left(new.raw_user_meta_data->>'full_name', 60), ''), 'Student'))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
create policy "profiles are public" on public.profiles for select using (true);
create policy "own profile insert" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "own profile update" on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ---------- Comments ----------
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists comments_listing_idx on public.comments (listing_id, created_at);
alter table public.comments enable row level security;
create policy "comments are public" on public.comments for select using (true);
create policy "users comment" on public.comments for insert to authenticated with check (auth.uid() = user_id);
create policy "delete own or admin comment" on public.comments for delete to authenticated
  using (auth.uid() = user_id or public.is_admin());

-- ---------- Listings: new 'reserved' status + admin powers ----------
alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings add constraint listings_status_check check (status in ('available','reserved','sold'));

-- owners cannot touch a listing while money is held for it
drop policy if exists "owner updates listing" on public.listings;
create policy "owner updates listing" on public.listings for update to authenticated
  using (auth.uid() = seller_id and status <> 'reserved')
  with check (auth.uid() = seller_id and status in ('available','sold'));
drop policy if exists "owner deletes listing" on public.listings;
create policy "owner deletes listing" on public.listings for delete to authenticated
  using (auth.uid() = seller_id and status <> 'reserved');
create policy "admin deletes listing" on public.listings for delete to authenticated using (public.is_admin());
create policy "admin reads reports" on public.reports for select to authenticated using (public.is_admin());

-- ---------- Settings + admin policies ----------
alter table public.settings enable row level security;
create policy "settings are public" on public.settings for select using (true);
create policy "admin writes settings" on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- Orders (escrow) ----------
-- Clients can only READ orders. Every change goes through the functions below,
-- so nobody can edit amounts, fees or statuses from the browser.
create table if not exists public.orders (
  id                  uuid primary key default gen_random_uuid(),
  listing_id          uuid references public.listings(id) on delete set null,
  listing_title       text not null,
  buyer_id            uuid not null references auth.users(id),
  seller_id           uuid not null references auth.users(id),
  amount              numeric(12,2) not null,
  fee_percent         numeric(5,2)  not null,
  fee_amount          numeric(12,2) not null,
  seller_payout       numeric(12,2) not null,
  method              text not null check (method in ('airtel','tnm')),
  status              text not null default 'awaiting_payment' check (status in
    ('awaiting_payment','payment_submitted','held','confirmed','released','refunded','disputed','cancelled')),
  payer_phone         text,
  payment_ref         text,
  funds_received_at   timestamptz,
  buyer_confirmed_at  timestamptz,
  seller_confirmed_at timestamptz,
  release_after       timestamptz,
  released_at         timestamptz,
  payout_ref          text,
  admin_note          text,
  created_at          timestamptz not null default now()
);
alter table public.orders enable row level security;
create policy "parties and admin read orders" on public.orders for select to authenticated
  using (auth.uid() in (buyer_id, seller_id) or public.is_admin());

-- Fee is 0 during the free period, then the configured percent.
create or replace function public.fee_percent_now() returns numeric
language sql stable security definer set search_path = public as $$
  select case when now() < ((select value from public.settings where key = 'free_until')::date + 1)
              then 0::numeric
              else (select value from public.settings where key = 'fee_percent')::numeric end
$$;

create or replace function public.create_order(p_listing uuid, p_method text) returns uuid
language plpgsql security definer set search_path = public as $$
declare l public.listings; pct numeric; fee numeric; oid uuid;
begin
  if auth.uid() is null then raise exception 'Log in first'; end if;
  if p_method not in ('airtel','tnm') then raise exception 'Choose Airtel Money or TNM Mpamba'; end if;
  select * into l from public.listings where id = p_listing for update;
  if not found or l.status <> 'available' then raise exception 'This item is no longer available'; end if;
  if l.seller_id = auth.uid() then raise exception 'You cannot buy your own item'; end if;
  pct := public.fee_percent_now();
  fee := round(l.price * pct / 100, 2);
  insert into public.orders (listing_id, listing_title, buyer_id, seller_id, amount, fee_percent, fee_amount, seller_payout, method)
  values (l.id, l.title, auth.uid(), l.seller_id, l.price, pct, fee, l.price - fee, p_method)
  returning id into oid;
  update public.listings set status = 'reserved' where id = l.id;
  return oid;
end $$;

create or replace function public.submit_payment(p_order uuid, p_phone text, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if char_length(p_phone) not between 5 and 20 or char_length(p_ref) not between 4 and 60 then
    raise exception 'Enter the phone you paid from and the transaction ID';
  end if;
  update public.orders set payer_phone = p_phone, payment_ref = p_ref, status = 'payment_submitted'
   where id = p_order and buyer_id = auth.uid() and status = 'awaiting_payment';
  if not found then raise exception 'Order cannot accept payment now'; end if;
end $$;

create or replace function public.cancel_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  update public.orders set status = 'cancelled'
   where id = p_order and buyer_id = auth.uid() and status = 'awaiting_payment' returning * into o;
  if not found then raise exception 'Only unpaid orders can be cancelled'; end if;
  update public.listings set status = 'available' where id = o.listing_id;
end $$;

-- Frees items whose buyer never paid within 24 hours (the site calls this when it loads).
create or replace function public.expire_unpaid_orders() returns void
language plpgsql security definer set search_path = public as $$
begin
  with x as (
    update public.orders set status = 'cancelled'
     where status = 'awaiting_payment' and created_at < now() - interval '24 hours'
    returning listing_id)
  update public.listings set status = 'available' where id in (select listing_id from x) and status = 'reserved';
end $$;

-- Buyer and seller each confirm; when both have, the hold timer starts.
create or replace function public.confirm_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.orders set
    buyer_confirmed_at  = case when buyer_id  = auth.uid() then coalesce(buyer_confirmed_at,  now()) else buyer_confirmed_at  end,
    seller_confirmed_at = case when seller_id = auth.uid() then coalesce(seller_confirmed_at, now()) else seller_confirmed_at end
   where id = p_order and status = 'held' and auth.uid() in (buyer_id, seller_id);
  if not found then raise exception 'Order cannot be confirmed now'; end if;
  update public.orders set status = 'confirmed',
         release_after = now() + (select value from public.settings where key = 'hold_hours')::numeric * interval '1 hour'
   where id = p_order and status = 'held' and buyer_confirmed_at is not null and seller_confirmed_at is not null;
end $$;

create or replace function public.dispute_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.orders set status = 'disputed'
   where id = p_order and status in ('held','confirmed') and auth.uid() in (buyer_id, seller_id);
  if not found then raise exception 'Order cannot be disputed now'; end if;
end $$;

-- Admin actions: received | reject | release | refund
create or replace function public.admin_order_action(p_order uuid, p_action text, p_text text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;

  if p_action = 'received' and o.status = 'payment_submitted' then
    update public.orders set status = 'held', funds_received_at = now(), admin_note = p_text where id = o.id;
  elsif p_action = 'reject' and o.status = 'payment_submitted' then
    update public.orders set status = 'awaiting_payment', admin_note = p_text where id = o.id;
  elsif p_action = 'release' and (o.status = 'disputed' or (o.status = 'confirmed' and now() >= o.release_after)) then
    update public.orders set status = 'released', released_at = now(), payout_ref = p_text where id = o.id;
    update public.listings set status = 'sold' where id = o.listing_id;
  elsif p_action = 'refund' and o.status in ('held','confirmed','disputed') then
    update public.orders set status = 'refunded', admin_note = p_text where id = o.id;
    update public.listings set status = 'available' where id = o.listing_id;
  else
    raise exception 'Action "%" is not allowed while order is "%"', p_action, o.status;
  end if;
end $$;

-- ---------- Avatar storage ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy "anyone can view avatars" on storage.objects for select using (bucket_id = 'avatars');
create policy "users upload own avatar" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users delete own avatar" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Make yourself admin (sign up on the site first, then run this with YOUR email) ----------
insert into public.admins (user_id) select id from auth.users where email = 'danmontonf9@gmail.com';
