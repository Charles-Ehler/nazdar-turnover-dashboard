# DESIGN.md: Nazdar turnover dashboard

How this dashboard should look and feel. Structure follows the DESIGN.md format (Google Stitch,
collected in VoltAgent/awesome-design-md); the content is Nazdar's own. Read with `styles.css`,
where every value below is a token.

## Overview

An internal analytics page for HR and plant leaders. It answers questions with numbers they will
repeat in meetings, so the design exists to make one number per view unmissable and every other
number easy to check. Calm, dense where it has to be, never decorative. One page, one light theme.

Readers: Ed (plant), Anissa (HR director), the CHRO, Taylor (HR generalist). Desktop first, often
projected in a meeting room; must still read on a phone.

## Colors

Two layers. Brand values come from the Nazdar Logo Guidelines (2023) and are authoritative.
Extended values are not in the guide and are not Nazdar standard.

### Brand
| Token | Hex | On white | Role |
|---|---|---|---|
| `--red` | #CF102D | 5.58:1 | The one accent: the headline cut, the current tab, the series that matters most in a chart |
| `--red-dark` | #A91623 | 7.43:1 | Links, small red text |
| `--text` | #323E48 | 10.95:1 | Body text, the headline figure card, the reference series in charts |
| `--muted` | #666666 | 5.74:1 | Captions, labels, secondary text |

### Extended
Neutral ramp `--n50` to `--n500` (hue-matched to PMS 432), `--paper` page background, `--card`
white, `--tint` for quiet boxes, `--red-tint` for the current tab, `teal` #1F8A8A for SG&A beside
MFG in the injury chart only.

### Rules
- Red is never an error or warning color. There are no error states on this page; missing data is
  shown as a dotted-underline "n/a" with a reason on hover.
- Green belongs to Ink Technologies and is not used.
- No colored page backgrounds. `--paper` is a near-white neutral.

## Typography

Campton is licensed for desktop only and cannot be a webfont, so the stack is
`Campton, Arial, Helvetica, sans-serif`, as the brand guide directs for web. Never substitute a
lookalike and call it Campton.

| Role | Size / weight |
|---|---|
| Page title | 26 to 34px, 700, tight tracking |
| Section title | 24 to 32px, 700 |
| Figure takeaway (the chart's title) | 18px, 700: a full sentence that states the finding |
| Headline figure | 61px, 700 |
| Other key figures | 32 to 34px, 700 |
| Body | 15 to 16px, 400 |
| Captions, labels | 12 to 14px, `--muted` |

Numbers use tabular figures everywhere.

## Layout

- Max width 1180px, 24px gutters (16px on phones).
- Sticky filter bar across the top; section menu on the left (a scrolling row of tabs under 900px).
- One section visible at a time. Each section: title, one plain scope line, then figures.
- Key figures sit in one row: the headline figure card is wider and dark; the rest are white.

## Elevation and shape

- Charts and tables sit in white cards with a 1px `--n200` border and a soft shadow tinted to
  `--text`. Radius 2px everywhere. Nothing is rounded more.
- Cards lift 2px on hover; nothing else moves on hover except menu links and buttons.

## Signature device

The diagonal cut (a short red bar with one slanted end) appears once, under the page title. It is
the only decorative red. Do not repeat it on cards, tiles or notes.

## Components

- **Key figure tile:** big number, a short label (two to four words), one line of context. The
  date range and department are stated once in the filter summary, not in every tile.
- **Figure:** takeaway sentence, caption (definition and scope), chart or table, "Show as table".
- **Tables:** at most 8 columns so nothing is cut off; combine a rate with its counts in one cell
  ("68% (36 of 53)") rather than three columns.
- **Callout:** `--red-tint` box for the one sentence a section must not be read without (the
  correlation caveat, the attendance share).
- **Pager:** previous / next section at the foot of each section.

## Charts

- Chart.js, vendored. One y-axis per chart, always. Two measures on different scales get two
  charts that share the month axis.
- Direct labels only where they do not collide; otherwise tooltips and the table view carry values.
- Red marks the series the takeaway is about; `--text` and the neutral ramp carry the rest.
- Months are fiscal periods, labelled "Oct" with the year on the first tick and each January.

## Motion

Charts grow in and replay when their section opens, figures count up, sections slide in. Slides
only, never fades, so a paused or throttled page never hides content. All motion is off under
`prefers-reduced-motion` and in print.

## Do / Don't

Do: state the finding in the chart title; keep one headline number per view; show n/a with a
reason; keep every number traceable to `data/turnover-data.json`.

Don't: repeat the date range in every label; number a section twice; add a second y-axis; put red
on things that are not the point; use em or en dashes anywhere.

## Known gaps

Dark mode is not designed: the page is a light report for meetings and print. Campton only renders
where it is installed locally.
