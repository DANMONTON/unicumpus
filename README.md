# Campus Market

A standalone student marketplace: sign up, post items with photos, browse and search, contact sellers on WhatsApp, report bad listings.

Stack: plain HTML/CSS/JS + Supabase (auth, database, image storage). No build step.

## Setup (about 10 minutes)

1. **Create a Supabase project** at supabase.com (a free project works).
2. **Run the database setup:** Supabase dashboard -> SQL Editor -> New query -> paste all of `schema.sql` -> Run.
3. **Add your keys:** Project Settings -> API. Copy the Project URL and the `anon` public key into `config.js`. Set `CURRENCY` and (optional) `ALLOWED_EMAIL_DOMAIN`.
4. **Auth settings:** Authentication -> Providers -> Email is on by default. Keep "Confirm email" on so only real emails can sign up.
5. **Test locally:** open the folder with VS Code Live Server (or run `python3 -m http.server` in this folder) and visit the page. Opening `index.html` directly by double-click can also work, but a local server is more reliable.
6. **Put it online:** drag the folder onto Netlify, or push to GitHub and enable GitHub Pages / Vercel. Then add your live URL under Authentication -> URL Configuration -> Site URL so confirmation emails link back correctly.

## How it protects users

- Row-level security: students can only edit or delete their own listings.
- Seller phone numbers are stored in a separate table that only logged-in users can read, so scrapers can't harvest them.
- Image uploads are limited to JPG/PNG/WebP, 10 MB, inside the uploader's own folder.
- All listing text is escaped before display (prevents script injection / XSS).
- Reports can be filed by users but only read by you in the Supabase dashboard (Table Editor -> reports).

## Ideas for the next version

- Seller ratings and a "wanted" board
- Multiple photos per listing
- Admin page to review reports and hide listings
- Saved/favorite items

## Version 2: profiles, comments, escrow payments, admin

1. In Supabase -> SQL Editor, run `schema_v2.sql` once (after `schema.sql`).
2. Sign up on your site, then run the last line of `schema_v2.sql` (uncomment it, use your email) to make yourself admin.
3. Open `admin.html` while logged in. Settings tab: enter your Airtel Money and TNM Mpamba numbers and names, the fee % and the hold hours. The free period defaults to 2 months from the day you ran the SQL.

How a sale works: buyer creates an order -> sends money to your Airtel/TNM number and enters the transaction ID -> you check your mobile money account and press "Money received" -> buyer and seller meet and both confirm -> after the hold hours you send the seller (price minus fee) and press "Release". Payouts and refunds are sent by you manually from your mobile money account.
