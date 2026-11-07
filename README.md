# NZ Election 2026 – Electorate results dashboard

A self-updating dashboard of the electorate results published by RNZ at
<https://www.rnz.co.nz/news/election-2026-results/electorates>.

- **Seats in Parliament**: projected seats per party from the party vote (electorate + list),
  a seat strip with the majority line, outgoing government vs opposition blocs (plus a possible opposition + Opportunity bloc), and party-vote %
- **Leading candidate and margin** for all 71 electorates
- **Party summary**: electorates led or won, by party (click a bar to filter the table)
- **% of votes counted** per electorate, plus summary tiles (average counted, close races, closest race)
- **Search and filters**: by electorate or candidate name, by party, or All / Key / Māori / Close
- **Close races** scale with the count: a lead is *close* if it is under
  `300 + 5% × votes still to count` (assuming ~35,000 votes per electorate),
  so about 2,050 votes at 0% counted, 1,175 at 50%, and 300 at 100% (an
  allowance for special votes counted later). Tune `CLOSE_SWING`,
  `CLOSE_FLOOR` and `EST_VOTES_PER_ELECTORATE` in `docs/app.js`.
- **Key** electorates are RNZ's own selection of seats to watch
- **Feels live**: bars glide and numbers roll to new values, changes flash green/red,
  cards rise in on load, a pulsing LIVE pill and a countdown ring show the next check,
  and a "New results" toast appears when data changes (all motion is off for
  viewers with *reduce motion* set)
- Highlights rows that changed since the last refresh and tags electorates whose leading party changed while the page was open

## How it works

```
RNZ pages ─(every 2 min)─> GitHub Action ──commit──> docs/data/*.json ──────────> GitHub Pages (docs/)
                            scraper/scrape.py                                       page re-checks every 2 min
```

- `scraper/scrape.py` downloads two RNZ pages, the electorates page
  (→ `docs/data/electorates.json`) and the results front page with party vote
  and projected seats (→ `docs/data/parliament.json`), and reads the
  structured data that RNZ's Next.js pages embed. If that format changes, it falls back to parsing
  the HTML table. It uses only the Python standard library. It refuses to
  overwrite good data with a partial scrape (fewer than 60 electorates).
- `scraper/run_loop.sh` runs the scraper every 2 minutes and commits only when
  the results actually change.
- `.github/workflows/scrape.yml` runs that loop. GitHub's cron schedule can't
  run more often than every 5 minutes and is often late or skipped, so each run
  loops for up to ~5h50m (jobs are capped at 6h). When a run hits that limit
  while results are still changing, it starts the next run itself; the hourly
  schedule is only a backup. A run that goes idle (no changes for 30 min) or
  keeps failing stops without restarting.
- `docs/` is the static dashboard (`index.html`, `app.js`, `style.css`). It
  fetches `data/electorates.json` every 2 minutes, bypassing the cache.

## Setup

1. **Merge this into the default branch (`main`).** GitHub runs scheduled workflows only from the default branch.
2. **Enable GitHub Pages:** *Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/docs`*.
3. **Allow the workflow to push:** *Settings → Actions → General → Workflow permissions → Read and write permissions*.
4. **Start it now** rather than waiting for the hourly schedule: *Actions → Scrape RNZ electorate results → Run workflow*.

> **Private repository?** GitHub Pages for private repos needs a paid plan
> (Pro, Team or Enterprise), and the published site is public unless you're on
> Enterprise. Actions minutes also count against your quota. Running
> continuously costs about 60 minutes per hour, and the free plan includes
> 2,000 minutes a month. Making the repo public removes both limits.

## Stopping and tuning

- **Stop scraping:** set the repository variable `SCRAPE_ENABLED` to `false`
  (*Settings → Secrets and variables → Actions → Variables*), or disable the workflow.
- **Idle cut-off:** a run stops early after 30 minutes with no changes (set the
  repository variable `IDLE_MINUTES` to change this, or to `0` to never stop early).
- **Manual run:** *Run workflow* accepts a duration (up to about 350 minutes) and an interval.

## Run locally

```bash
python3 scraper/scrape.py                 # one scrape -> docs/data/electorates.json
PUSH=0 bash scraper/run_loop.sh           # loop every 2 min without committing
python3 -m http.server -d docs 8000       # open http://localhost:8000
```

Exit codes from `scrape.py`: `0` = data changed, `3` = no change, `1` = error.

Data © RNZ. Results are preliminary until the Electoral Commission declares them official.
