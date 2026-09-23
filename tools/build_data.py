#!/usr/bin/env python3
"""Regenerate data/turnover-data.json from Taylor's workbook(s).

Usage:
    python3 tools/build_data.py "MFG Turnover_9.22.26.xlsx" --as-of 2026-09-22 --from 2025-10

Requires: pip install openpyxl

Inputs:
- The main workbook: tabs `Terms`, `Hires`, `Headcount` (Taylor's cleaned file, Oct 2025 onward in one place).
  The older layout (`2026 YTD Terms`, `2026 YTD Hires`, `2026 Headcount`, roster tabs `1-26`, ...) still works.
- Rosters: roster tabs from the main workbook, else from `--rosters`, else the roster values already in the
  previous data/turnover-data.json (the cleaned workbook has no roster tabs).
- Optional `data/headcount-history.csv` (series,month,headcount): start-of-month headcounts for months the main workbook
  lacks. Fills gaps only; the workbook always wins.
- Optional `--history`: a workbook with `Terms` and `Hires` tabs reaching back before the main workbook's year.
  Rows dated before the main workbook's year are merged in; later rows are ignored (the main workbook wins).
  Exact duplicate rows are dropped and reported. Hires from history get source "Not recorded".
- `--from YYYY-MM`: first month of the window (default: January of the as-of year).
- Optional `data/fiscal-periods.csv` (label,start,end): when present, every date is assigned to the fiscal period whose
  start..end range contains it, instead of the calendar month. Labels must be the same "Mon YYYY" form the dashboard
  uses (e.g. "Oct 2025") so headcount and roster tabs still line up. Periods must be contiguous and cover the window.

Rules (handover, section 8):
- Nazdar US MFG = Company "Nazdar" and segment "MFG" (or "Manufacturing"); Packaging / Processing by Department;
  everything else "Other MFG".
- Category: reason starting with "Retire" -> Retirement; otherwise the Voluntary/Involuntary column.
- Tenure bucket from "Tenure - Days", or Separation Date - Hire Date when that column is absent: <=30, 31-90, 91-180, >180.
- Nazdar SG&A separations go into the same cube with department "SG&A" and shift "N/A", for the comparison view.
- Hire -> separation match on last name + first name (case-insensitive, trimmed); a "Terminated" hire with no exact
  match is accepted on a unique last-name + hire-date match, and reported; anything still unmatched is warned about.
- Coding quirks are preserved, not fixed. Spelling variants normalised (NORMALISE).
- Every monthly array has one slot per month of the window; months with no data stay null.
- Fails loudly if the cube total != count of MFG terms.
"""
import argparse
import datetime as dt
import json
import shutil
import sys
import warnings
from collections import Counter, defaultdict
from pathlib import Path

warnings.filterwarnings("ignore", module="openpyxl")
import openpyxl  # noqa: E402

MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
NORMALISE = {
    "Another Job": "Another job",
    "Left for another job": "Another job",
    "indeed": "Indeed",
    "Re-hire": "Rehire",
    "Grayso Munson": "Grayson Munson",
    "Grason Munson": "Grayson Munson",
    "Manufacturing": "MFG",
}
FRONTLINE = ("Packaging", "Processing")
SHIFTS = ("Day Shift", "Mid-Shift")


def norm(v):
    v = " ".join(str(v).split()) if v is not None else ""
    return NORMALISE.get(v, v)


def sheet_rows(wb, name):
    rows = list(wb[name].iter_rows(values_only=True))
    header = [norm(h) if h is not None else None for h in rows[0]]
    for r in rows[1:]:
        if not any(x is not None for x in r):
            continue
        yield {h: r[i] for i, h in enumerate(header) if h}


def roster_rows(wb, name):
    """Roster tabs are inconsistent: the Shift header is sometimes blank. Shift is always the column after Job Title."""
    rows = list(wb[name].iter_rows(values_only=True))
    header = list(rows[0])
    header[header.index("Job Title") + 1] = "Shift"
    for r in rows[1:]:
        if r[0] is None:
            continue
        yield {h: r[i] for i, h in enumerate(header) if h}


def key_name(last, first):
    return (norm(last).lower(), norm(first).lower())


def department(d):
    d = norm(d)
    return d if d in FRONTLINE else "Other MFG"


def tenure_bucket(days):
    days = int(days)
    return "0-30 days" if days <= 30 else "31-90 days" if days <= 90 else "91-180 days" if days <= 180 else "Over 180 days"


def tenure_days(t):
    if t.get("Tenure - Days") is not None:
        return int(t["Tenure - Days"])
    return (t["Separation Date"] - t["Hire Date"]).days


def pick(wb, *names):
    return next(n for n in names if n in wb.sheetnames)


