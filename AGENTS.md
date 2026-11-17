# AGENTS.md

Guidance for AI coding agents working in this repo. People should read
[`README.md`](README.md) first; this file adds what an agent needs on top.

## What this repo is

The locus website (live at https://locus-ai.tech) and its live product demo.

| Folder | What | Stack |
|---|---|---|
| `prototype/` | The website: landing page with a 3D pond, `/check` estimator, `/demo` page | Vite multi-page app, plain JS modules, hand-written CSS, three.js. Cloudflare Pages + Pages Functions + D1 |
| `demo/worker/` | Demo backend: checks, approval agent, spend caps, Vast.ai provisioning, teardown, chat proxy | Cloudflare Worker, Workflows, D1, vitest in workerd |
| `demo/instance/` | What runs on the rented GPU machine: image, start script, benchmark | Bash, Docker, ik_llama.cpp / llama.cpp |
| `brand/`, `mockups/` | Logo files, early designs | Not deployed. Leave alone unless asked |

How the demo parts connect, and the two contracts between them:
[`demo/README.md`](demo/README.md).

## Commands

Run from the folder named. Node 20 or newer.

```bash
# prototype/
npm install
npm run dev          # http://localhost:5173, with a pretend /api/demo backend
npm run build        # must pass before every commit that touches prototype/
npm run cf:dev       # build + Cloudflare's local runner (closest to live)

# demo/worker/
npm install
npm test             # 76+ tests in workerd; must pass before every commit here
npm run check        # bundles the Worker without deploying
npm run dev          # wrangler dev; copy dev.vars.example to .dev.vars first (DEV_FAKES=1)

# demo/instance/
for f in *.sh; do bash -n "$f"; done   # and shellcheck *.sh if you have it
```

There is no CI. The checks above are the only gate, so run them.

## Working rules

- **Small, atomic commits.** One logical change per commit, checks passing at
  each, and a message that says why, not only what.
- **Stage by path** (`git add <paths>`, `git commit -- <paths>`), never
  `git add -A` or `git add .`. Several people and agents work in this checkout
  and in parallel branches.
- **Branch and open a pull request** for anything beyond a typo. Changes reach
  `main` through PRs (see the history).
- **Keep to the folder you were asked about.** A site task does not need
  edits in `demo/worker/`, and the other way round, unless a contract changes.
- **Change a contract on both sides in the same PR**: the `/api/demo/*`
  routes (Worker, page and `prototype/dev/demo-api.js`), or the machine env
  variables (`demo/worker/src/provision.js` and `demo/instance/onstart.sh`).
- **Keep docs in step.** If you change a command, route, env variable, config
  var or file location, update the README that lists it in the same commit.
- **Don't add dependencies** without a reason you can state in the commit
  message. The site has four runtime packages on purpose.

## Site style

- Plain HTML, JS modules and CSS. No framework, no Tailwind, no TypeScript.
- Reuse the tokens in `prototype/src/style.css` and the patterns in
  `check.html` / `src/check.css` (`.wrap`, `.step`, `.field`, `.btn`, `.label`).
- Colour rules: pink (`--pink`) only for actions; gold (`--gold`) only for
  "AI" in the headline; `--error` for mistakes so they never look like actions.
  Dark theme only.
- Copy is short and plain, written for a non-technical buyer. The product name
  is always lowercase: "locus".
- A new page must be added to `rollupOptions.input` in `prototype/vite.config.js`.
- Check new UI at phone width (375px) with no sideways scroll.

## Safety and cost

- **Ask before deploying.** `npm run deploy` (site) and `wrangler deploy`
  (Worker) go live immediately; there is no staging.
- **Ask before renting a machine on Vast.ai.** Rentals bill by the hour. When
  you rent one, destroy it when done (`vastai destroy instance <id> -y`; the
  `-y` matters, without it the command silently does nothing in a script) and
  confirm with `vastai show instances` that none are left.
- **Never commit secrets.** They go in `.dev.vars` (git-ignored) locally and
  `wrangler secret put` in production. The full list is in
  `demo/worker/README.md`.
- **Don't touch production data.** No writes to the remote D1 database
  (`locus-leads`) or remote migrations without being asked.
- **Model output and visitor input are untrusted.** The chat page renders
  model output through DOMPurify with no images allowed; keep it that way.
- **The approval agent is not the safety boundary.** Hard checks and spend caps
  are enforced in code (`demo/worker/src/decide.js`, `src/caps.js`). Never let
  a model decision override them, and keep fetched web pages marked as
  untrusted data in the prompt.

## Facts that are easy to get wrong

- The model is `Qwen/Qwen3.8-Flash-Next`, run from
  `unsloth/Qwen3.8-Flash-Next-GGUF`. Plain "Qwen3.8-Flash" is a different,
  API-only model.
- Only llama.cpp-family runtimes can run it on one consumer GPU. The chosen
  setup and the measured speeds are in `demo/BENCHMARK.md`; don't change
  runtime flags without re-measuring.
- On Vast.ai, a single-GPU rental gets a slice of the host: `cpu_ram` and
  `cpu_cores_effective` are already the slice, and `cpu_ram` is in MB in the
  REST API.
- Per-demo hostnames are one level below the zone
  (`locus-demo-<id>.locus-ai.tech`). Cloudflare's free certificate does not
  cover deeper subdomains.
