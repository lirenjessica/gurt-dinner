# Gurt Dinner — handoff notes

Context for picking this project up in a fresh session.
Last substantive work: late July 2026.

## What it is

React + Vite app. Spin four wheels (protein / veggie / carb / cuisine) → Gemini
generates 2 dinner recipes → shopping list → cooking steps → rate it at the end.

- **Live:** https://gurtdinner.vercel.app
- **Local folder:** `C:\Users\LirenTruong\gurt-dinner`
- **GitHub:** https://github.com/lirenjessica/gurt-dinner (public)
- **Vercel project:** `gurt-dinner` (owner `lirenjessica`, team `dinner-s-projects`).
  Renamed from `gurt-dinner-olfx` on 19 Sep 2026, so preview URLs from before
  that date no longer resolve.
- **Supabase project ref:** `kjiapkmuwfnnooayvbwd`

## Architecture — read this before changing the AI call

The Gemini API key is **server-side only**. The browser never sees it.

```
Browser (public)                     Server (secret)
src/App.jsx  ──POST /api/recipes──▶  api/recipes.js
  sends ingredient names only          └─ api/_core.js
                                          builds the prompt
             ◀──── recipes ─────         calls Gemini with GEMINI_KEY
src/pantry.js ─────────────────────▶  Supabase (pantry + shopping list)
src/favorites.js ──────────────────▶  Supabase (saved recipes)
```

Two rules that matter:

1. **`GEMINI_KEY` has no `VITE_` prefix — do not add one.** That prefix is what
   tells Vite to bundle a value into browser code. Adding it would leak the key.
   The Supabase vars *do* have the prefix because the browser needs them and the
   anon key is designed to be public.
2. **The client cannot send a raw prompt.** It sends ingredient names, which the
   server validates and length-caps (`normalizeInput`). This stops the endpoint
   being used as a free general-purpose AI proxy. Keep that property.

`vite.config.js` contains a small dev-server plugin that serves `/api/recipes`
locally using the same `api/_core.js`, so plain `npm run dev` works — you do
**not** need `vercel dev`.

## Files

| File | What it does |
|---|---|
| `api/_core.js` | **The prompt lives here** (`buildPrompt`), plus ingredient definitions, the Gemini call, and input validation |
| `api/recipes.js` | Thin Vercel endpoint wrapper |
| `src/App.jsx` | Entire UI — all screens, inline-styled with the `ZEN` palette |
| `src/pantry.js` | Staples / use-soon / shopping list; Supabase REST with localStorage fallback |
| `src/favorites.js` | Saved recipes, same storage pattern |
| `src/feedback.js` | Cook ratings; `feedbackHints()` feeds taste into prompts. **localStorage only** — the browser sends it with each request, so sync isn't needed for it to work |
| `src/index.css` | Deliberately minimal (~26 lines). Don't reintroduce starter CSS here |
| `SETUP.md` | Running, deploying, Supabase SQL |

## Commands

```bash
npm run dev        # app + /api/recipes on http://localhost:5173
npm run build      # production build (run before deploying to catch errors)
vercel             # manual preview deploy (protected, only opens while logged into Vercel)
vercel --prod      # manual production deploy; usually unnecessary, see Deploying
vercel env ls      # check env vars
```

Prompts print to the dev-server terminal on every generation (dev only), which is
the fastest way to tune wording.

## Deploying

Vercel is connected to the GitHub repo, so deploys happen on push:

- Push to `main` and Vercel builds it and publishes to gurtdinner.vercel.app.
- Push any other branch and you get a preview URL instead, protected and only
  openable while logged into Vercel.

Env vars live on the Vercel project, not in the repo, so `GEMINI_KEY` stays
server-side exactly as before. Nothing about the key arrangement changes.

