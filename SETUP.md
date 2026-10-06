# Gurt Dinner — Setup

## Running it locally

```bash
npm run dev
```

Then open http://localhost:5173

That's it — `npm run dev` now serves both the app *and* the `/api/recipes`
endpoint, so you don't need `vercel dev` just to test recipes.

---

## Environment variables

Your `.env` file (never committed — it's in `.gitignore`):

```
GEMINI_KEY=your-google-ai-key
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

**Why `GEMINI_KEY` has no `VITE_` prefix:** that prefix is Vite's signal to bundle
a value into the browser code. Anything with it is public. The Gemini key is only
read on the server, so it must NOT have the prefix. The Supabase values *do* have
it because the browser needs them, and Supabase's anon key is designed to be public.

---

## Deploying to Vercel

1. From this folder:
   ```bash
   vercel
   ```
   That gives you a private preview URL to test.

2. Add the environment variables in the Vercel dashboard
   (**Settings → Environment Variables**). Your local `.env` is never uploaded:

   | Name | Value | Needed for |
   |---|---|---|
   | `GEMINI_KEY` | your Google AI key | Recipes (required) |
   | `VITE_SUPABASE_URL` | your Supabase project URL | Pantry sync (optional) |
   | `VITE_SUPABASE_ANON_KEY` | your Supabase anon key | Pantry sync (optional) |

3. Go live:
   ```bash
   vercel --prod
   ```

---

## Pantry sync with Supabase (optional)

Without this, your pantry saves to **one browser only**. Add it to share the same
pantry between your phone and laptop.

### 1. Create the project
- Sign up at [supabase.com](https://supabase.com) (free tier is plenty)
- Create a new project

### 2. Create the table
In your project, open **SQL Editor** and run:

```sql
create table pantry_items (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('staple', 'use_soon')),
  name        text not null,
  created_at  timestamptz not null default now()
);

alter table pantry_items enable row level security;

-- Personal single-user app: allow the anon key to read and write.
-- See the security note below before sharing your URL with anyone.
create policy "anon full access" on pantry_items
  for all to anon using (true) with check (true);
```

### 2a. Allow the "Also need" shopping list

The shopping extras reuse the pantry table with a third kind. If you created the
table before this feature existed, widen the constraint:

```sql
alter table pantry_items drop constraint pantry_items_kind_check;
alter table pantry_items add constraint pantry_items_kind_check
  check (kind in ('staple', 'use_soon', 'shopping'));
```

Until you run this, "Also need" items save to this browser only.

### 2b. Add the favourites table

Saved recipes need a second table. Run this too:

```sql
create table favorite_recipes (
  id          bigint generated always as identity primary key,
  recipe      jsonb not null,
  servings    int,
  created_at  timestamptz not null default now()
);

alter table favorite_recipes enable row level security;

create policy "anon full access" on favorite_recipes
  for all to anon using (true) with check (true);
```

Until you run this, the ♥ Save button still works — favourites just save to
this browser instead of syncing.

### 3. Add the keys
**Settings → API** in Supabase gives you the Project URL and the `anon` `public` key.
Paste both into `.env`, then restart `npm run dev`.

The pantry modal footer tells you which mode you're in:
- `💾 Saved on this device only` — no keys set
- `☁️ Synced across your devices` — keys working

### ⚠️ Security note
The policy above lets **anyone who knows your Supabase URL and anon key** read and
edit your pantry, and both are visible in the browser. For a personal pantry list
that's usually a fine trade. If that bothers you, add Supabase Auth and scope the
policy to `auth.uid()` instead.

---

## How it fits together

```
Browser (public)                    Server (secret)
────────────────                    ───────────────
src/App.jsx      ──POST──────────▶  api/recipes.js
  ingredients + pantry                 └─ api/_core.js
                                          builds the prompt
                 ◀──recipes──────        calls Gemini with GEMINI_KEY
src/pantry.js    ──────────────────▶  Supabase (pantry storage)
```

The browser never sees the Gemini key, and it can't send a raw prompt — it sends
only ingredient names, which the server validates and caps. That stops the endpoint
being used as a free general-purpose AI proxy.

Local dev uses the same `api/_core.js` through a small plugin in `vite.config.js`,
so local and production behave identically.

---

## A note on the name

This project was called dinner-spinner until Sep 2026. The folder and the
Vercel project are now gurt-dinner, and the Supabase project is gurt-apps.

The GitHub repo was NOT renamed. It is still
https://github.com/lirenjessica/dinner-spinner, which is what `git remote -v`
reports and what every push goes to.

Four strings still say `dinner-spinner` on purpose, in `src/pantry.js`,
`src/favorites.js`, `src/feedback.js` and `src/App.jsx`:

```
dinner-spinner-pantry      dinner-spinner-favorites
dinner-spinner-history     dinner-spinner-prefs
```

Those are browser localStorage keys, not names. Renaming them would make
every browser look under a new key, find nothing, and silently lose the
locally saved pantry, favourites, history and preferences on every device
that has them. They are invisible to users, so leave them as they are.
