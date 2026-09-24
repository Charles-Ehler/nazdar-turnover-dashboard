# Nazdar Manufacturing Turnover Dashboard

A single-page, filterable dashboard answering the six production hiring and retention questions from September 2026, covering October 2025 onward. Static HTML + vanilla JavaScript + a vendored copy of Chart.js. No build step, no server, no login. Opens in any browser, including as a local file.

**Live:** https://charles-ehler.github.io/nazdar-turnover-dashboard/

## What is in the repo

| Path | Purpose |
|---|---|
| `index.html`, `app.js`, `styles.css` | The dashboard |
| `vendor/chart.umd.js` | Chart.js 4.4.7, vendored so corporate networks that block CDNs still work |
| `data/turnover-data.json` | The only source of every number shown |
| `data/data.js` | The same JSON inlined, used automatically when the page is opened from `file://` and `fetch` is blocked |
| `data/archive/` | One dated copy of the JSON per refresh, so month-over-month changes are traceable |
| `data/fiscal-periods.csv` | Optional. `label,start,end` for each fiscal period; when present, dates are bucketed by fiscal period instead of calendar month, to match the monthly report. Built from the US close dates in Accounting's "Closing Dates / Billing Days" workbooks; add next year's periods when they are published. Starts at Jan 2025 so the workers' comp data can be checked back to its first month; the dashboard window itself starts at `--from`. |
| `data/hire-date-corrections.csv` | HR-confirmed hire dates (`last_name,first_name,hire_date,source`) that replace a wrong Hire Date on a Terms row, for tenure at exit and at injury. The build reports each one it applies. Delete a line once Taylor's workbook carries the right date. |
| `data/headcount-history.csv` | Start-of-month headcounts for months the workbook lacks (Oct to Dec 2025 today). Fills gaps only. |
| `tools/build_data.py` | Regenerates `data/turnover-data.json` and `data/data.js` from Taylor's workbook |
| `tools/check.js` | Runs the acceptance checks against the JSON without a browser |
| `concept/` | The briefing view: the same data and calculations on one screen (month timeline, tiles, Details drawer). Reached at `concept/` by typing the address, or from the small "Briefing view" link beside Reset filters; it links back with "Classic view", keeping the filters. |

## Publishing with GitHub Pages (two steps)

1. On GitHub open **Settings → Pages**.
2. Under **Build and deployment** choose **Deploy from a branch**, branch **`main`**, folder **`/ (root)`**, then **Save**.

The site appears at `https://<owner>.github.io/nazdar-turnover-dashboard/` within a minute or two. Every push to `main` republishes it.

## Monthly refresh

1. Get the updated workbook from Taylor. Since September 22, 2026 it is the cleaned `MFG Turnover_<date>.xlsx` with tabs `Terms`, `Hires`, `Headcount` and `Reference`, covering October 2025 onward in one file. The older layout (`2026 YTD Terms`, `2026 YTD Hires`, `2026 Headcount`, roster tabs `1-26`, …) still works.
2. Run the build script with the as-of date of the data:

```bash
pip3 install openpyxl
python3 tools/build_data.py "/path/to/MFG Turnover_10.20.26.xlsx" --as-of 2026-10-20 --from 2025-10 --wc "/path/to/9-MOREPORT_9-26.xlsx" --wc-history "/path/to/2024 WC Claims.xlsx"
```

   `--wc` is HR's monthly report workbook (the one with the `Mo WC Loss Days` tab). It feeds Section 04, injuries and lost days against turnover. Leave it off and the section is hidden. The script reads the tab's year blocks (month columns, a year-total column, MFG / SG&A / TOTALS rows, and the list of injured employees), writes one row per fiscal period per segment to `workers_comp`, and writes the sheet's own year totals to `wc_expected_totals`. It stops with an error if the months do not add up to the sheet's year totals, if TOTALS is not MFG + SG&A, or if the injury list does not match the monthly injury counts. A blank month is left out, never read as zero. Tenure at injury comes from the report's roster tab (Seniority Date), or from the Terms and Hires hire date for people who have left. Employee names are used only for that match and are never written to the data, because the site is public.

   `--from` sets the first month shown (default: January of the as-of year). Tenure at exit is Separation Date minus Hire Date when the workbook has no `Tenure - Days` column. Exact duplicate rows are dropped and reported. Rows with no date (leftover dropdown cells) are skipped.

   Optional: `--history` merges an older workbook's `Terms` and `Hires` for months before the as-of year. `--rosters` names a workbook with the monthly roster tabs. The cleaned workbook has no roster tabs, so without `--rosters` the roster headcount by shift and the supervisor team sizes are carried forward from the previous JSON (Jan to Aug 2026 today), and the page says so.

   The script writes `data/turnover-data.json` and `data/data.js`, and copies the previous JSON to `data/archive/turnover-data-<previous as-of>.json`. It exits with an error if the separations cube does not add up to the number of MFG plus SG&A separations, and prints a warning for any hire marked "Terminated" that has no matching separation row.

