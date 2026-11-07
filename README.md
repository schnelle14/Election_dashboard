# NZ Election 2026 – Electorate results dashboard

A self-updating dashboard of the electorate results published by RNZ at
<https://www.rnz.co.nz/news/election-2026-results/electorates>.

- **Leading candidate and margin** for all 71 electorates
- **Party summary**: electorates led or won, by party (click a bar to filter the table)
- **% of votes counted** per electorate, plus summary tiles (average counted, close races, closest race)
- **Search and filters**: by electorate or candidate name, by party, or All / Key / Māori / Close (< 1,000 votes)
- Highlights rows that changed since the last refresh and tags electorates whose leading party changed while the page was open

## How it works

```
RNZ page ──(every 2 min)──> GitHub Action ──commit──> docs/data/electorates.json ──> GitHub Pages (docs/)
                            scraper/scrape.py                                       page re-checks every 2 min
```

- `scraper/scrape.py` downloads the RNZ page and reads the structured data that
  RNZ's Next.js page embeds. If that format changes, it falls back to parsing
  the HTML table. It uses only the Python standard library. It refuses to
  overwrite good data with a partial scrape (fewer than 60 electorates).
- `scraper/run_loop.sh` runs the scraper every 2 minutes and commits only when
  the results actually change.
- `.github/workflows/scrape.yml` runs that loop. GitHub's cron schedule can't
  run more often than every 5 minutes, so each run loops for about 58 minutes,
  and an hourly schedule queues the next run. The result is continuous 2-minute
  updates.
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