def category(reason, vol_invol):
    return "Retirement" if norm(reason).startswith("Retire") else norm(vol_invol)


def seg_col(row):
    return next(k for k in row if "SG&A" in k)


def is_us(row, seg):
    return norm(row.get("Company")) == "Nazdar" and norm(row.get(seg_col(row))) == seg


def dedupe(rows, key, what):
    seen, out = set(), []
    for r in rows:
        k = key(r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    if len(out) != len(rows):
        print(f"NOTE: dropped {len(rows) - len(out)} exact duplicate {what} rows", file=sys.stderr)
    return out


def build(xlsx, as_of, history=None, start=None, rosters=None, previous=None, wc=None):
    wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    start = start or dt.date(as_of.year, 1, 1)
    n_months = (as_of.year - start.year) * 12 + as_of.month - start.month + 1
    ym = [((start.month - 1 + i) % 12 + 1, start.year + (start.month - 1 + i) // 12) for i in range(n_months)]
    months = [f"{MON[m - 1]} {y}" for m, y in ym]
    periods = Path(__file__).resolve().parent.parent / "data" / "fiscal-periods.csv"
    fiscal = None
    if periods.exists():
        import csv
        fiscal = [(r["label"], dt.date.fromisoformat(r["start"]), dt.date.fromisoformat(r["end"])) for r in csv.DictReader(periods.open())]
        fiscal = [f for f in fiscal if f[0] in months]
        if [f[0] for f in fiscal] != months:
            sys.exit(f"FATAL: data/fiscal-periods.csv must define exactly these periods in order: {months}")
        for (_, _, e1), (_, s2, _) in zip(fiscal, fiscal[1:]):
            if s2 != e1 + dt.timedelta(days=1):
                sys.exit(f"FATAL: fiscal periods are not contiguous around {e1}")
        print(f"NOTE: using fiscal periods {fiscal[0][1]} to {fiscal[-1][2]} from data/fiscal-periods.csv", file=sys.stderr)

    def idx(d):  # 1-based period index in the window
        if fiscal:
            day = d.date() if isinstance(d, dt.datetime) else d
            return next((i + 1 for i, (_, s0, e0) in enumerate(fiscal) if s0 <= day <= e0), None)
        return (d.year - start.year) * 12 + d.month - start.month + 1

    def in_window(d):
        if fiscal:
            return idx(d) is not None
        return start <= d.date() <= as_of
    main_year_start = dt.date(as_of.year, 1, 1)
    jan_idx = months.index(f"Jan {as_of.year}") + 1
    if fiscal:
        main_year_start = fiscal[jan_idx - 1][1]  # history rows before the first fiscal period of the year

    # ---- Terms and hires (main workbook, plus history before the main year) ----
    terms = [t for t in sheet_rows(wb, pick(wb, "Terms", "2026 YTD Terms")) if t.get("Separation Date") and in_window(t["Separation Date"])]
    hires = [h for h in sheet_rows(wb, pick(wb, "Hires", "2026 YTD Hires")) if h.get("Hire Date") and in_window(h["Hire Date"])]
    if history:
        hb = openpyxl.load_workbook(history, read_only=True, data_only=True)
        ht = [t for t in sheet_rows(hb, "Terms") if t["Separation Date"].date() < main_year_start and in_window(t["Separation Date"])]
        hh = [h for h in sheet_rows(hb, "Hires") if h["Hire Date"].date() < main_year_start and in_window(h["Hire Date"])]
        ht = dedupe(ht, lambda t: (key_name(t["Last Name"], t["First Name"]), t["Separation Date"]), "history separation")
        hh = dedupe(hh, lambda h: (key_name(h["Last Name"], h["First Name"]), h["Hire Date"]), "history hire")
        for h in hh:
            h.setdefault("Hire Source", "Not recorded")
        terms = ht + terms
        hires = hh + hires
    terms = dedupe(terms, lambda t: (key_name(t["Last Name"], t["First Name"]), t["Separation Date"]), "separation")
    hires = dedupe(hires, lambda h: (key_name(h["Last Name"], h["First Name"]), h["Hire Date"]), "hire")
    # HR-confirmed hire dates that replace a wrong Hire Date on a Terms row (tenure at exit and at injury).
    # Remove a line from data/hire-date-corrections.csv once Taylor's workbook carries the right date.
    fixes = Path(__file__).resolve().parent.parent / "data" / "hire-date-corrections.csv"
    if fixes.exists():
        import csv
        for fx in csv.DictReader(fixes.open(encoding="utf-8")):
            hit = [t for t in terms if key_name(t["Last Name"], t["First Name"]) == key_name(fx["last_name"], fx["first_name"])]
            if not hit:
                print(f"WARNING: hire-date correction for {fx['first_name']} {fx['last_name']} matches no Terms row", file=sys.stderr)
            for t in hit:
                new = dt.datetime.fromisoformat(fx["hire_date"])
                if t["Hire Date"] != new:
                    print(f"NOTE: hire date for {fx['first_name']} {fx['last_name']} corrected {t['Hire Date'].date()} -> {new.date()} (data/hire-date-corrections.csv)", file=sys.stderr)
                    t["Hire Date"] = new
    mfg_terms = [t for t in terms if is_us(t, "MFG")]
    sga_terms = [t for t in terms if is_us(t, "SG&A")]
    mfg_hires = [h for h in hires if is_us(h, "MFG")]
    sga_hires = [h for h in hires if is_us(h, "SG&A")]

    cube, reasons = Counter(), Counter()
    for sga, rows in ((False, mfg_terms), (True, sga_terms)):
        for t in rows:
            m = idx(t["Separation Date"])
            dep = "SG&A" if sga else department(t["Department"])
            cat = category(t["Separation Reason"], t["Voluntary/ Involuntary"])
            shift = "N/A" if sga else norm(t.get("Shift")) or "N/A"
            cube[(m, dep, shift, cat, tenure_bucket(tenure_days(t)))] += 1
            # tenure bucket too, so the reasons table can follow the Tenure filter like every other chart
            reasons[(m, dep, norm(t["Separation Reason"]), cat, tenure_bucket(tenure_days(t)))] += 1
    cube_rows = [{"month": k[0], "department": k[1], "shift": k[2], "category": k[3], "tenure_bucket": k[4], "count": v} for k, v in sorted(cube.items())]
    if sum(cube.values()) != len(mfg_terms) + len(sga_terms):
        sys.exit(f"FATAL: cube total {sum(cube.values())} != MFG + SG&A terms {len(mfg_terms) + len(sga_terms)}")
    reason_rows = [{"month": k[0], "department": k[1], "reason": k[2], "category": k[3], "tenure_bucket": k[4], "count": v} for k, v in sorted(reasons.items())]

    # ---- Headcount (main workbook only; other months stay null) ----
    hc_names = {"Nazdar MFG": "Nazdar MFG", "Packaging Headcount": "Packaging", "Processing Headcount": "Processing", "Nazdar SG&A": "Nazdar SG&A",
                "Packaging": "Packaging", "Processing": "Processing"}
    headcount = {v: [None] * n_months for v in hc_names.values()}
    month_cols = {}
    for r in wb[pick(wb, "Headcount", "2026 Headcount")].iter_rows(values_only=True):
        for i, v in enumerate(r):
            # column headers are first-of-month dates used as month labels, so map by label (a fiscal period can start in the prior month)
            if isinstance(v, dt.datetime) and f"{MON[v.month - 1]} {v.year}" in months:
                month_cols[i] = months.index(f"{MON[v.month - 1]} {v.year}") + 1
        if r[0] in hc_names:
            for i, m in month_cols.items():
                if isinstance(r[i], (int, float)):
                    headcount[hc_names[r[0]]][m - 1] = int(r[i])

    # Months the main workbook does not carry (e.g. late 2025) come from data/headcount-history.csv; it never overrides the workbook.
    extra = Path(__file__).resolve().parent.parent / "data" / "headcount-history.csv"
    if extra.exists():
        import csv
        for row in csv.DictReader(extra.open()):
            d = dt.date.fromisoformat(row["month"] + "-01")
            label = f"{MON[d.month - 1]} {d.year}"
            if row["series"] in headcount and label in months and headcount[row["series"]][months.index(label)] is None:
                headcount[row["series"]][months.index(label)] = int(row["headcount"])

    # ---- Rosters: dept|shift headcount and supervisor team sizes ----
    rwb = wb
    if rosters and not any(f"{m}-{str(y)[2:]}" in wb.sheetnames for m, y in ym):
        rwb = openpyxl.load_workbook(rosters, read_only=True, data_only=True)
    roster_tabs = [(i, f"{m}-{str(y)[2:]}") for i, (m, y) in enumerate(ym)]
    roster_tabs = [(i, t) for i, t in roster_tabs if t in rwb.sheetnames]
    dept_shift = {f"{d}|{s}": [None] * n_months for d in FRONTLINE for s in SHIFTS}
    sup_team = defaultdict(lambda: [0] * n_months)  # keyed by supervisor last name
    sup_roster_name, sup_depts, sup_shifts = {}, defaultdict(Counter), defaultdict(Counter)
    for i, tab in roster_tabs:
        c = Counter()
        for r in roster_rows(rwb, tab):
            if norm(r["Company"]) != "Nazdar" or norm(r["Department"]) not in FRONTLINE:
                continue
            c[f"{norm(r['Department'])}|{norm(r['Shift'])}"] += 1
            last = norm(r["Supervisor"]).split(",")[0].lower()  # roster is "Last, First M."
            sup_team[last][i] += 1
            sup_roster_name[last] = norm(r["Supervisor"])
            sup_depts[last][norm(r["Department"])] += 1
            sup_shifts[last][norm(r["Shift"])] += 1
        for k in dept_shift:
            dept_shift[k][i] = c[k]
    prev_sup = {}
    if not roster_tabs and previous is not None:
        # No roster tabs anywhere: carry the last known roster values forward rather than showing nothing.
        if previous["meta"]["months"] != months:
            sys.exit("FATAL: no roster tabs, and the previous JSON covers different months; pass --rosters")
        dept_shift = previous["roster_headcount_by_dept_shift"]
        prev_sup = {r["supervisor"].split()[-1].lower(): r for r in previous["supervisors_packaging_processing"]["rows"]}
        print("NOTE: no roster tabs; roster headcount and supervisor team sizes kept from the previous JSON", file=sys.stderr)

    # ---- Supervisor view (Packaging + Processing terms, whole window) ----
    sup = {}
    for t in mfg_terms:
        if department(t["Department"]) not in FRONTLINE:
            continue
        s = sup.setdefault(norm(t["Supervisor"]), Counter())
        s["separations"] += 1
        s["voluntary"] += category(t["Separation Reason"], t["Voluntary/ Involuntary"]) == "Voluntary"
        s["left_within_90_days"] += tenure_days(t) <= 90
    for last, r in prev_sup.items():  # carried-forward supervisors with zero separations still appear
        if not any(last == n.split()[-1].lower() for n in sup):
            sup[r["supervisor"]] = Counter()
    for last, full in sup_roster_name.items():  # supervisors on the roster with zero separations still appear
        if not any(last == n.split()[-1].lower() for n in sup):
            l, f = [x.strip() for x in full.split(",")]
            sup[f"{f.split()[0]} {l}"] = Counter()
    # Keyed by supervisor, then frontline (Packaging / Processing) or not, so a Processing supervisor with a stray
    # Plant Administration report still reads as Processing (Taylor, Sep 22: Tim Aranda is just Processing).
    sup_seen = defaultdict(lambda: {True: {"dept": Counter(), "shift": Counter()}, False: {"dept": Counter(), "shift": Counter()}})
    for r in mfg_terms + mfg_hires:
        who = sup_seen[norm(r.get("Supervisor"))][norm(r["Department"]) in FRONTLINE]
        who["dept"][norm(r["Department"])] += 1
        if norm(r.get("Shift")) not in ("", "N/A"):
            who["shift"][norm(r["Shift"])] += 1
    sup_rows = []
    for name, s in sup.items():
        last = name.split()[-1].lower()  # ponytail: match terms to roster on last name; unique for this plant
        team = sup_team.get(last, [0] * n_months)
        active = [x for x in team if x]
        row = {
            "supervisor": name,
            "departments": " / ".join(k for k, _ in sup_depts[last].most_common()),
            "shifts": " / ".join(k for k, _ in sup_shifts[last].most_common()),
            "separations": s["separations"], "voluntary": s["voluntary"], "left_within_90_days": s["left_within_90_days"],
            "roster_team_size_by_month": team,
            "avg_team_size_active_months": round(sum(active) / len(active), 2) if active else 0,
            "months_on_roster": len(active),
        }
        if last in prev_sup:
            row.update({k: prev_sup[last][k] for k in ("departments", "shifts", "roster_team_size_by_month", "avg_team_size_active_months", "months_on_roster")})
        # Department(s) and shift(s) come from HR's own Terms and Hires rows for this supervisor, most common first:
        # the Packaging / Processing rows when there are any, otherwise the rest. The roster tabs mislabelled
        # supervisors (Taylor, Sep 22: Erwin Avila is Processing day shift; Jesse Mullins is Plant Administration).
        # Rosters still supply team size, and the labels for a supervisor with no Terms or Hires rows.
        seen = sup_seen.get(name)
        if seen:
            use = seen[True] if seen[True]["dept"] else seen[False]
            row["departments"] = " / ".join(k for k, _ in use["dept"].most_common())
            row["shifts"] = " / ".join(k for k, _ in use["shift"].most_common()) or row["shifts"]
        sup_rows.append(row)
    sup_rows.sort(key=lambda r: (-r["separations"], -r["voluntary"], r["supervisor"]))

    # ---- Hires and cohorts ----
    term_by_name, term_by_last = defaultdict(list), defaultdict(list)
    for t in terms:
        term_by_name[key_name(t["Last Name"], t["First Name"])].append(t)
        term_by_last[norm(t["Last Name"]).lower()].append(t)

    def find_term(h):
        # A separation counts only if it happened after this hire (rehires share a name with an earlier separation).
        after = [t for t in term_by_name[key_name(h["Last Name"], h["First Name"])] if t["Separation Date"] >= h["Hire Date"]]
        t = min(after, key=lambda t: t["Separation Date"]) if after else None
        if t is None and norm(h.get("Status")) == "Terminated":
            cands = [c for c in term_by_last[norm(h["Last Name"]).lower()] if c.get("Hire Date") == h["Hire Date"]]
            if len(cands) == 1:
                t = cands[0]
                print(f"WARNING: hire {h['First Name']} {h['Last Name']} matched to separation of {t['First Name']} {t['Last Name']} by last name + hire date", file=sys.stderr)
        return t

    cohorts = {}
    hires_by_month = {"Nazdar MFG": [0] * n_months, "Packaging + Processing": [0] * n_months}
    for h in mfg_hires + sga_hires:
        hd = h["Hire Date"]
        t = find_term(h)
        if norm(h.get("Status")) == "Terminated" and t is None:
            print(f"WARNING: hire {h['First Name']} {h['Last Name']} is Terminated but has no matching separation row", file=sys.stderr)
        days_to_sep = (t["Separation Date"] - hd).days if t else None
        grp = "SG&A" if is_us(h, "SG&A") else "Frontline" if norm(h["Department"]) in FRONTLINE else "Other MFG"
        c = cohorts.setdefault((idx(hd), grp, norm(h.get("Hire Source")) or "Not recorded"), Counter())
        c["hires"] += 1
        c["still_employed"] += t is None
        c["left_within_30"] += days_to_sep is not None and days_to_sep <= 30
        for n in (30, 90, 180):
            if (as_of - hd.date()).days >= n:
                c[f"eligible_{n}"] += 1
                c[f"retained_{n}"] += days_to_sep is None or days_to_sep > n
        if grp == "SG&A":  # the bridge and hire counts stay MFG only
            continue
        hires_by_month["Nazdar MFG"][idx(hd) - 1] += 1
        if grp == "Frontline":
            hires_by_month["Packaging + Processing"][idx(hd) - 1] += 1
    cohort_rows = [{"hire_month": m, "department_group": grp, "source": src, "hires": c["hires"],
                    **{f"{p}_{n}": c[f"{p}_{n}"] for n in (30, 90, 180) for p in ("eligible", "retained")},
                    "still_employed": c["still_employed"], "left_within_30": c["left_within_30"]}
                   for (m, grp, src), c in sorted(cohorts.items())]

    # ---- Validation totals: the as-of year only (the handover's acceptance figures) ----
    Y = lambda r: r["month"] >= jan_idx  # noqa: E731
    S = lambda f: sum(r["count"] for r in cube_rows if Y(r) and r["department"] != "SG&A" and f(r))  # noqa: E731
    G = lambda f: sum(r["count"] for r in cube_rows if Y(r) and r["department"] == "SG&A" and f(r))  # noqa: E731
    yc = [r for r in cohort_rows if r["hire_month"] >= jan_idx and r["department_group"] != "SG&A"]
    R = lambda n: [sum(r[f"retained_{n}"] for r in yc), sum(r[f"eligible_{n}"] for r in yc)]  # noqa: E731
    fr = [r for r in reason_rows if Y(r) and r["department"] in FRONTLINE]
    expected = {
        "year": as_of.year, "year_start_month_index": jan_idx,
        "mfg_separations_ytd": S(lambda r: True),
        "mfg_voluntary": S(lambda r: r["category"] == "Voluntary"),
        "mfg_involuntary": S(lambda r: r["category"] == "Involuntary"),
        "mfg_retirements": S(lambda r: r["category"] == "Retirement"),
        "packaging": S(lambda r: r["department"] == "Packaging"),
        "processing": S(lambda r: r["department"] == "Processing"),
        "august_mfg": S(lambda r: months[r["month"] - 1].startswith("Aug")),
        "left_within_30_days": S(lambda r: r["tenure_bucket"] == "0-30 days"),
        "left_within_180_days": S(lambda r: r["tenure_bucket"] != "Over 180 days"),
        "frontline_attendance_plus_abandonment": sum(r["count"] for r in fr if r["reason"] in ("Poor Attendance", "Job Abandonment")),
        "frontline_total": sum(r["count"] for r in fr),
        "mfg_hires_2026": sum(r["hires"] for r in yc),
        "mfg_hires_still_employed": sum(r["still_employed"] for r in yc),
        "retention_30": R(30), "retention_90": R(90), "retention_180": R(180),
        "processing_mid_shift_separations": S(lambda r: r["department"] == "Processing" and r["shift"] == "Mid-Shift"),
        "sga_separations_ytd": G(lambda r: True),
        "sga_retirements": G(lambda r: r["category"] == "Retirement"),
    }

    last_sep = max(t["Separation Date"] for t in mfg_terms).date()
    aug_i = next(i for i, l in enumerate(months) if l == f"Aug {as_of.year}")
    aug = sum(r["count"] for r in cube_rows if r["month"] == aug_i + 1 and r["department"] != "SG&A")
    aug_hc = headcount["Nazdar MFG"][aug_i]
    no_hc = [months[i] for i, v in enumerate(headcount["Nazdar MFG"]) if v is None]
    data = {
        "meta": {
            "title": f"Nazdar manufacturing turnover: {FULL[start.month - 1]} {start.year} to {FULL[as_of.month - 1]} {as_of.year}",
            "as_of": as_of.isoformat(),
            "window_start": start.isoformat(),
            "basis": f"Nazdar US manufacturing (Shawnee) only; separations through {last_sep}; hires through {as_of}. "
                     f"Retirements shown as their own category."
                     + (f" Months are fiscal periods ({fiscal[0][1]} to {fiscal[-1][2]}), matching the monthly report." if fiscal else ""),
            "fiscal_periods": [{"label": l, "start": s0.isoformat(), "end": e0.isoformat()} for l, s0, e0 in fiscal] if fiscal else None,
            "months": months,
            "year_start_month_index": jan_idx,
            "months_elapsed": round((n_months - 1 + (as_of - fiscal[-1][1]).days / ((fiscal[-1][2] - fiscal[-1][1]).days + 1)) if fiscal else (n_months - 1 + as_of.day / 30), 1),
            "notes": [
                (f"No start-of-month headcount is reported for {', '.join(no_hc)}; turnover % shows n/a there."
                 if no_hc else "Start-of-month headcount is reported for every month shown."),
                "The Hiring & Retention Snapshot dated Sep 19 reported August at 9.7% (15 terminations ÷ 155, data through the August close on 9/5, "
                f"UK plant administration included). This dataset is US only: August is {aug} ÷ {aug_hc} = {100 * aug / aug_hc:.1f}%. "
                "Both are correct on their own definitions.",
            ],
            "snapshot_reported_august_rate": 0.097,
        },
        "headcount_start_of_month": headcount,
        "roster_headcount_by_dept_shift": dept_shift,
        "separations_cube": cube_rows,
        "separation_reasons": reason_rows,
        "hire_cohorts": cohort_rows,
        "expected_totals_for_validation": expected,
        "supervisors_packaging_processing": {
            "note": "Counts follow shift and team size; supervisors changed during the year (Logan Borders left in April, Edwin Reyes in June), "
                    "so read this as a coverage view, not a performance measure. Team sizes come from the monthly roster tabs, "
                    f"{roster_span(dept_shift, months)}.",
            "rows": sup_rows,
        },
        "hires_by_month": hires_by_month,
    }
    if wc:
        # People in Taylor's file (anyone who left or was hired in the window), for tenure at injury.
        people = [(norm(r["Last Name"]).lower(), norm(r["First Name"]).lower(), norm(r.get(seg_col(r))), d)
                  for r in terms + hires for d in [r.get("Hire Date")] if isinstance(d, dt.datetime)]
        data["workers_comp"], data["wc_expected_totals"] = read_wc(wc, months, people)
        data["meta"]["notes"].append(
            "Workers' comp figures come from the Mo WC Loss Days tab of HR's monthly report. Its month columns are fiscal periods "
            "(each listed injury date falls in the period it is counted in). Lost and restricted days are the days recorded in each "
            "period, so an injury keeps adding days in later months. Tenure at injury uses the report's roster Seniority Date, or the "
            "hire date in the Terms and Hires tabs for people who have left; injuries with no hire date before the injury date count as unknown.")
    return data


WC_TAB = "Mo WC Loss Days"
WC_METRICS = {"Injuries": "injuries", "Lost Days": "lost_time_days", "Restricted Days": "restricted_duty_days", "Restricted": "restricted_duty_days"}


def read_wc(path, months, people):
    """Read HR's Mo WC Loss Days tab: one year block per year (month columns, YTD total column), MFG / SG&A / TOTALS row
    groups, and a list of injured employees with the date of injury beside each block.

    Returns (rows, expected): rows = one per fiscal period per segment (MFG, SG&A), for every month the sheet fills in;
    expected = the sheet's own year totals. Fails if the months do not add up to the year totals, if TOTALS is not MFG + SG&A,
    or if the injury list does not match the monthly injury counts. Names never leave this function (the site is public).
    """
    wb = openpyxl.load_workbook(path, data_only=True)
    grid = list(wb[WC_TAB].iter_rows(values_only=True))
    periods = Path(__file__).resolve().parent.parent / "data" / "fiscal-periods.csv"
    import csv
    fiscal_all = [(r["label"], dt.date.fromisoformat(r["start"]), dt.date.fromisoformat(r["end"])) for r in csv.DictReader(periods.open())]
    period_of = lambda d: next((l for l, s0, e0 in fiscal_all if s0 <= d <= e0), None)  # noqa: E731

    monthly = defaultdict(dict)        # (label, seg) -> metric -> value
    expected = defaultdict(dict)       # (year, seg) -> metric -> sheet total
    listed = []                        # (name, date of injury, block year)
    labels, seg, year, tot_col, emp_col, date_col, list_year = {}, None, None, None, None, None, None
    for r in grid:
        if len(r) > 1 and isinstance(r[1], dt.datetime):  # the month header row of a year block
            labels = {c: f"{MON[v.month - 1]} {v.year}" for c, v in enumerate(r) if isinstance(v, dt.datetime)}
            year = r[1].year
            tot_col = next(c for c, v in enumerate(r) if isinstance(v, str) and "Total" in v)
        for c, v in enumerate(r):
            if norm(v) == "Employee":
                emp_col, list_year = c, year
            elif norm(v) == "Date of Injury":
                date_col = c
        if emp_col is not None and isinstance(r[emp_col], str) and norm(r[emp_col]) != "Employee" and r[date_col] is not None:
            listed.append((norm(r[emp_col]), r[date_col], list_year))
        a = norm(r[0])
        if a in ("MFG", "SG&A", "TOTALS"):
            seg = a
        elif not a:
            seg = None
        elif seg and a in WC_METRICS:
            k = WC_METRICS[a]
            for c, label in labels.items():
                if r[c] is not None:  # a blank month is "not reported yet", never zero
                    monthly[(label, seg)][k] = int(r[c])
            expected[(year, seg)][k] = int(r[tot_col])

    # The sheet must agree with itself before anything is published.
    for (y, sg), tots in expected.items():
        for k, v in tots.items():
            got = sum(m.get(k, 0) for (label, s), m in monthly.items() if s == sg and label.endswith(str(y)))
            if got != v:
                sys.exit(f"FATAL: {WC_TAB} {y} {sg} {k}: months add to {got}, the sheet's total says {v}")
    for (label, sg), m in monthly.items():
        if sg == "TOTALS":
            for k, v in m.items():
                parts = monthly.get((label, "MFG"), {}).get(k, 0) + monthly.get((label, "SG&A"), {}).get(k, 0)
                if parts != v:
                    sys.exit(f"FATAL: {WC_TAB} {label} {k}: TOTALS is {v}, MFG + SG&A is {parts}")

    # Tenure at injury: roster seniority date in the same workbook, else a hire date from Taylor's Terms / Hires.
    roster = next((wb[n] for n in wb.sheetnames if "Seniority Date" in [c.value for c in next(wb[n].iter_rows(max_row=1))]), None)
    if roster is not None:
        hdr = [c.value for c in next(roster.iter_rows(max_row=1))]
        ci = {h: hdr.index(h) for h in ("Employee Name", "Seniority Date", "Cost Center")}
        for r in roster.iter_rows(min_row=2, values_only=True):
            if r[ci["Employee Name"]] and "," in str(r[ci["Employee Name"]]) and isinstance(r[ci["Seniority Date"]], dt.datetime):
                last, first = [x.strip().lower() for x in str(r[ci["Employee Name"]]).split(",", 1)]
                cc = norm(r[ci["Cost Center"]])
                people.append((last, first, "SG&A" if cc == "SGA" else cc, r[ci["Seniority Date"]]))  # the roster spells it SGA
    injuries = []
    for name, when, y in listed:
        if isinstance(when, str):  # typed dates; a mistyped year (e.g. 8/24/20206) takes its block's year
            mo, dy, yr = (int(x) for x in when.split("/"))
            if not 1900 < yr < 2100:
                print(f"WARNING: {WC_TAB}: injury date '{when}' has a mistyped year; read as {mo}/{dy}/{y}", file=sys.stderr)
                yr = y
            when = dt.datetime(yr, mo, dy)
        d = when.date()
        first, last = name.lower().split(" ", 1)[0], name.lower().split(" ")[-1]
        cand = [p for p in people if p[0] == last and p[1].startswith(first[:4]) and p[3].date() <= d]
        who = max(cand, key=lambda p: p[3]) if cand else None
        sg = who[2] if who and who[2] in ("MFG", "SG&A") else None
        injuries.append({"period": period_of(d), "segment": sg, "days": (d - who[3].date()).days if who else None})

    # Each listed injury must land in a period and segment the monthly counts agree with.
    seen = Counter((i["period"], i["segment"]) for i in injuries)
    for (label, sg), m in monthly.items():
        if sg in ("MFG", "SG&A") and m.get("injuries", 0) != seen.get((label, sg), 0):
            unplaced = sum(1 for i in injuries if i["period"] == label and i["segment"] is None)
            if m["injuries"] != seen.get((label, sg), 0) + unplaced:
                sys.exit(f"FATAL: {WC_TAB} {label} {sg}: {m['injuries']} injuries counted, the injury list has {seen.get((label, sg), 0)}")
    for i in injuries:  # an injury we could not place in a segment takes the only segment with a count that month
        if i["segment"] is None:
            i["segment"] = next(sg for sg in ("MFG", "SG&A") if monthly.get((i["period"], sg), {}).get("injuries", 0) > seen.get((i["period"], sg), 0))
            seen[(i["period"], i["segment"])] += 1

    rows = []
    for (label, sg), m in sorted(monthly.items(), key=lambda kv: ([l for l, _, _ in fiscal_all].index(kv[0][0]), kv[0][1])):
        if sg == "TOTALS":
            continue
        mine = [i for i in injuries if i["period"] == label and i["segment"] == sg]
        rows.append({
            "period": label, "month": months.index(label) + 1 if label in months else None, "segment": sg,
            "injuries": m["injuries"], "lost_time_days": m["lost_time_days"], "restricted_duty_days": m["restricted_duty_days"],
            "injuries_first_180_days": sum(1 for i in mine if i["days"] is not None and i["days"] <= 180),
            "injuries_tenure_unknown": sum(1 for i in mine if i["days"] is None),
            "injuries_by_tenure": {b: sum(1 for i in mine if i["days"] is not None and tenure_bucket(i["days"]) == b)
                                   for b in ("0-30 days", "31-90 days", "91-180 days", "Over 180 days")},
        })
    exp = {str(y): {} for y, _ in expected}
    for (y, sg), tots in expected.items():
        if sg != "TOTALS":
            exp[str(y)][sg] = tots
    for y, segs in exp.items():  # the JSON must reproduce the sheet's year totals exactly
        for sg, tots in segs.items():
            for k, v in tots.items():
                got = sum(r[k] for r in rows if r["segment"] == sg and r["period"].endswith(y))
                if got != v:
                    sys.exit(f"FATAL: workers_comp {y} {sg} {k} = {got}, sheet says {v}")
    unknown = sum(1 for i in injuries if i["days"] is None)
    print(f"NOTE: {WC_TAB}: {len(rows)} period rows, {len(injuries)} listed injuries, {unknown} with unknown tenure", file=sys.stderr)
    return rows, exp


def roster_span(dept_shift, months):
    have = [i for i in range(len(months)) if any(v[i] for v in dept_shift.values())]
    return f"{months[have[0]][:3]} to {months[have[-1]]}" if have else "none reported"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("--as-of", default=dt.date.today().isoformat())
    ap.add_argument("--history", help="workbook with Terms and Hires tabs for earlier months")
    ap.add_argument("--rosters", help="workbook with the monthly roster tabs, when the main workbook has none")
    ap.add_argument("--wc", help="HR monthly report workbook with the Mo WC Loss Days tab (workers' comp, Section 04)")
    ap.add_argument("--from", dest="start", help="first month of the window, YYYY-MM (default: January of the as-of year)")
    ap.add_argument("--out", default=Path(__file__).resolve().parent.parent / "data" / "turnover-data.json")
    a = ap.parse_args()
    as_of = dt.date.fromisoformat(a.as_of)
    start = dt.date.fromisoformat(a.start + "-01") if a.start else None
    out = Path(a.out)
    previous = json.loads(out.read_text(encoding="utf-8")) if out.exists() else None
    data = build(a.xlsx, as_of, a.history, start, a.rosters, previous, a.wc)
    if previous:
        archive = out.parent / "archive" / f"turnover-data-{previous['meta']['as_of']}.json"
        archive.parent.mkdir(exist_ok=True)
        shutil.copy(out, archive)
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    (out.parent / "data.js").write_text("window.TURNOVER_DATA = " + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8", newline="\n")
    e = data["expected_totals_for_validation"]
    seps = sum(r["count"] for r in data["separations_cube"] if r["department"] != "SG&A")
    hires = sum(r["hires"] for r in data["hire_cohorts"] if r["department_group"] != "SG&A")
    print(f"wrote {out} and data.js: {len(data['meta']['months'])} months, {seps} MFG separations ({e['mfg_separations_ytd']} in {e['year']}), "
          f"{hires} MFG hires ({e['mfg_hires_2026']} in {e['year']}), {e['sga_separations_ytd']} SG&A separations in {e['year']}")


if __name__ == "__main__":
    main()
