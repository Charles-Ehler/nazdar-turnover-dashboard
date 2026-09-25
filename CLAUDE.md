# Nazdar manufacturing turnover dashboard

Static page (HTML, vanilla JS, vendored Chart.js 4.4.7), no build step. Live at
https://charles-ehler.github.io/nazdar-turnover-dashboard/ from `main`. Every push publishes to HR
leaders and the CHRO within about a minute. The briefing view is `concept/`, reached from a small
"Briefing view" link beside Reset filters.

## This repo is public

GitHub Pages serves every file in it, not just the page. So:

- **Never commit a file that names an employee** (other than supervisors already shown on the page).
  Correction files that name people live in the private OneDrive folder `Turnover dashboard private`
  (see README). The build finds it on Windows or Mac and stops if it is missing.
- **Never write an injured employee's name, or any detail of an injury tied to a person**, into the
  JSON, a commit message, a comment, or any file here.
- Commit messages are public too. Describe the change, not the person.

## Refresh and publish

1. Build (inputs are HR workbooks in OneDrive, not in the repo). Windows uses `py`, a Mac uses `python3`:
   ```
   python3 tools/build_data.py "<MFG Turnover_*.xlsx>" --as-of <YYYY-MM-DD> --from 2025-10 --wc "<N-MOREPORT_N-26.xlsx>" --wc-history "<2024 WC Claims.xlsx>"
   ```
   OneDrive root: `~/OneDrive - Nazdar/` on Windows, `~/Library/CloudStorage/OneDrive-Nazdar/` on a Mac.
   The current inputs are in its `Downloads` folder.
2. `node tools/check.js`: every check must pass. When the data genuinely changes a figure, update the
   expected value in `calc.selfCheck` (app.js) and say why in the commit.
3. `sh tools/bump.sh` before **every** push. It stamps asset URLs (cache busting) and the version number
   and publish time shown under the menu.
4. Preview locally (`python3 -m http.server` in the repo, then open the page), check the browser console,
   then commit and push to `main`.

## Settled decisions (do not re-open without being asked)

- Window starts Oct 2025 (fiscal periods in `data/fiscal-periods.csv`). 55 MFG separations is the agreed
  count, confirmed with HR on Sep 22, 2026.
- SG&A is a comparison option only; every MFG total leaves it out.
- The injuries section opens on every month on file (Jan 2024 onward). Its two date buttons change only
  the headline and the tenure chart. The rest of the tab follows the page filters, because turnover data
  starts in Oct 2025.
- "New employee" = first 180 days on the job. The worker share comes from the roster tab in HR's monthly
  report.
- One y-axis per chart. Motion slides and never fades, and is off under reduced motion.
- Wording: transfers are "tracked separately and not in the hire and separation lists used here". Never
  say HR has "no transfer records". Never label data "Every month HR has" (it implies nothing earlier
  exists); show date ranges instead.
- No em dashes anywhere, including commit messages.

## How to talk to the owner

The owner (Charles, AI Enablement) relays questions from HR leaders. Explain numbers at a 7th grade
level: say which group of people each number counts, break it into parts that add up, and give a
sentence they can say out loud. Answer first, then short bullets.
