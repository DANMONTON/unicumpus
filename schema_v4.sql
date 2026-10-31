-- Campus Market v4. Run ONCE in Supabase > SQL Editor, after schema_v2.sql and schema_v3.sql.
-- Adds "I want" requests and makes sure everyone (logged in or not) can read listings.

-- 1) Listing kind: 'sell' = item for sale, 'want' = someone is looking for an item
alter table public.listings add column if not exists kind text not null default 'sell';
alter table public.listings drop constraint if exists listings_kind_check;
alter table public.listings add constraint listings_kind_check check (kind in ('sell','want'));
create index if not exists listings_kind_idx on public.listings (kind);

-- 2) Everyone can browse listings, logged in or not (seller contacts stay login-only)
drop policy if exists "listings readable by everyone v4" on public.listings;
create policy "listings readable by everyone v4" on public.listings for select using (true);

-- 3) Only items FOR SALE can be bought with escrow (same function as v2 + one check)
create or replace function public.create_order(p_listing uuid, p_method text) returns uuid
language plpgsql security definer set search_path = public as $$
declare l public.listings; pct numeric; fee numeric; oid uuid;
begin
  if auth.uid() is null then raise exception 'Log in first'; end if;
  if p_method not in ('airtel','tnm') then raise exception 'Choose Airtel Money or TNM Mpamba'; end if;
  select * into l from public.listings where id = p_listing for update;
  if not found or l.status <> 'available' then raise exception 'This item is no longer available'; end if;
  if l.kind <> 'sell' then raise exception 'This is a request, not an item for sale'; end if;
  if l.seller_id = auth.uid() then raise exception 'You cannot buy your own item'; end if;
  pct := public.fee_percent_now();
  fee := round(l.price * pct / 100, 2);
  insert into public.orders (listing_id, listing_title, buyer_id, seller_id, amount, fee_percent, fee_amount, seller_payout, method)
  values (l.id, l.title, auth.uid(), l.seller_id, l.price, pct, fee, l.price - fee, p_method)
  returning id into oid;
  update public.listings set status = 'reserved' where id = l.id;
  return oid;
end $$;