Until 19 Sep 2026 Vercel's production branch was still pointed at `master`, left
over from when that was GitHub's default. Pushes to the working branch did
build, but were filed as previews, so the live site never moved and the
integration looked dead. If pushes stop reaching the live site, check that
setting first: Settings -> Environments -> Production -> Branch Tracking.
Renaming a branch here means changing it in two places, GitHub and that
setting, or every deploy silently becomes a preview again.

`vercel --prod` still works as an escape hatch. Prefer pushing.

## Branches

- `main` — the live one. Vercel publishes whatever lands here.
- Anything else is work in progress. Name it after the thing it does
  (`grocery-list-button`, `fix-bom-in-env`), branch it off `main`, merge it back
  when it works, then delete it. The commits live on in `main`; the branch was
  only a label.

Renamed from `newbranch` on 19 Sep 2026. `master` was renamed to `old` the same
day and both were deleted; neither held anything `main` does not.

## Gotchas that cost real time

- **UTF-8 BOM in `.env`.** Windows editors (Notepad, PowerShell `Set-Content`)
  add three invisible bytes, so Vite parses the variable as `\uFEFFGEMINI_KEY`
  and the value reads as `undefined` — while the file looks perfect. Symptom was
  Gemini returning "API key not valid" with a key that worked fine via curl.
  Check with `file .env` — it should say ASCII, not "with BOM".
- **Gemini free tier: 20 requests/minute** on `gemini-2.5-flash-lite`. Rapid
  testing exhausts it and the app shows a generic error. Space out test calls.
- **The old `master` held nothing unique.** Earlier notes here claimed it had a
  history unrelated to the working branch and could not be merged. That was
  wrong: its only commit, `12814d2`, is the base of `main`'s history, so it was
  a stale bookmark and was deleted on 19 Sep 2026 along with `old`, the name it
  briefly carried. Recorded in case the claim resurfaces somewhere. Work happens
  on `main`, which is GitHub's default branch and Vercel's production branch.
- **CLI deploys mislabel the commit.** `vercel --prod` uploads the local folder,
  not the repo, but tags the deployment with whatever commit you happen to be
  sitting on. So a deployment's listed SHA is not proof of what is actually live,
  and uncommitted work can reach production under a commit that doesn't contain
  it. The 27 July production deploy reads `12814d2` but carries the `74eee87`
  server-side key work, which was committed afterwards. Push rather than deploy
  from the folder and this stops being a problem.

## Prompt design (all in `api/_core.js`)

Decisions made deliberately — check before reverting:

- **Only the 4 selected ingredient definitions are sent**, not all 27. Sending
  every category bloated the prompt and caused the model to drift to the wrong
  protein.
- **Cuisine is a hard constraint** and the definitions say "cooking" not
  "flavors" — "South Asian flavors" was read as licence to return a shepherd's
  pie with curry powder.
- **`responseSchema`** forces all five recipe fields, so half-built recipes
  can't reach the UI.
- **Variety nudges were removed at the user's request.** Temperature 1.1 is the
  only thing spreading results now. If repeat spins feel samey, that's why.
- **Difficulty is sent with its meaning** — `Easy (~20 min, one pan)`. Note
  `DIFF_DETAIL` in `api/_core.js` duplicates `DIFF` in `src/App.jsx`; keep both
  in step.

## Outstanding / optional

- Rotate the Gemini key — it appeared in an old chat transcript. It's
  server-side so the public can't see it, but regenerate at aistudio.google.com
  and update with `vercel env rm GEMINI_KEY production` then `vercel env add`.
- Supabase RLS allows anyone with the URL + anon key to read/write the pantry.
  Both are visible in the browser bundle by design. Fine for a personal list;
  would need Supabase Auth to lock down.
- No allergy / dietary restriction handling anywhere (user declined it).
- Delete merged work branches once they land in `main`. The commits survive the
  branch; the branch was only a label.

## Communication preference

Liren is a beginner coder. Explain in plain language, define jargon, teach the
"why" — but keep it concise. End substantive replies with a short summary:
Key takeaway / Decisions needed / Next steps / What changed.
