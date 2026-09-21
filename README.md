# Nazdar Manufacturing Turnover Dashboard

A single-page, filterable dashboard answering Ed's six questions about 2026 production hiring and retention. Static HTML + vanilla JavaScript + a vendored copy of Chart.js. No build step, no server, no login. Opens in any browser, including as a local file.

**Live:** https://charles-ehler.github.io/nazdar-turnover-dashboard/

## What is in the repo

| Path | Purpose |
|---|---|
| `index.html`, `app.js`, `styles.css` | The dashboard |
| `vendor/chart.umd.js` | Chart.js 4.4.7, vendored so corporate networks that block CDNs still work |
| `data/turnover-data.json` | The only source of every number shown |
| `data/data.js` | The same JSON inlined, used automatically when the page is opened from `file://` and `fetch` is blocked |
| `data/archive/` | One dated copy of the JSON per refresh, so month-over-month changes are traceable |
| `tools/build_data.py` | Regenerates `data/turnover-data.json` and `data/data.js` from Taylor's workbook |
| `tools/check.js` | Runs the acceptance checks against the JSON without a browser |

## Publishing with GitHub Pages (two steps)

1. On GitHub open **Settings → Pages**.
2. Under **Build and deployment** choose **Deploy from a branch**, branch **`main`**, folder **`/ (root)`**, then **Save**.

The site appears at `https://<owner>.github.io/nazdar-turnover-dashboard/` within a minute or two. Every push to `main` republishes it.

## Monthly refresh

1. Get the updated workbook from Taylor (tabs `2026 YTD Terms`, `2026 YTD Hires`, `2026 Headcount`, and the monthly roster tabs `1-26`, `2-26`, …).
2. Run the build script with the as-of date of the data:

```bash
pip3 install openpyxl
python3 tools/build_data.py "/path/to/Turnover YTD_10.20.26.xlsx" --as-of 2026-10-20
```

   The script writes `data/turnover-data.json` and `data/data.js`, and copies the previous JSON to `data/archive/turnover-data-<date>.json`. It exits with an error if the separations cube does not add up to the number of MFG separations, and prints a warning for any hire marked "Terminated" that has no matching separation row.

3. Check the numbers:

```bash
node tools/check.js
```

   Update the expected values inside `calc.selfCheck` in `app.js` if the month has genuinely changed them (they are the handover's September 21 acceptance figures).

4. Open `index.html` locally to eyeball it, then commit and push:

```bash
git add data && git commit -m "Data refresh through 2026-10-20" && git push
```

### Rules the build script applies

- Nazdar US MFG = Company "Nazdar" and segment "MFG". Packaging and Processing by Department; everything else is "Other MFG".
- Category: a reason starting with "Retire" is Retirement; otherwise the Voluntary/Involuntary column.
- Tenure bucket from "Tenure - Days": 0-30, 31-90, 91-180, over 180.
- Hire → separation match on last name + first name (case-insensitive, trimmed). If that fails for a "Terminated" hire, a unique last-name match with the same hire date is accepted and reported.
- Coding quirks are preserved, not fixed (one Job Abandonment coded Involuntary, one Poor Attendance coded Voluntary, "Misconduct" vs "Gross Misconduct").
- Spelling variants normalised: "Another Job" → "Another job", "indeed" → "Indeed", "Re-hire" → "Rehire", "Grayso Munson" → "Grayson Munson".
- Headcount arrays have one slot per month Jan → as-of month; months without a reported headcount stay `null` and show as a dash.

## Definitions used on the page

- Turnover % (month) = separations in the month ÷ start-of-month headcount for the selected department.
- Year-to-date rate = separations ÷ average of the reported start-of-month headcounts.
- Average monthly rate (section 3) = separations ÷ months elapsed ÷ average headcount.
- Retention at N days = retained ÷ eligible, where eligible means at least N days of service by the as-of date.
