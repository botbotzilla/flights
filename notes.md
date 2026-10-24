# Flight search: project notes

## Context block
1. **What it is:** A page where Rob sets up flight searches (route, date ranges, passengers, filters). A GitHub Actions job runs them on SerpApi's Google Flights endpoint and saves `results.json`; the page shows it.
2. **Files:** repo `botbotzilla/flights` (public), branch `main`. Entry file `index.html`.
3. **Publishing:** GitHub Pages from `main`, root. Live URL expected at botbotzilla.github.io/flights (not verified). Not a Claude artifact.
4. **Test harness:** `npm test` (= `node --test`), 23 tests, no network. The page check used jsdom with GitHub mocked and lives outside the repo (not saved here); it covered the form, call count, cap, Run payload, and the new time/airline/cabin fields. No browser screenshot has been taken.
5. **Notes:** this file.

## Modules
- `core.js`: pure logic shared by page and job. Date pairs, config validation (hard cap 50 calls), SerpApi params, rule checks, ranking.
- `scripts/run-search.js`: runs a config (env `SEARCH_CONFIG`) with the key (env `SERPAPI_KEY`), writes `results.json`. `--sample file` uses a saved response, no key, no calls.
- `.github/workflows/search.yml`: `workflow_dispatch` with one input, `config`. Commits `results.json` to `main`.
- `index.html`, `app.js`: form, live call count and cap, Run button (GitHub API dispatch, needs a token), results table.
- `test/core.test.js`, `test/fixtures/sample.json`: fixture is hand-built from the SerpApi docs examples, not a live response.

## Decisions
- Currency default SGD. Default start airport SIN (Changi). Stops default 1 stop or fewer.
- Max calls per run default 10, hard cap 50. Results kept default 5.
- One API call per date pair. Each call returns outbound options with the round-trip price. Return legs are not fetched (would need a second call with `departure_token`).
- Filters are sent to the API and re-checked locally where we can. Options that break a filter are flagged, not hidden.
- Time windows (hour of day): either side may be empty (empty from = 0, empty to = 23). From later than to crosses midnight (6 to 0 = 06:00 through 00:59). Crossing windows are checked locally only, never sent to the API (unknown whether it accepts them). Return windows can't cross midnight yet (return legs aren't fetched), and validation refuses them.
- Airlines: mode any / include / exclude, codes are 2-character IATA codes or STAR_ALLIANCE, SKYTEAM, ONEWORLD, 20 at most. Sent as `include_airlines` or `exclude_airlines`. Not re-checked locally (no alliance data, codeshares).
- Cabin: `travel_class` 1 to 4, sent when not Economy. Not re-checked locally; each leg's cabin is shown in the table.
- Provider: SerpApi, free plan 250 searches a month (from its docs page). SearchApi parked: 100 free searches one-time, $40 a month after.

## Data
- `results.json` (repo root, written by the job): `generatedAt`, `sample`, `config`, `counts`, `results[]`, `errors[]`. Public, because the repo and Pages are public.

## Not yet confirmed (settle with the first live search)
- Whether `max_duration` is per leg or total, and whether it counts layovers.
- Whether `price` covers all passengers or one.
- Whether `return_times` filters the return leg.
- Whether a failed or empty call uses one of the 250.
- Whether `deep_search` costs extra.
- Whether `include_airlines` / `exclude_airlines` accept alliance codes, and `travel_class` behaves, on a live call.
- With midnight-crossing windows not sent to the API, how many matching flights survive the API's own result limit.
- Whether the Run button dispatch works with a fine-grained token (Actions: read and write).
- Whether the job's push to `main` works with default repo settings.

## Cost log
| Build | Size called | Tokens (counter, a guess) | Actual credit use (owner) |
|---|---|---|---|
| First build: core, job, page, notes | medium | about 61,000 (counter, a guess) | to fill in |
| Second build: time windows, airline and cabin filters, errors in bar | medium | see chat | to fill in |

## Loose ends
- Privacy: the repo, `results.json` and the Pages site are public.
- Not built yet: Search 2 (several airports), schedule, Gmail digest, return-leg details, email links.
- Email links should go to a Google Flights search, not booking POST data.