3. Check the numbers:

```bash
node tools/check.js
```

   Update the expected values inside `calc.selfCheck` in `app.js` if the month has genuinely changed them (they are the September 22 reload's acceptance figures).

4. Stamp the asset URLs so browsers pick up the new files (GitHub Pages caches for 10 minutes) and bump the version stamp under the section menu (version number and publish time), then open `index.html` locally to eyeball it, commit and push. Run it before every push:

```bash
sh tools/bump.sh
```


```bash
git add -A && git commit -m "Data refresh through 2026-10-20" && git push
```

### Rules the build script applies

- Nazdar US MFG = Company "Nazdar" and segment "MFG". Packaging and Processing by Department; everything else is "Other MFG", which counts inside All MFG but is not offered as a filter.
- Nazdar SG&A = Company "Nazdar" and segment "SG&A". Its separations sit in the same cube with department "SG&A" and shift "N/A", and its hires in the cohorts with group "SG&A", so the Department filter can flip to SG&A for comparison. Every MFG total leaves them out.
- Category: a reason starting with "Retire" is Retirement; otherwise the Voluntary/Involuntary column.
- Tenure bucket from "Tenure - Days", or Separation Date minus Hire Date when that column is absent: 0-30, 31-90, 91-180, over 180.
- Hire → separation match on last name + first name (case-insensitive, trimmed). If that fails for a "Terminated" hire, a unique last-name match with the same hire date is accepted and reported.
- Coding quirks are preserved, not fixed (one Job Abandonment coded Involuntary, one Poor Attendance coded Voluntary, "Misconduct" vs "Gross Misconduct").
- Spelling variants normalised: "Another Job" → "Another job", "indeed" → "Indeed", "Re-hire" → "Rehire", "Grayso Munson" → "Grayson Munson".
- Every monthly array has one slot per month of the window; months without a reported headcount or roster stay `null` and show as n/a. Headcount, rosters, hire source and hire status come only from the main workbook, so history months have no turnover % until those are supplied.
- A hire matches a separation only if the separation is dated after the hire (rehires share a name with an earlier separation).

### Workers' comp rules (Section 04)

- The `Mo WC Loss Days` month columns are fiscal periods: each listed injury date falls in the period it is counted in (Sep 23, 2026 check: all 16 do). If that ever stops being true, the build stops.
- Lost and restricted days are the days recorded in each period. An injury keeps adding days in later months, so days can appear in a month with no new injury.
- WC data is by MFG and SG&A only. The Department filter picks MFG or SG&A; Packaging and Processing show all of MFG. Category and Tenure do not apply.
- The section opens with tenure at injury: the share of injuries in the first 180 days on the job, against the share of workers in their first 180 days on the report's roster tab (`wc_workforce`, counted at that period's close). The roster is one month, taken after the summer hiring push, so the comparison is conservative. A two-button switch above the headline (the months picked above, or every month on file) can count every period the report has, back before the page window. 2024 comes from HR's plain injury list (`--wc-history "2024 WC Claims.xlsx"`: Employee, Date of Injury, Hire Date, MFG/SG&A). It has no lost days, so it feeds only tenure at injury, by calendar month; the build stops if a month is also in the monthly report.
- The tenure-at-injury chart splits "Over 180 days" into 181 days to 1 year, 1 to 2, 2 to 3, and over 3 years (`injuries_over_180_by_length`). Separations keep the four buckets.
- Injuries per 100 average headcount = injuries ÷ average reported start-of-month headcount × 100, the same headcount series as the turnover rate.
- The correlation is Pearson r between monthly MFG separations and monthly MFG injuries, over the selected periods that have both, reported only from 8 months up. The page also shows r with the month of most separations left out, so one month cannot carry the result unseen.
- Injuries chart and separations chart share the month axis but not a y-axis: two scales on one chart would make any two series look related.

## Sharing a view

The address bar carries the section and the filters, so a link opens the same view: `#injuries&dept=SG%26A&m=4-12`. Section names: `overview`, `turnover`, `retention`, `shifts`, `injuries`, `bridge`, `voice`, `basis`. Older links in the `#tab=s2` form still open the right section.

## Definitions used on the page

- Turnover % (month) = separations in the month ÷ start-of-month headcount for the selected department.
- Year-to-date rate = separations ÷ average of the reported start-of-month headcounts.
- Average monthly rate (section 3) = separations ÷ months elapsed ÷ average headcount.
- Retention at N days = retained ÷ eligible, where eligible means at least N days of service by the as-of date.
