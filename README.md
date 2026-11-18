# locus website

The website for locus: a landing page with a 3D lotus pond, a "Check your server" page that estimates which AI model a company's server could run, and a live demo on a real rented server.

Live at https://locus-ai.tech

## Folders

| Folder | What is inside |
|---|---|
| `prototype/` | The website. Everything below happens here. |
| `brand/` | Logo files and the scripts that made them. |
| `demo/` | The live demo's backend (a Cloudflare Worker) and the scripts for the rented GPU machine. See [`demo/README.md`](demo/README.md). |
| `mockups/` | Early static page designs. Not part of the live site. |

## Run it on your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
cd prototype
npm install
npm run dev
```

Open http://localhost:5173. The page reloads when you save a file.

## Where things are

| File | What it does |
|---|---|
| `index.html`, `src/style.css` | Landing page text and styles |
| `src/world.js` | The 3D pond: camera, scrolling, quality levels |
| `src/lotus.js`, `src/water.js`, `src/story.js` | The flower, the water, the "How it works" animation |
| `src/art.js` | Two illustrated versions of the pond (see below) |
| `check.html`, `src/check.js`, `src/check.css` | The "Check your server" page |
| `src/check-data.js` | Servers, graphics cards, models and prices offered on that page |
| `src/estimate.js` | The formula behind the estimate |
| `functions/api/lead.js` | Saves the email when someone asks for an estimate |
| `demo.html`, `src/demo.js`, `src/demo.css` | The live demo page: request form, progress, chat |
| `functions/api/demo/[[path]].js` | Passes `/api/demo/*` on to the demo Worker in `demo/worker/` |
| `dev/demo-api.js` | A pretend demo backend for `npm run dev`, so the page works with no Worker |

Prices and models in `check-data.js` are from November 2026. Review them before relying on them again.

## Useful addresses while testing

| Address | What you get |
|---|---|
| `/check` | The "Check your server" page |
| `/?art=ink` | Pond drawn as an illustration on the dark page |
| `/?art=paper` | Pond drawn as a watercolour on light paper |
| `/?q=0` to `/?q=4` | Fix the 3D quality level (0 is best, 4 is lightest) |
| `/lotus.html` | The lotus alone, for working on it |
| `/demo?demo=ready` | The demo chat, against the pretend backend (dev only; the bar under the footer switches between the other states) |
| `/demo?demo=ready&models=0` | The same chat as on a single-model box: no Auto / Deep / Fast picker |

When you test the form locally, emails are saved in `prototype/.leads.dev.jsonl`. Git ignores this file.

## Cloudflare

The site runs on Cloudflare Pages, in a project called `locus`. Emails go to a Cloudflare D1 database called `locus-leads`. Both are set in `prototype/wrangler.jsonc`.

**Publish your changes** (from `prototype/`):

```bash
npm run deploy
```

This builds the site and uploads it. It is live after about a minute.

**Read the collected emails:**

```bash
npm run leads
```

**First time on a new computer**, log in once:

```bash
npx wrangler login
```

**Test with Cloudflare's own local runner** (optional, closest to the live site):

```bash
npm run cf:dev
```

**Undo a bad deploy:** in the Cloudflare dashboard, open Workers & Pages, then `locus`, then Deployments. Pick an earlier one and choose "Rollback to this deployment".

## Before you commit

Check the site locally, deploy, then commit:

```bash
git add -A
git commit -m "what you changed"
git push
```

`node_modules/` and `dist/` are not in git. `npm install` and `npm run build` create them again.
