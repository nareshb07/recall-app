# Recall — Spaced Repetition Tracker

Stores data permanently in **Supabase** (free Postgres database).

---

## ⚡ Setup in 5 minutes

### Step 1 — Create a free Supabase project
1. Go to [supabase.com](https://supabase.com) → **Start for free** → sign in
2. Click **New project**, give it a name (e.g. `recall`), set a password, pick a region close to you (e.g. Singapore)
3. Wait ~1 min for it to provision

### Step 2 — Create the database table
1. In your Supabase project, click **SQL Editor** in the left sidebar
2. Paste and run this SQL:

```sql
create table topics (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  intervals    integer[],
  start_date   date,
  review_dates date[],
  done_dates   date[] default '{}',
  created_at   timestamptz default now()
);

-- Allow public read/write (fine for personal use)
alter table topics enable row level security;
create policy "Allow all" on topics for all using (true) with check (true);
```

### Step 3 — Get your Supabase credentials
1. Go to **Project Settings** (gear icon) → **API**
2. Copy:
   - **Project URL** → looks like `https://abcdefgh.supabase.co`
   - **anon / public key** → long JWT string

### Step 4 — Add env vars to Vercel
1. In your Vercel project → **Settings** → **Environment Variables**
2. Add:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon key
3. Click **Save**, then go to **Deployments** → **Redeploy**

### Step 5 — Done! 🎉
Your app is live with a permanent database. All topics and review history persist forever.

---

## Local development
```bash
npm install
cp .env.example .env.local
# Fill in your Supabase URL and anon key
npm run dev
```

## Project structure
```
recall-app/
├── src/
│   ├── main.jsx       # React entry
│   ├── App.jsx        # Full app
│   └── supabase.js    # Supabase client
├── index.html
├── package.json
├── vite.config.js
└── vercel.json
```
