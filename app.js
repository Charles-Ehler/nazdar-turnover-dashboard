/* Nazdar manufacturing turnover dashboard.
   Pure calculations live in `calc` (also exported for tools/check.js); rendering below. */
'use strict';

// Nazdar brand palette: red is the series that raises its voice, grays carry the rest.
// teal: SG&A beside MFG navy in the injury chart only (extended layer, not a brand color; fill with direct labels).
const COLORS = { teal: '#1F8A8A', Voluntary: '#CF102D', Involuntary: '#323E48', Retirement: '#B9C1C9', red: '#CF102D', dark: '#323E48', gray: '#666666', light: '#B9C1C9', text: '#323E48', muted: '#666666' };
const CATS = ['Voluntary', 'Involuntary', 'Retirement'];
const TENURES = ['0-30 days', '31-90 days', '91-180 days', 'Over 180 days'];
const HC_KEY = { 'All MFG': 'Nazdar MFG', Packaging: 'Packaging', Processing: 'Processing', 'SG&A': 'Nazdar SG&A' };
// SG&A rows share the cube for the comparison view; every MFG total must leave them out.
const isMfg = r => r.department !== 'SG&A';
const DEFAULT_STATE = { cat: 'All', dept: 'All MFG', tenure: 'All', m0: 1, m1: 9 };

// ---------- pure calculations ----------
const calc = {
  sum(D, f) { return D.separations_cube.reduce((a, r) => a + (f(r) ? r.count : 0), 0); },
  pred(s, ignore = []) {
    const ig = new Set(ignore);
    return r =>
      (ig.has('cat') || s.cat === 'All' || r.category === s.cat) &&
      (ig.has('dept') || (s.dept === 'All MFG' ? isMfg(r) : r.department === s.dept)) &&
      (ig.has('tenure') || s.tenure === 'All' || r.tenure_bucket === s.tenure) &&
      (ig.has('months') || (r.month >= s.m0 && r.month <= s.m1));
  },
  mi(D, label) { const i = D.meta.months.findIndex(m => m.startsWith(label)); return i < 0 ? null : i + 1; },  // 1-based index of a month label prefix, e.g. 'Aug 2026'
  headcount(D, dept) { return HC_KEY[dept] ? D.headcount_start_of_month[HC_KEY[dept]] : null; },
  avgHeadcount(hc, m0 = 1, m1 = 12) {
    if (!hc) return null;
    const v = hc.slice(m0 - 1, m1).filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  },
  monthly(D, s) {
    const hc = calc.headcount(D, s.dept);
    const out = [];
    for (let m = s.m0; m <= s.m1; m++) {
      const row = { month: m, label: D.meta.months[m - 1] };
      CATS.forEach(c => { row[c] = calc.sum(D, r => calc.pred(s, ['cat', 'months'])(r) && r.month === m && r.category === c); });
      row.total = calc.sum(D, r => calc.pred(s, ['months'])(r) && r.month === m);
      row.hc = hc ? hc[m - 1] : null;
      row.rate = row.hc ? row.total / row.hc : null;
      out.push(row);
    }
    return out;
  },
  // Month x department x category matrix (Ed's Q1 in one view). Respects Tenure and Months, not Category.
  // MFG view: Packaging, Processing, All MFG (the other MFG departments sit inside All MFG). SG&A view: SG&A alone.
  matrix(D, s) {
    const sga = s.dept === 'SG&A';
    const depts = sga ? ['SG&A'] : ['Packaging', 'Processing', 'All MFG'];
    const H = D.headcount_start_of_month[sga ? 'Nazdar SG&A' : 'Nazdar MFG'];
    const f = calc.pred(s, ['cat', 'dept', 'months']);
    const inDept = (r, d) => (d === 'All MFG' ? isMfg(r) : r.department === d);
    const cell = (m, dept, cat) => calc.sum(D, r => f(r) && (m == null || r.month === m) && inDept(r, dept) && (cat == null || r.category === cat));
    const row = m => ({ label: m == null ? 'Total' : D.meta.months[m - 1], cols: depts.map(d => CATS.map(c => cell(m, d, c)).concat([cell(m, d, null)])), hc: m == null ? calc.avgHeadcount(H, s.m0, s.m1) : H[m - 1] });
    const rows = []; for (let m = s.m0; m <= s.m1; m++) rows.push(row(m));
    rows.push(row(null));
    rows.forEach(r => { r.rate = r.hc ? r.cols[r.cols.length - 1][3] / r.hc : null; });
    return { depts, rows, sga };
  },
  ytd(D, s) {
    const seps = calc.sum(D, calc.pred(s));
    const avg = calc.avgHeadcount(calc.headcount(D, s.dept), s.m0, s.m1);
    return { seps, avg, rate: avg ? seps / avg : null };
  },
  tenure(D, s) {
    const total = calc.sum(D, calc.pred(s, ['tenure']));
    return TENURES.map(t => { const n = calc.sum(D, r => calc.pred(s, ['tenure'])(r) && r.tenure_bucket === t); return { bucket: t, n, share: total ? n / total : 0 }; });
  },
  reasons(D, s) {
    const depts = s.dept === 'All MFG' ? ['Packaging', 'Processing'] : [s.dept];
    // Follows Department, months, Category and Tenure (older data files without tenure_bucket ignore the Tenure filter).
    const rows = D.separation_reasons.filter(r => depts.includes(r.department) && r.month >= s.m0 && r.month <= s.m1 &&
      (s.cat === 'All' || r.category === s.cat) && (s.tenure === 'All' || !r.tenure_bucket || r.tenure_bucket === s.tenure));
    const map = new Map();
    rows.forEach(r => { const k = r.reason + '|' + r.category; map.set(k, (map.get(k) || 0) + r.count); });
    const total = rows.reduce((a, r) => a + r.count, 0);
    const list = [...map].map(([k, n]) => { const [reason, category] = k.split('|'); return { reason, category, n, share: total ? n / total : 0 }; }).sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
    const attn = list.filter(r => r.reason === 'Poor Attendance' || r.reason === 'Job Abandonment').reduce((a, r) => a + r.n, 0);
    return { list, total, attn, attnShare: total ? attn / total : 0, depts };
  },
  // Months elapsed in m0..m1: whole months, except the last month of the data counts only the part up to the as-of date.
  elapsed(D, m0, m1) {
    const n = D.meta.months.length;
    return m1 === n ? m1 - m0 + (D.meta.months_elapsed - (n - 1)) : m1 - m0 + 1;
  },
  cohorts(D, scope, source, fromMonth = 1, toMonth = 99) {
    const inScope = r => (scope === 'sga' ? r.department_group === 'SG&A' : scope === 'frontline' ? r.department_group === 'Frontline' : r.department_group !== 'SG&A');
    const rows = D.hire_cohorts.filter(r => r.hire_month >= fromMonth && r.hire_month <= toMonth && inScope(r) && (source === 'All' || r.source === source));
    const agg = keyFn => {
      const m = new Map();
      rows.forEach(r => {
        const k = keyFn(r); const a = m.get(k) || { hires: 0, still_employed: 0, left_within_30: 0, eligible_30: 0, retained_30: 0, eligible_90: 0, retained_90: 0, eligible_180: 0, retained_180: 0 };
        Object.keys(a).forEach(f => { a[f] += r[f]; }); m.set(k, a);
      });
      return m;
    };
    const rate = (a, n) => a['eligible_' + n] ? a['retained_' + n] / a['eligible_' + n] : null;
    const byMonth = [...agg(r => r.hire_month)].sort((a, b) => a[0] - b[0]).map(([m, a]) => ({ label: D.meta.months[m - 1], ...a, r30: rate(a, 30), r90: rate(a, 90), r180: rate(a, 180) }));
    const tot = agg(() => 'all').get('all') || { hires: 0, still_employed: 0, eligible_30: 0, retained_30: 0, eligible_90: 0, retained_90: 0, eligible_180: 0, retained_180: 0, left_within_30: 0 };
    return { byMonth, total: { ...tot, r30: rate(tot, 30), r90: rate(tot, 90), r180: rate(tot, 180) }, sources: [...new Set(D.hire_cohorts.map(r => r.source))].sort() };
  },
  // Section 3 follows the From / To months only (all categories, every department side by side).
  deptTable(D, s) {
    const H = D.headcount_start_of_month;
    const pp = H.Packaging.map((v, i) => v == null || H.Processing[i] == null ? null : v + H.Processing[i]);
    const inM = r => r.month >= s.m0 && r.month <= s.m1, el = calc.elapsed(D, s.m0, s.m1);
    const mk = (name, seps, ret, hc) => { const avg = calc.avgHeadcount(hc, s.m0, s.m1); return { name, seps, ret, avg, ratio: avg ? seps / avg : null, exRet: avg ? (seps - ret) / avg : null, monthly: avg ? seps / el / avg : null }; };
    const d = dept => calc.sum(D, r => inM(r) && r.department === dept);
    const dr = dept => calc.sum(D, r => inM(r) && r.department === dept && r.category === 'Retirement');
    return [
      mk('Packaging', d('Packaging'), dr('Packaging'), H.Packaging),
      mk('Processing', d('Processing'), dr('Processing'), H.Processing),
      mk('Packaging + Processing', d('Packaging') + d('Processing'), dr('Packaging') + dr('Processing'), pp),
      mk('All Nazdar MFG', calc.sum(D, r => inM(r) && isMfg(r)), calc.sum(D, r => inM(r) && isMfg(r) && r.category === 'Retirement'), H['Nazdar MFG']),
      mk('Nazdar SG&A (contrast)', d('SG&A'), dr('SG&A'), H['Nazdar SG&A']),
    ];
  },
  // MFG against SG&A over the selected months, retirements left out (SG&A exits are mostly retirements).
  compare(D, s) {
    const t = calc.deptTable(D, s), mfg = t[3], sga = t[4];
    return { mfg, sga, times: mfg.exRet && sga.exRet ? mfg.exRet / sga.exRet : null };
  },
  shiftTable(D, s) {
    const R = D.roster_headcount_by_dept_shift;
    const reasonsFor = s.dept === 'Packaging' || s.dept === 'Processing' ? s.dept : null;
    const inM = r => r.month >= s.m0 && r.month <= s.m1;
    return Object.keys(R).map(k => {
      const [dept, shift] = k.split('|');
      const f = r => inM(r) && r.department === dept && r.shift === shift;
      const avg = calc.avgHeadcount(R[k], s.m0, s.m1);
      const row = { label: `${dept} ${shift}`, dept, shift, seps: calc.sum(D, f), vol: calc.sum(D, r => f(r) && r.category === 'Voluntary'), avg, ratio: avg ? calc.sum(D, f) / avg : null, left90: calc.sum(D, r => f(r) && (r.tenure_bucket === '0-30 days' || r.tenure_bucket === '31-90 days')) };
      if (reasonsFor === dept) {
        row.attendance = D.separation_reasons.filter(r => inM(r) && r.department === dept && r.reason === 'Poor Attendance').reduce((a, r) => a + r.count, 0);
        row.abandon = D.separation_reasons.filter(r => inM(r) && r.department === dept && r.reason === 'Job Abandonment').reduce((a, r) => a + r.count, 0);
      }
      return row;
    });
  },
  // ---------- workers' comp (Section 04) ----------
  // HR records injuries by MFG / SG&A only, so Packaging and Processing read as all of MFG. Category and Tenure do not apply.
  wcSeg(s) { return s.dept === 'SG&A' ? 'SG&A' : 'MFG'; },
  wcRows(D, seg, m0, m1) { return (D.workers_comp || []).filter(r => r.segment === seg && r.month != null && r.month >= m0 && r.month <= m1); },
  wc(D, s) {
    const seg = calc.wcSeg(s), rows = calc.wcRows(D, seg, s.m0, s.m1);
    const hc = D.headcount_start_of_month[seg === 'SG&A' ? 'Nazdar SG&A' : 'Nazdar MFG'];
    const inSeg = seg === 'SG&A' ? r => r.department === 'SG&A' : isMfg;
    const t = k => rows.reduce((a, r) => a + r[k], 0);
    const avg = calc.avgHeadcount(hc, s.m0, s.m1), injuries = t('injuries');
    const periods = [];
    for (let m = s.m0; m <= s.m1; m++) {
      const r = rows.find(x => x.month === m), seps = calc.sum(D, x => inSeg(x) && x.month === m), h = hc[m - 1];
      periods.push({ month: m, label: D.meta.months[m - 1], wc: r || null, seps, hc: h, rate: h ? seps / h : null, per100: r && h ? r.injuries / h * 100 : null });
    }
    return { seg, rows, periods, injuries, lost: t('lost_time_days'), restricted: t('restricted_duty_days'), first180: t('injuries_first_180_days'),
      unknown: t('injuries_tenure_unknown'), byTenure: TENURES.map(b => rows.reduce((a, r) => a + r.injuries_by_tenure[b], 0)),
      avg, per100: avg ? injuries / avg * 100 : null };
  },
  pearson(xs, ys) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  },
  // Monthly MFG separations against monthly MFG injuries, over the selected periods that have both. r only from 8 months up.
  wcCorrelation(D, s) {
    const rows = calc.wcRows(D, 'MFG', s.m0, s.m1);
    const seps = rows.map(r => calc.sum(D, x => isMfg(x) && x.month === r.month)), inj = rows.map(r => r.injuries);
    // Leave out the month with the most separations: if r collapses, one month is carrying the whole relationship.
    const top = seps.indexOf(Math.max(...seps)), drop = (a) => a.filter((_, i) => i !== top);
    return { n: rows.length, r: rows.length >= 8 ? calc.pearson(seps, inj) : null,
      without: rows.length >= 9 ? { label: D.meta.months[rows[top].month - 1], r: calc.pearson(drop(seps), drop(inj)) } : null };
  },
  bridge(D, key, s) {
    const hc = key === 'Nazdar MFG' ? D.headcount_start_of_month['Nazdar MFG'] : D.headcount_start_of_month.Packaging.map((v, i) => v == null ? null : v + D.headcount_start_of_month.Processing[i]);
    const hires = D.hires_by_month[key];
    const inDept = key === 'Nazdar MFG' ? isMfg : r => r.department === 'Packaging' || r.department === 'Processing';
    return D.meta.months.map((label, i) => {
      const seps = calc.sum(D, r => inDept(r) && r.month === i + 1);
      const start = hc[i], next = hc[i + 1] ?? null, net = hires[i] - seps;
      const implied = start == null ? null : start + net;
      return { label, start, hires: hires[i], seps, net, implied, next, diff: implied == null || next == null ? null : next - implied };
    }).slice(s.m0 - 1, s.m1);
  },
  // The acceptance checks from the handover (section 6), all filters at default.
  selfCheck(D) {
    const E = D.expected_totals_for_validation, out = [];
    const jan = E.year_start_month_index, s = { ...DEFAULT_STATE, m0: jan, m1: D.meta.months.length };
    const inYear = x => x.month >= jan && isMfg(x);
    const eq = (name, got, want) => out.push({ name, got, want, ok: JSON.stringify(got) === JSON.stringify(want) });
    const m = calc.monthly(D, s), y = calc.ytd(D, s), t = calc.tenure(D, s), r = calc.reasons(D, s), c = calc.cohorts(D, 'all', 'All', jan);
    eq('MFG separations YTD', y.seps, E.mfg_separations_ytd);
    CATS.forEach(cat => eq(cat, calc.sum(D, x => inYear(x) && x.category === cat), E['mfg_' + cat.toLowerCase().replace('retirement', 'retirements')]));
    eq('Packaging', calc.sum(D, x => inYear(x) && x.department === 'Packaging'), E.packaging);
    eq('Processing', calc.sum(D, x => inYear(x) && x.department === 'Processing'), E.processing);
    eq('August MFG', m[calc.mi(D, 'Aug') - jan].total, E.august_mfg);
    eq('July MFG', m[calc.mi(D, 'Jul') - jan].total, 3);
    eq('Left within 30 days', t[0].n, E.left_within_30_days);
    eq('Left within 30 days share', Math.round(t[0].share * 100), 36);
    eq('Left within 180 days', t[0].n + t[1].n + t[2].n, E.left_within_180_days);
    eq('Left within 180 days share', Math.round((t[0].n + t[1].n + t[2].n) / y.seps * 100), 62);
    eq('Packaging + Processing exits', r.total, E.frontline_total);
    eq('Poor Attendance + Job Abandonment', r.attn, E.frontline_attendance_plus_abandonment);
    eq('Attendance + abandonment share', Math.round(r.attnShare * 100), 54);
    eq('2026 MFG hires', c.total.hires, E.mfg_hires_2026);
    eq('Still employed', c.total.still_employed, E.mfg_hires_still_employed);
    eq('Still employed share', Math.round(c.total.still_employed / c.total.hires * 100), 47);
    eq('MFG hires by month (Sep 22 reload)', D.hires_by_month['Nazdar MFG'], [0, 3, 1, 3, 1, 7, 2, 7, 9, 7, 15, 2]);
    eq('Retention 30', [c.total.retained_30, c.total.eligible_30], E.retention_30);
    eq('Retention 90', [c.total.retained_90, c.total.eligible_90], E.retention_90);
    eq('Retention 180', [c.total.retained_180, c.total.eligible_180], E.retention_180);
    eq('Retention rates %', [c.total.r30, c.total.r90, c.total.r180].map(v => Math.round(v * 100)), [65, 52, 22]);
    eq('Processing mid-shift', calc.sum(D, x => inYear(x) && x.department === 'Processing' && x.shift === 'Mid-Shift'), E.processing_mid_shift_separations);
    const sg = { ...s, dept: 'SG&A' }, sy = calc.ytd(D, sg);
    eq('SG&A separations', sy.seps, E.sga_separations_ytd);
    eq('SG&A retirements', calc.sum(D, x => calc.pred(sg)(x) && x.category === 'Retirement'), E.sga_retirements);
    eq('SG&A YTD rate % / avg headcount', [Math.round(sy.rate * 100), sy.avg], [7, 285.5]);
    eq('SG&A by period, whole window', calc.monthly(D, { ...DEFAULT_STATE, m0: 1, m1: D.meta.months.length, dept: 'SG&A' }).map(x => x.total), [4, 3, 3, 2, 1, 2, 1, 2, 2, 3, 7, 1]);
    eq('SG&A whole window seps / retirements', [calc.sum(D, x => x.department === 'SG&A'), calc.sum(D, x => x.department === 'SG&A' && x.category === 'Retirement')], [31, 13]);
    eq('Oct to Dec 2025 headcount (Packaging, Processing, SG&A)', ['Packaging', 'Processing', 'Nazdar SG&A'].map(k => D.headcount_start_of_month[k].slice(0, 3)), [[31, 32, 32], [36, 37, 36], [285, 284, 286]]);
    eq('Supervisor separations', D.supervisors_packaging_processing.rows.map(x => [x.supervisor, x.separations]), [['Tim Aranda', 16], ['Steve Hufft', 11], ['Grayson Munson', 9], ['Jayden Campbell', 4], ['Edwin Reyes', 3], ['Logan Borders', 2], ['Jeremy Harper', 1], ['Erwin Avila', 0], ['Jesse Mullins', 0], ['Joseph Nippert', 0]]);
    eq('Monthly MFG turnover % (fiscal periods)', m.map(x => x.rate == null ? 'n/a' : +(x.rate * 100).toFixed(1)), [2.7, 0.7, 3.4, 2.1, 4.7, 4.7, 2.0, 8.4, 'n/a']);
    eq('YTD rate % / avg headcount', [Math.round(y.rate * 100), y.avg], [34, 148.75]);
    // Workers' comp: the JSON reproduces the sheet's year totals, and the window figures from the Sep 23 report.
    if (D.workers_comp) {
      Object.entries(D.wc_expected_totals).forEach(([yr, segs]) => Object.entries(segs).forEach(([seg, tots]) => {
        const rows = D.workers_comp.filter(x => x.segment === seg && x.period.endsWith(yr));
        eq(`WC ${yr} ${seg} matches the sheet`, Object.keys(tots).map(k => rows.reduce((a, x) => a + x[k], 0)), Object.values(tots));
      }));
      const whole = { ...DEFAULT_STATE, m0: 1, m1: D.meta.months.length }, w = calc.wc(D, whole), c = calc.wcCorrelation(D, whole);
      eq('WC MFG Oct 2025 to Aug 2026: injuries, lost, restricted', [w.injuries, w.lost, w.restricted], [7, 6, 206]);
      eq('WC MFG injuries by tenure (0-30, 31-90, 91-180, over 180) + unknown', [...w.byTenure, w.unknown], [1, 1, 1, 4, 0]);
      eq('WC MFG injuries per 100 avg headcount', +w.per100.toFixed(2), 4.71);
      eq('WC MFG separations vs injuries r, months, r without Aug 2026', [+c.r.toFixed(2), c.n, +c.without.r.toFixed(2)], [0.71, 11, 0.1]);
    }
    // The reasons table must total the same as the charts for every Category x Tenure choice (Taylor and Blanca, Sep 23).
    const mism = [];
    ['All', ...CATS].forEach(cat => ['All', ...TENURES].forEach(tenure => {
      const st = { ...DEFAULT_STATE, m0: 1, m1: D.meta.months.length, cat, tenure };
      const want = calc.sum(D, x => calc.pred(st)(x) && (x.department === 'Packaging' || x.department === 'Processing'));
      if (calc.reasons(D, st).total !== want) mism.push(`${cat}/${tenure}`);
    }));
    eq('Reasons table follows Category and Tenure (20 combinations)', mism, []);
    eq('Packaging + Processing reasons, 0-30 days, whole window', calc.reasons(D, { ...DEFAULT_STATE, m0: 1, m1: D.meta.months.length, tenure: '0-30 days' }).total, 15);
    const ft = { ...s, dept: 'Processing', tenure: '0-30 days' };
    eq('Filter test Processing 0-30', [calc.sum(D, calc.pred(ft)), calc.sum(D, x => calc.pred(ft)(x) && x.category === 'Voluntary'), calc.sum(D, x => calc.pred(ft)(x) && x.category === 'Involuntary')], [7, 3, 4]);
    return out;
  },
};

if (typeof module !== 'undefined') module.exports = { calc, DEFAULT_STATE };
// Everything below touches the DOM, so it is skipped when app.js is loaded by tools/check.js under Node.
function ui() {

// ---------- formatting helpers ----------
const pct = (v, d = 1) => v == null ? null : (v * 100).toFixed(d) + '%';
const num = v => v == null ? null : String(+v.toFixed(2));
const FULL = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December' };
const full = m => { const [mo, yr] = String(m).split(' '); return (FULL[mo] || mo) + (yr ? ' ' + yr : ''); };
const na = why => `<span class="na" title="${why}" aria-label="not available: ${why}">n/a</span>`;
const NA_HC = 'No start-of-month headcount reported for this month yet';
const NA_COHORT = 'Cohort too recent: no hires have reached this many days of service';
const cell = (v, why) => v == null ? na(why) : v;
const WORDS = ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const timesWord = r => WORDS[Math.round(r)] ? `${WORDS[Math.round(r)]} times` : `${Math.round(r)} times`;
const el = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function table(headers, rows, opts = {}) {
  const th = headers.map(h => `<th scope="col">${h}</th>`).join('');
  const body = rows.map((r, i) => `<tr${opts.totalLast && i === rows.length - 1 ? ' class="total"' : ''}>${r.map((c, j) => j === 0 ? `<th scope="row">${c}</th>` : `<td>${c ?? ''}</td>`).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Data labels on bars / points. ponytail: 25 lines instead of a second vendored plugin.
const dataLabels = {
  id: 'dataLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    chart.data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden || ds.noLabels) return;
      const fmt = ds.labelFmt || (v => v);
      const stacked = chart.options.scales?.y?.stacked && meta.type === 'bar';
      const horizontal = chart.options.indexAxis === 'y';
      if (stacked && i === chart.data.datasets.length - 1) {
        // total above each stack
        meta.data.forEach((elm, j) => {
          const total = chart.data.datasets.reduce((a, d, k) => a + (chart.getDatasetMeta(k).hidden ? 0 : (d.data[j] || 0)), 0);
          if (!total) return;
          const top = Math.min(...chart.data.datasets.map((d, k) => chart.getDatasetMeta(k).data[j]?.y ?? Infinity));
          ctx.save(); ctx.font = '700 12px Campton, Arial, Helvetica, sans-serif'; ctx.fillStyle = COLORS.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(fmt(total), elm.x, top - 4); ctx.restore();
        });
      }
      meta.data.forEach((elm, j) => {
        const v = ds.data[j];
        if (v == null || v === 0) return;
        ctx.save();
        ctx.font = '500 11px Campton, Arial, Helvetica, sans-serif';
        if (stacked) {
          const { x, y } = elm.getCenterPoint();
          if (Math.abs(elm.base - elm.y) < 14) { ctx.restore(); return; }
          ctx.fillStyle = ds.backgroundColor === COLORS.light || String(ds.backgroundColor).length > 7 ? COLORS.text : '#fff';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(fmt(v), x, y);
        } else if (horizontal) {
          ctx.fillStyle = COLORS.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(fmt(v), elm.x + 5, elm.y);
        } else {
          ctx.fillStyle = COLORS.text; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(fmt(v), elm.x, elm.y - 4);
        }
        ctx.restore();
      });
    });
  },
};
Chart.register(dataLabels);
Chart.defaults.font.family = 'Campton, Arial, Helvetica, sans-serif';
Chart.defaults.font.size = 13;
Chart.defaults.color = COLORS.text;
Chart.defaults.scale.grid.color = '#E9EDF0';
Chart.defaults.datasets.bar.maxBarThickness = 72;
Chart.defaults.scale.border.display = false;
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.legend.labels.boxHeight = 12;
Chart.defaults.plugins.legend.align = 'start';
Chart.defaults.plugins.tooltip.backgroundColor = COLORS.dark;
Chart.defaults.plugins.tooltip.cornerRadius = 2;

const charts = {};
// Motion: bars and points grow in one after another. Off entirely for people who ask their system for less motion.
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const CHART_ANIMATION = REDUCED ? false : { duration: 700, easing: 'easeOutQuart', delay: ctx => (ctx.type === 'data' && ctx.mode === 'default' ? ctx.dataIndex * 45 + ctx.datasetIndex * 90 : 0) };
// Month axis: "Oct" with the year on a second line at the first tick and every January.
const monthTicks = { maxRotation: 0, autoSkip: false, callback(v, i) { const [m, y] = String(this.getLabelForValue(v)).split(' '); return y && (i === 0 || m === 'Jan') ? [m, y] : m; } };
function figure(id, { takeaway, caption, config, tall, onBar, onLegend }) {
  const host = el(id);
  const cid = id + '-canvas';
  host.innerHTML = `<figcaption><p class="takeaway">${takeaway}</p><p class="caption">${caption}</p></figcaption>
    <div class="chartbox${tall ? ' tall' : ''}"><canvas id="${cid}" role="img" aria-label="${esc(takeaway)}"></canvas></div>
    <button type="button" class="btn tbl-toggle" aria-expanded="false">Show as table</button><div class="chart-table"></div>`;
  if (charts[id]) charts[id].destroy();
  config.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: CHART_ANIMATION, layout: { padding: { top: 16, right: 24 } } }, config.options);
  // Click-to-filter: onBar(index) and/or onLegend(datasetLabel) drill the whole page into that slice.
  if (onBar || onLegend) {
    config.options.onHover = (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; };
    // Defer: the handler re-renders (destroys) this chart, and Chart.js still has event work to finish on it.
    if (onBar) config.options.onClick = (e, els) => { if (els.length) setTimeout(() => onBar(els[0].index), 0); };
    if (onLegend) config.options.plugins = Object.assign({}, config.options.plugins, { legend: Object.assign({}, config.options.plugins?.legend, { onClick: (e, item) => setTimeout(() => onLegend(item.text), 0), onHover: e => { e.native.target.style.cursor = 'pointer'; } }) });
  }
  charts[id] = new Chart(el(cid), config);
  const fmtOf = ds => ds.labelFmt || (v => v);
  const rows = config.data.labels.map((l, j) => [l, ...config.data.datasets.map(ds => ds.data[j] == null ? na(ds.naWhy || NA_HC) : fmtOf(ds)(ds.data[j]))]);
  host.querySelector('.chart-table').innerHTML = table(['', ...config.data.datasets.map(ds => ds.label)], rows);
  const btn = host.querySelector('.tbl-toggle'), tbl = host.querySelector('.chart-table');
  btn.onclick = () => { const open = tbl.classList.toggle('open'); btn.setAttribute('aria-expanded', open); btn.textContent = open ? 'Hide table' : 'Show as table'; };
}
function tableFigure(id, { takeaway, caption, html, callout }) {
  el(id).innerHTML = `<figcaption><p class="takeaway">${takeaway}</p><p class="caption">${caption}</p></figcaption>${html}${callout ? `<p class="callout">${callout}</p>` : ''}`;
}
const catColor = (cat, s) => s.cat === 'All' || s.cat === cat ? COLORS[cat] : COLORS[cat] + '55';

// ---------- rendering ----------
let D, state = { ...DEFAULT_STATE };

function deptName(s) { return s.dept === 'All MFG' ? 'manufacturing' : s.dept; }
// One line, computed: how MFG turnover compares with SG&A once retirements are taken out.
function compareLine(s) {
  const c = calc.compare(D, s);
  return c.times ? `MFG turnover runs ${c.times.toFixed(1)} times SG&A once retirements are excluded (${pct(c.mfg.exRet, 0)} vs ${pct(c.sga.exRet, 0)} of average headcount, ${monthsLabel(s)})` : '';
}
function monthsLabel(s) { return s.m0 === s.m1 ? D.meta.months[s.m0 - 1] : `${D.meta.months[s.m0 - 1]} to ${D.meta.months[s.m1 - 1]}`; }
function windowLabel() { return monthsLabel(DEFAULT_STATE); }

function renderSelection(s) {
  const cat = s.cat === 'All' ? 'all separations' : `${s.cat.toLowerCase()} separations`;
  const ten = s.tenure === 'All' ? '' : s.tenure === 'Over 180 days' ? ', leaving after 180 days' : `, leaving within ${s.tenure}`;
  const chips = [];
  if (s.cat !== 'All') chips.push(['cat', s.cat]);
  if (s.dept !== 'All MFG') chips.push(['dept', s.dept]);
  if (s.tenure !== 'All') chips.push(['tenure', s.tenure]);
  if (s.m0 !== DEFAULT_STATE.m0 || s.m1 !== DEFAULT_STATE.m1) chips.push(['months', monthsLabel(s)]);
  el('selection').innerHTML = `<span>Showing ${cat}, ${s.dept}${ten}, ${monthsLabel(s)}.</span>` +
    chips.map(([k, v]) => `<button type="button" class="chip" data-clear="${k}" aria-label="Remove filter ${esc(v)}">${esc(v)} <span aria-hidden="true">×</span></button>`).join('') +
    (chips.length ? '<button type="button" class="chip chip-all" data-clear="all">Clear all</button>' : '');
  el('selection').querySelectorAll('.chip').forEach(btn => { btn.onclick = () => clearFilter(btn.dataset.clear); });
}
function clearFilter(k) {
  if (k === 'all') setState({ ...DEFAULT_STATE });
  else if (k === 'months') setState({ m0: DEFAULT_STATE.m0, m1: DEFAULT_STATE.m1 });
  else setState({ [k]: DEFAULT_STATE[k] });
}
// Small inline trend line for the hero number: monthly totals across the selected range, peak marked.
function sparkline(vals) {
  const max = Math.max(...vals, 1), w = 160, h = 36, n = vals.length;
  const pt = (v, i) => [n === 1 ? w / 2 : (i / (n - 1)) * w, h - 3 - (v / max) * (h - 6)];
  const pts = vals.map(pt);
  const peak = pts[vals.indexOf(max)];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline class="spark-line" pathLength="1" fill="none" stroke="#B9C1C9" stroke-width="2" points="${pts.map(p => p.map(x => x.toFixed(1)).join(',')).join(' ')}"/>
    <circle class="spark-peak" cx="${peak[0].toFixed(1)}" cy="${peak[1].toFixed(1)}" r="3.5" fill="#CF102D"/></svg>`;
}
function countUp() {
  document.querySelectorAll('.kpi .v[data-n]').forEach(node => {
    const to = +node.dataset.n, suffix = node.dataset.suffix || '', t0 = performance.now();
    const step = t => { const k = REDUCED ? 1 : Math.min(1, (t - t0) / 900); node.firstChild.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))) + suffix; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

function renderKpis(s) {
  const y = calc.ytd(D, s);
  const t30 = calc.sum(D, r => calc.pred(s, ['tenure'])(r) && r.tenure_bucket === '0-30 days');
  const all = calc.sum(D, calc.pred(s, ['tenure']));
  const c = calc.cohorts(D, 'all', 'All', s.m0, s.m1);
  // Tile = big number, a two-to-four word label, one line of context. Scope (department, months) is stated once,
  // in the filter summary above, not in every tile.
  const k = (v, l, sub, cls = '', extra = '') => `<div class="kpi ${cls}"><div class="v"${typeof v === 'number' ? ` data-n="${v}"` : ''}${typeof v === 'string' && /^\d+%$/.test(v) ? ` data-n="${parseInt(v, 10)}" data-suffix="%"` : ''}>${v}</div><div class="l">${l}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${extra}</div>`;
  const monthly = calc.monthly(D, s).map(x => x.total), peakAt = monthly.indexOf(Math.max(...monthly));
  el('kpis').innerHTML =
    k(y.seps, 'Separations', s.cat === 'All' && s.tenure === 'All' ? '' : [s.cat === 'All' ? '' : s.cat, s.tenure === 'All' ? '' : s.tenure].filter(Boolean).join(', '), 'hero',
      monthly.length > 1 ? sparkline(monthly) + `<div class="sub">Peak: ${full(D.meta.months[s.m0 - 1 + peakAt])} (${monthly[peakAt]})</div>` : '') +
    k(all ? pct(t30 / all, 0) : na('No separations in this selection'), 'Gone within 30 days', all ? `${t30} of ${all} leavers` : '') +
    k(y.rate == null ? na(NA_HC) : pct(y.rate, 0), 'Turnover rate', y.avg ? `of average headcount (${num(y.avg)})` : '') +
    k(c.total.hires ? pct(c.total.still_employed / c.total.hires, 0) : na('No hires'), 'Hires still employed', `${c.total.still_employed} of ${c.total.hires} MFG hires`) +
    k(c.total.hires, 'MFG hires', 'hired in these months');
  countUp();
}

// "The story": five computed sentences from the unfiltered data. Each one applies a view and scrolls to the evidence.
function renderStory() {
  const s0 = { ...DEFAULT_STATE };
  const m = calc.monthly(D, s0), t = calc.tenure(D, s0), r = calc.reasons(D, s0), c = calc.cohorts(D, 'all', 'All', s0.m0, s0.m1), y = calc.ytd(D, s0);
  const peak = m.reduce((a, b) => (b.total > a.total ? b : a), m[0]), prev = m[m.indexOf(peak) - 1];
  const st = calc.shiftTable(D, s0), top = [...st].sort((a, b) => b.ratio - a.ratio)[0];
  const within180 = t[0].n + t[1].n + t[2].n;
  const items = [
    { text: `${y.seps} people left manufacturing in ${monthsLabel(s0)}, ${pct(y.rate, 0)} of average headcount.`, go: '#kpis' },
    { text: `${full(peak.label)} was the worst month: ${peak.total} separations${prev && prev.total ? `, ${timesWord(peak.total / prev.total)} ${full(prev.label)}` : ''}.`, view: { m0: peak.month, m1: peak.month }, go: '#c11' },
    { text: `${pct(t[0].share, 0)} of leavers were gone within 30 days, ${pct(within180 / y.seps, 0)} within 180.`, view: { tenure: '0-30 days' }, go: '#c13' },
    { text: `Poor Attendance and Job Abandonment explain ${pct(r.attnShare, 0)} of Packaging and Processing exits (${r.attn} of ${r.total}).`, go: '#t14' },
    { text: `${top.label} lost ${top.seps} people against an average roster of ${num(top.avg)} (${pct(top.ratio, 0)}).`, view: { dept: top.dept }, go: '#c32' },
    { text: `${pct(c.total.r30, 0)} of hires since ${D.meta.months[s0.m0 - 1]} reach 30 days, ${pct(c.total.r90, 0)} reach 90, ${pct(c.total.r180, 0)} reach 180 (${c.total.retained_180} of ${c.total.eligible_180} eligible).`, go: '#s2' },
  ];
  el('story').innerHTML = `<p class="kicker">The story, ${windowLabel()}</p><ol>` + items.map((it, i) => `<li><button type="button" data-i="${i}">${it.text}</button></li>`).join('') + `</ol><p class="caption">Click a line to see the evidence.</p>`;
  el('story').querySelectorAll('button').forEach(b => {
    b.onclick = () => { const it = items[+b.dataset.i]; setState({ ...DEFAULT_STATE, ...(it.view || {}) }); showTab(document.querySelector(it.go).closest('.panel-tab').id, false); document.querySelector(it.go).scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  });
}

function renderSection1(s) {
  const m = calc.monthly(D, s), y = calc.ytd(D, s), labels = m.map(x => x.label);
  const scopeTxt = `${s.dept}, ${s.tenure === 'All' ? 'all tenures' : 'tenure ' + s.tenure}, ${monthsLabel(s)}`;

  // 1.1 stacked columns
  const peak = m.reduce((a, b) => (b.total > a.total ? b : a), m[0]);
  const prev = m[m.indexOf(peak) - 1];
  let t11 = `${full(peak.label)} had the most separations (${peak.total})`;
  if (prev && prev.total > 0 && peak.total / prev.total >= 1.95) t11 = `${full(peak.label)} separations (${peak.total}) were ${timesWord(peak.total / prev.total)} ${full(prev.label)} (${prev.total})`;
  else if (prev && peak.total > prev.total) t11 = `${full(peak.label)} separations (${peak.total}) were up from ${prev.total} in ${full(prev.label)}`;
  if (y.seps === 0) t11 = 'No separations match the current filter';
  figure('c11', {
    takeaway: t11 + '.',
    caption: `Separations by month and category. ${scopeTxt}. Click a month to zoom in, click a legend entry to isolate a category.`,
    config: { type: 'bar', data: { labels, datasets: CATS.map(c => ({ label: c, data: m.map(x => x[c]), backgroundColor: catColor(c, s), stack: 'a' })) },
      options: { scales: { x: { stacked: true, grid: { display: false }, ticks: monthTicks }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { position: 'top' } } } },
    onBar: i => { const mo = m[i].month; setState(s.m0 === mo && s.m1 === mo ? { m0: DEFAULT_STATE.m0, m1: DEFAULT_STATE.m1 } : { m0: mo, m1: mo }); },
    onLegend: c => setState({ cat: s.cat === c ? 'All' : c }),
  });

  // 1.2 turnover % line
  const rated = m.filter(x => x.rate != null);
  const avgMonthly = rated.length ? rated.reduce((a, x) => a + x.rate, 0) / rated.length : null;
  const peakR = rated.length ? rated.reduce((a, b) => (b.rate > a.rate ? b : a)) : null;
  const t12 = (peakR ? `Turnover peaked at ${pct(peakR.rate)} in ${full(peakR.label)}; ${monthsLabel(s)} total is ${pct(y.rate, 0)} of average headcount (${num(y.avg)}), an average of ${pct(avgMonthly)} a month` : 'No turnover % available for this selection') + (s.dept === 'SG&A' ? `. ${compareLine(s)}` : '');
  figure('c12', {
    takeaway: t12 + '.',
    caption: `Monthly turnover % = separations ÷ start-of-month headcount (${HC_KEY[s.dept] || 'n/a'}). ${scopeTxt}. Gaps = no headcount reported. Dashed line = average monthly rate for ${monthsLabel(s)}; the period total (${pct(y.rate, 0)}) is in the title.`,
    config: { type: 'line', data: { labels, datasets: [
      { label: 'Turnover %', data: m.map(x => x.rate == null ? null : +(x.rate * 100).toFixed(1)), borderColor: COLORS.red, backgroundColor: COLORS.red, pointRadius: 5, spanGaps: false, labelFmt: v => v.toFixed(1) + '%', naWhy: NA_HC },
      { label: `Average monthly rate, ${monthsLabel(s)}`, data: m.map(() => avgMonthly == null ? null : +(avgMonthly * 100).toFixed(1)), borderColor: COLORS.gray, borderDash: [6, 4], pointRadius: 0, noLabels: true, labelFmt: v => v.toFixed(1) + '%', naWhy: NA_HC },
    ] }, options: { scales: { y: { beginAtZero: true, ticks: { callback: v => v + '%' } }, x: { grid: { display: false }, ticks: monthTicks } }, plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y == null ? 'n/a' : c.parsed.y.toFixed(1) + '%'}` } } } } },
  });

  // 1.3 tenure at exit
  const t = calc.tenure(D, s), tot = t.reduce((a, b) => a + b.n, 0);
  const within180 = t[0].n + t[1].n + t[2].n;
  figure('c13', {
    takeaway: tot ? `${pct(within180 / tot, 0)} of ${deptName(s)} leavers were gone within 180 days (${within180} of ${tot}); ${pct(t[0].share, 0)} within 30 days.` : 'No separations match the current filter.',
    caption: `Tenure at exit, share of separations. ${s.cat === 'All' ? 'All categories' : s.cat}, ${s.dept}, ${monthsLabel(s)}. Click a bar to filter the page to that tenure.`,
    tall: true,
    config: { type: 'bar', data: { labels: TENURES, datasets: [{ label: 'Separations', data: t.map(x => x.n), backgroundColor: COLORS.dark, labelFmt: v => `${v} (${Math.round(v / tot * 100)}%)` }] },
      options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 }, suggestedMax: Math.max(...t.map(x => x.n)) * 1.25 || 1 }, y: { grid: { display: false } } }, plugins: { legend: { display: false } } } },
    onBar: i => setState({ tenure: s.tenure === TENURES[i] ? 'All' : TENURES[i] }),
  });

  // 1.4 reasons
  const r = calc.reasons(D, s);
  const scopeR = r.depts.join(' + ');
  tableFigure('t14', {
    takeaway: r.total ? `${r.list[0].reason} is the most common coded reason in ${scopeR} (${r.list[0].n} of ${r.total}).` : `No separation reasons recorded for ${scopeR}.`,
    caption: `Separation reasons as coded in the HR log, ${scopeR}, ${monthsLabel(s)}${s.cat === 'All' ? '' : ', ' + s.cat.toLowerCase()}${s.tenure === 'All' ? '' : ', tenure ' + s.tenure}. Coding quirks (e.g. one Job Abandonment coded Involuntary) are preserved as recorded.`,
    html: table(['Reason', 'Count', 'Share', 'Coded as'], r.list.map(x => [x.reason, x.n, pct(x.share), `<span class="swatch" style="background:${COLORS[x.category]}"></span>${x.category}`]).concat([['Total', r.total, '100.0%', '']]), { totalLast: true }),
    callout: `Poor Attendance + Job Abandonment: ${r.attn} of ${r.total} ${scopeR} exits (${pct(r.attnShare, 0)}).`,
  });

  // 1.5 month x department matrix
  const mx = calc.matrix(D, s);
  const head1 = `<tr><th scope="col" rowspan="2">Month</th>${mx.depts.map(d => `<th scope="colgroup" colspan="4" class="grp">${d === 'All MFG' ? 'All MFG*' : d}</th>`).join('')}<th scope="col" rowspan="2">${mx.sga ? 'SG&amp;A' : 'MFG'} turnover %</th></tr>`;
  const head2 = `<tr>${mx.depts.map(() => '<th scope="col">Vol</th><th scope="col">Invol</th><th scope="col">Ret</th><th scope="col">Total</th>').join('')}</tr>`;
  const body = mx.rows.map((r, i) => `<tr${i === mx.rows.length - 1 ? ' class="total"' : ''}><th scope="row">${r.label}</th>${r.cols.map(c => c.map((v, j) => `<td class="${j === 3 ? 'tot' : ''}">${v || (j === 3 ? 0 : '')}</td>`).join('')).join('')}<td>${r.rate == null ? na(NA_HC) : pct(r.rate)}</td></tr>`).join('');
  const mt = mx.rows[mx.rows.length - 1].cols, all = mt[mt.length - 1];
  const split = `${all[3]} (${all[0]} voluntary, ${all[1]} involuntary, ${all[2]} retirements)`;
  tableFigure('t15', {
    takeaway: mx.sga ? `SG&A: ${split}.` : `By department: Packaging ${mt[0][3]}, Processing ${mt[1][3]}, all manufacturing ${split}.`,
    caption: mx.sga
      ? `SG&A separations by month and category, ${monthsLabel(s)}${s.tenure === 'All' ? '' : ', tenure ' + s.tenure}. The Category filter does not apply to this table. Turnover % = SG&A separations ÷ start-of-month SG&A headcount.`
      : `Every department and category by month, ${monthsLabel(s)}${s.tenure === 'All' ? '' : ', tenure ' + s.tenure}. Category and Department filters do not apply to this table. Turnover % = all MFG separations ÷ start-of-month MFG headcount. *All MFG also includes the manufacturing departments outside Packaging and Processing (Plant Administration, Warehouse MFG, Quality Control MFG): ${all[3] - mt[0][3] - mt[1][3]} of the ${all[3]} here.`,
    html: `<div class="table-scroll"><table class="matrix"><thead>${head1}${head2}</thead><tbody>${body}</tbody></table></div>`,
  });
}

function renderSection2() {
  const scope = el('f2-scope').value, source = el('f2-source').value;
  const c = calc.cohorts(D, scope, source, state.m0, state.m1);
  // Hiring Event is left out of the picker on purpose (the job fair was already covered with Ed); those hires still count under All.
  if (el('f2-source').options.length === 1) c.sources.filter(src => src !== 'Hiring Event').forEach(src => el('f2-source').add(new Option(src)));
  const scopeTxt = `${{ all: 'All Nazdar MFG', frontline: 'Packaging + Processing', sga: 'Nazdar SG&A' }[scope]} hires ${monthsLabel(state)}${source === 'All' ? '' : ', source: ' + source}`;
  const rc = (x, n) => (x['eligible_' + n] ? `${pct(x['retained_' + n] / x['eligible_' + n], 0)} <span class="cnt">(${x['retained_' + n]} of ${x['eligible_' + n]})</span>` : na(NA_COHORT));
  const T = c.total;
  tableFigure('t21', {
    takeaway: T.hires ? `${T.still_employed} of ${T.hires} hires (${pct(T.still_employed / T.hires, 0)}) are still employed; 30-day retention ${T.eligible_30 ? pct(T.r30, 0) : 'n/a'}, 90-day ${T.eligible_90 ? pct(T.r90, 0) : 'n/a'}, 180-day ${T.eligible_180 ? pct(T.r180, 0) : 'n/a'}.` : 'No hires match this selection.',
    caption: `${scopeTxt}, by hire month. Each milestone shows retained ÷ eligible, with the counts in brackets; n/a means no hire in that month has been with us that long yet.`,
    // One cell per milestone: the rate with its counts, so the table fits without scrolling.
    html: table(['Hire month', 'Hires', 'Reached 30 days', 'Reached 90 days', 'Reached 180 days', 'Still employed'],
      c.byMonth.map(x => [x.label, x.hires, rc(x, 30), rc(x, 90), rc(x, 180), `${pct(x.still_employed / x.hires, 0)} <span class="cnt">(${x.still_employed})</span>`])
        .concat([['Total', T.hires, rc(T, 30), rc(T, 90), rc(T, 180), T.hires ? `${pct(T.still_employed / T.hires, 0)} <span class="cnt">(${T.still_employed})</span>` : na('No hires')]]), { totalLast: true }),
  });
  const rows = c.byMonth.filter(x => x.eligible_30);
  const pctFmt = v => Math.round(v) + '%';
  const best = rows.filter(x => x.eligible_90).sort((a, b) => b.r90 - a.r90)[0];
  figure('c22', {
    takeaway: best ? `${full(best.label)} hires have the strongest 90-day retention so far (${pct(best.r90, 0)}); cohorts with no eligible hires are omitted.` : 'No cohort has reached 30 days yet.',
    caption: `${scopeTxt}. Retention rate at 30, 90 and 180 days by hire month; bars missing = cohort too recent.`,
    config: { type: 'bar', data: { labels: rows.map(x => x.label), datasets: [
      { label: '30-day retention', data: rows.map(x => x.eligible_30 ? Math.round(x.r30 * 100) : null), backgroundColor: COLORS.light, labelFmt: pctFmt, naWhy: NA_COHORT, noLabels: true },
      { label: '90-day retention', data: rows.map(x => x.eligible_90 ? Math.round(x.r90 * 100) : null), backgroundColor: COLORS.dark, labelFmt: pctFmt, naWhy: NA_COHORT, noLabels: true },
      { label: '180-day retention', data: rows.map(x => x.eligible_180 ? Math.round(x.r180 * 100) : null), backgroundColor: COLORS.red, labelFmt: pctFmt, naWhy: NA_COHORT, noLabels: true },
    ] }, options: { scales: { y: { beginAtZero: true, max: 110, ticks: { callback: v => v > 100 ? '' : v + '%' } }, x: { grid: { display: false }, ticks: monthTicks } }, plugins: { legend: { position: 'top' } } } },
  });
}

function rosterSpan() {
  const R = Object.values(D.roster_headcount_by_dept_shift), have = D.meta.months.map((m, i) => R.some(v => v[i])).flatMap((ok, i) => (ok ? [i] : []));
  return have.length ? `${D.meta.months[have[0]].slice(0, 3)} to ${D.meta.months[have[have.length - 1]]}` : 'none reported';
}
function renderSection3(s) {
  const dt = calc.deptTable(D, s);
  const pp = dt[2], mfg = dt[3];
  const cmp = compareLine(s);
  tableFigure('t31', {
    takeaway: mfg.seps ? `Packaging + Processing account for ${pp.seps} of ${mfg.seps} MFG separations (${pct(pp.seps / mfg.seps, 0)}) with ${pct(pp.avg / mfg.avg, 0)} of the headcount.${cmp ? ' ' + cmp + '.' : ''}` : `No MFG separations in ${monthsLabel(s)}.`,
    caption: `${monthsLabel(s)}, all categories. Average headcount = mean of the reported start-of-month headcounts. Turnover = separations ÷ average headcount. Per month = separations ÷ ${+calc.elapsed(D, s.m0, s.m1).toFixed(1)} months elapsed ÷ average headcount.`,
    html: table(['Department', 'Separations', 'Retirements', 'Average headcount', 'Turnover', 'Per month'],
      dt.map(x => [x.name, x.seps, x.ret, num(x.avg), cell(pct(x.ratio), NA_HC), cell(pct(x.monthly), NA_HC)])),
  });
  el('t33').hidden = s.dept === 'SG&A';
  if (s.dept === 'SG&A') {
    tableFigure('t32', { takeaway: 'Shift is not recorded for SG&A.', caption: 'Set the Department filter to All MFG, Packaging or Processing to see separations by shift and supervisor.', html: '' });
    if (charts.c32) { charts.c32.destroy(); delete charts.c32; }
    el('c32').innerHTML = '';
    return;
  }
  const st = calc.shiftTable(D, s);
  const showReasons = st.some(x => x.attendance != null);
  const top = [...st].sort((a, b) => b.ratio - a.ratio)[0];
  const hdr = ['Department / shift', 'Separations', 'Voluntary', 'Average roster', 'Separations ÷ roster', 'Left within 90 days'].concat(showReasons ? ['Poor Attendance*', 'Job Abandonment*'] : []);
  tableFigure('t32', {
    takeaway: `${top.label} has the highest separations relative to team size: ${top.seps} separations against an average roster of ${num(top.avg)} (${pct(top.ratio, 0)}).`,
    caption: `${monthsLabel(s)}, all categories. Roster headcount by shift from the monthly roster tabs, ${rosterSpan()}; average of the months with a roster. ${showReasons ? `*Reason counts are ${s.dept} department totals, not by shift (the log does not code reasons by shift).` : 'Set the Department filter to Packaging or Processing to add attendance / abandonment counts (department totals; the log does not code reasons by shift).'}`,
    html: table(hdr, st.map(x => [x.label, x.seps, x.vol, num(x.avg), pct(x.ratio), x.left90].concat(showReasons ? [x.attendance ?? '', x.abandon ?? ''] : []))),
  });
  figure('c32', {
    takeaway: `Mid-shift teams lose more people per head: ${st.filter(x => x.shift === 'Mid-Shift').map(x => `${x.dept} ${pct(x.ratio, 0)}`).join(', ')} vs day shift ${st.filter(x => x.shift === 'Day Shift').map(x => `${x.dept} ${pct(x.ratio, 0)}`).join(', ')}.`,
    caption: `Separations ${monthsLabel(s)} ÷ average roster headcount (reported months), by department and shift. All categories. Click a bar to filter the page to that department.`,
    tall: true,
    config: { type: 'bar', data: { labels: st.map(x => x.label), datasets: [{ label: 'Separations ÷ average headcount', data: st.map(x => Math.round(x.ratio * 100)), backgroundColor: st.map(x => x.shift === 'Mid-Shift' ? COLORS.red : COLORS.dark), labelFmt: v => v + '%' }] },
      options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { callback: v => v + '%' }, suggestedMax: Math.max(...st.map(x => x.ratio * 100)) * 1.2 }, y: { grid: { display: false } } }, plugins: { legend: { display: false } } } },
    onBar: i => setState({ dept: s.dept === st[i].dept ? 'All MFG' : st[i].dept }),
  });
  const sup = D.supervisors_packaging_processing;
  el('t33').querySelector('.details-body').innerHTML = `<p class="caption">${esc(sup.note)} Counts cover the whole period, ${D.meta.months[0]} to ${D.meta.months[D.meta.months.length - 1]}, whatever months are selected above.</p>` +
    table(['Supervisor', 'Department(s)', 'Shift(s)', 'Separations', 'Voluntary', 'Left within 90 days', 'Average team size (active months)', 'Months on roster', 'Separations ÷ avg team size'],
      sup.rows.map(r => [r.supervisor, r.departments || 'n/a', r.shifts || 'n/a', r.separations, r.voluntary, r.left_within_90_days, num(r.avg_team_size_active_months), r.months_on_roster, r.avg_team_size_active_months ? pct(r.separations / r.avg_team_size_active_months) : na('No roster months')]));
}

function renderSection4() {
  const r = calc.reasons(D, DEFAULT_STATE), t = calc.tenure(D, DEFAULT_STATE);
  el('s4-body').innerHTML = `
    <p><strong>What the exit codes already say.</strong> ${t[0].n} of ${t.reduce((a, b) => a + b.n, 0)} manufacturing leavers (${pct(t[0].share, 0)}) were gone within 30 days, and Poor Attendance plus Job Abandonment account for ${r.attn} of ${r.total} Packaging and Processing exits (${pct(r.attnShare, 0)}). The pattern points at the first month on the job and at the attendance policy.</p>
    <p><strong>Listening sessions.</strong> Frontline listening sessions started September 22, 2026: six day-shift sessions plus one mid-shift session, running through October 5. The guide covers schedule fit, job expectations, training, supervision, pay and the attendance policy.</p>
    <div class="placeholder"><strong>Findings: to be added</strong> when the sessions conclude (after October 5, 2026).</div>`;
}

function renderSection5(s) {
  const mk = (id, key, title) => {
    const b = calc.bridge(D, key, s);
    const gap = b.filter(x => x.diff != null && x.diff !== 0);
    tableFigure(id, {
      takeaway: `${title}: ${b.reduce((a, x) => a + x.hires, 0)} hires and ${b.reduce((a, x) => a + x.seps, 0)} separations ${monthsLabel(s)}; ${gap.length ? `${gap.length} month${gap.length > 1 ? 's' : ''} do not reconcile to the reported headcount, likely transfers or timing` : 'every month reconciles to the reported headcount'}.`,
      caption: `${title}. Implied end = start-of-month headcount + hires − separations. Gap to reconcile = next month's reported headcount − implied end.`,
      html: table(['Month', 'Start headcount', 'Hires', 'Separations', 'Net', 'Implied end', 'Next start', 'Gap to reconcile'],
        b.map(x => [x.label, cell(x.start, NA_HC), x.hires, x.seps, x.net > 0 ? '+' + x.net : x.net, cell(x.implied, NA_HC), cell(x.next, NA_HC), x.diff == null ? na(NA_HC) : (x.diff > 0 ? '+' + x.diff : x.diff)])),
    });
    return b;
  };
  const b = mk('t51a', 'Nazdar MFG', 'Nazdar MFG');
  mk('t51b', 'Packaging + Processing', 'Packaging + Processing');
  const peak = b.reduce((a, x) => (x.hires > a.hires ? x : a), b[0]);
  figure('c52', {
    takeaway: (() => { const f = b.find(x => x.start != null), l = [...b].reverse().find(x => x.start != null); if (!f) return `${peak.hires} hires and ${peak.seps} separations in ${full(peak.label)}; no headcount is reported for it yet.`; return `Hiring peaked in ${full(peak.label)} (${peak.hires} hires) while ${peak.seps} people left; reported headcount went from ${f.start} in ${full(f.label)} to ${l.start} in ${full(l.label)}.`; })(),
    caption: 'Nazdar MFG hires and separations per fiscal period. Headcount is in the table above.',
    config: { type: 'bar', data: { labels: b.map(x => x.label), datasets: [
      { label: 'Hires', data: b.map(x => x.hires), backgroundColor: COLORS.light, yAxisID: 'y' },
      { label: 'Separations', data: b.map(x => x.seps), backgroundColor: COLORS.red, yAxisID: 'y' },
    ] }, options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false }, ticks: monthTicks } }, plugins: { legend: { position: 'top' } } } },
  });
}

function renderSection6() {
  const ai = calc.mi(D, 'Aug'), aug = calc.sum(D, r => isMfg(r) && r.month === ai), hc = D.headcount_start_of_month['Nazdar MFG'][ai - 1];
  const ytdState = { ...DEFAULT_STATE, m0: D.meta.year_start_month_index };
  const m = calc.monthly(D, DEFAULT_STATE).filter(x => x.rate != null && x.month !== ai), prior = m.reduce((a, b) => (b.rate > a.rate ? b : a)), y = calc.ytd(D, ytdState);
  el('s6-body').innerHTML = `This dashboard uses Nazdar US manufacturing only, separations through 9/18, on the fiscal calendar the monthly report uses (August = ${D.meta.fiscal_periods ? D.meta.fiscal_periods[ai - 1].start.slice(5).replace('-', '/') + ' to ' + D.meta.fiscal_periods[ai - 1].end.slice(5).replace('-', '/') : 'calendar month'}). On that basis August is ${aug} ÷ ${hc} = ${pct(aug / hc)}, and the prior monthly high is ${full(prior.label)} at ${pct(prior.rate)}. The Hiring &amp; Retention Snapshot dated September 19 reported August at ${pct(D.meta.snapshot_reported_august_rate)}: the same ${aug} US separations plus 2 in UK plant administration, 15 ÷ 155, against the same prior high of 4.7%. For ${D.meta.months[D.meta.year_start_month_index - 1].slice(-4)} year to date, the snapshot's 29.7% divides 46 separations (43 US + 3 UK, through the August close on 9/5) by the August headcount of 155; this dashboard's ${pct(y.rate, 0)} divides ${y.seps} (${monthsLabel(ytdState)}) by the January to August average of ${num(y.avg)}. All of these are correct on their own definitions.`;
}

// Section 04: workers' comp injuries and lost days against turnover (id s7; ids stay fixed so old links still work).
const NA_WC = "Not in HR's monthly report yet";
function renderSection7(s) {
  if (!D.workers_comp) { el('s7').hidden = true; return; }
  const w = calc.wc(D, s), seg = w.seg, segName = seg === 'SG&A' ? 'SG&A' : 'MFG', rng = monthsLabel(s);
  const haveWc = w.periods.filter(p => p.wc), lastWc = haveWc.length ? haveWc[haveWc.length - 1].label : null;
  const note = s.dept === 'Packaging' || s.dept === 'Processing' ? ` Injuries are recorded for all of MFG, not by department, so this shows all of MFG.` : '';
  el('s7-scope').textContent = `Workers' comp from the Mo WC Loss Days tab of HR's monthly report, ${segName}, ${rng}${lastWc && lastWc !== D.meta.months[s.m1 - 1] ? ` (injury data through ${lastWc})` : ''}. Follows the Department filter at the MFG / SG&A level and the From and To months; the Category and Tenure filters do not apply.${note}`;

  const tile = (v, l) => `<div class="kpi"><div class="v"${typeof v === 'number' ? ` data-n="${v}"` : ''}>${v}</div><div class="l">${l}</div></div>`;
  el('k7').innerHTML = tile(w.injuries, `${segName} injuries, ${rng}`) + tile(w.lost, 'Lost-time days') + tile(w.restricted, 'Restricted-duty days') +
    tile(w.per100 == null ? na(NA_HC) : num(+w.per100.toFixed(1)), `Injuries per 100 average headcount (${num(w.avg)})`);
  countUp();

  // 7.1: injuries by period for both segments, then separations on the same months. Two charts, one scale each:
  // a second y-axis would let any two lines look related, which is exactly the question being asked.
  const labels = w.periods.map(p => p.label);
  const other = calc.wc(D, { ...s, dept: seg === 'SG&A' ? 'All MFG' : 'SG&A' });
  const mfgP = seg === 'MFG' ? w.periods : other.periods, sgaP = seg === 'SG&A' ? w.periods : other.periods;
  const peakOf = (arr, f) => { const v = arr.map(f), mx = Math.max(...v.filter(x => x != null)); return { mx, at: arr.filter((p, i) => v[i] === mx).map(p => full(p.label)) }; };
  const pi = peakOf(haveWc, p => p.wc.injuries), ps = peakOf(haveWc, p => p.seps);
  let t71 = `No ${segName} injuries were recorded in ${rng}`;
  if (haveWc.length && pi.mx > 0) {
    t71 = pi.at.length === 1 && ps.at.length === 1 && pi.at[0] === ps.at[0]
      ? `${segName} injuries and separations both peaked in ${pi.at[0]} (${pi.mx} injur${pi.mx === 1 ? 'y' : 'ies'}, ${ps.mx} separations)`
      : `${segName} injuries were highest in ${pi.at.join(', ')} (${pi.mx}); separations were highest in ${ps.at.join(', ')} (${ps.mx})`;
  }
  figure('c71', {
    takeaway: t71 + '.',
    caption: `Workers' comp injuries by fiscal period, MFG and SG&A. ${rng}. A blank month is not in HR's monthly report yet.`,
    config: { type: 'bar', data: { labels, datasets: [
      { label: 'MFG injuries', data: mfgP.map(p => p.wc ? p.wc.injuries : null), backgroundColor: COLORS.dark, naWhy: NA_WC },
      { label: 'SG&A injuries', data: sgaP.map(p => p.wc ? p.wc.injuries : null), backgroundColor: COLORS.teal, naWhy: NA_WC },
    ] }, options: { scales: { x: { grid: { display: false }, ticks: monthTicks }, y: { beginAtZero: true, ticks: { precision: 0 }, suggestedMax: 4 } }, plugins: { legend: { position: 'top' } } } },
  });
  figure('c71s', {
    takeaway: `${segName} separations on the same months, for comparison with the injuries above.`,
    caption: `Separations by fiscal period, all categories, ${segName}, ${rng}. From the HR separations log, the same counts as section 01.`,
    tall: true,
    config: { type: 'bar', data: { labels, datasets: [{ label: `${segName} separations`, data: w.periods.map(p => p.seps), backgroundColor: COLORS.red }] },
      options: { scales: { x: { grid: { display: false }, ticks: monthTicks }, y: { beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { display: false } } } },
  });
  const c = calc.wcCorrelation(D, s);
  el('r7').innerHTML = c.r == null
    ? `Only ${c.n} month${c.n === 1 ? '' : 's'} in this range have both MFG injuries and separations; that is too few to report a correlation. See the charts above.`
    : `Monthly MFG separations and MFG injuries: correlation r = ${c.r.toFixed(2)} over ${c.n} months.${c.without && c.without.r != null ? ` Leaving out ${full(c.without.label)}, the month with the most separations, r = ${c.without.r.toFixed(2)}.` : ''} <span class="caption">Based on ${c.n} months; a correlation this size on a small sample is a signal to investigate, not proof of cause.</span>`;

  // 7.2 lost and restricted days
  const days = haveWc.reduce((a, p) => a + p.wc.lost_time_days + p.wc.restricted_duty_days, 0), pd = peakOf(haveWc, p => p.wc.lost_time_days + p.wc.restricted_duty_days);
  figure('c72', {
    takeaway: days ? `${segName} recorded ${w.lost} lost-time and ${w.restricted} restricted-duty days in ${rng}; the most in ${pd.at.join(', ')} (${pd.mx}).` : `No lost-time or restricted-duty days recorded for ${segName} in ${rng}.`,
    caption: `Days recorded in each fiscal period, ${segName}. An injury keeps adding days in later months, so days can appear in a month with no new injury.`,
    config: { type: 'bar', data: { labels, datasets: [
      { label: 'Lost-time days', data: w.periods.map(p => p.wc ? p.wc.lost_time_days : null), backgroundColor: COLORS.red, stack: 'd', naWhy: NA_WC },
      { label: 'Restricted-duty days', data: w.periods.map(p => p.wc ? p.wc.restricted_duty_days : null), backgroundColor: COLORS.dark, stack: 'd', naWhy: NA_WC },
    ] }, options: { scales: { x: { stacked: true, grid: { display: false }, ticks: monthTicks }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { position: 'top' } } } },
  });

  // 7.3 table
  const wcCell = (p, k) => p.wc ? p.wc[k] : na(NA_WC);
  tableFigure('t73', {
    takeaway: `${segName} by fiscal period, ${rng}.`,
    caption: `Turnover % = separations ÷ start-of-month headcount (Nazdar ${segName}). Injuries per 100 = injuries ÷ start-of-month headcount × 100.`,
    html: table(['Period', 'Injuries', 'Lost-time days', 'Restricted-duty days', 'Separations', 'Turnover %', 'Injuries per 100 headcount'],
      w.periods.map(p => [p.label, wcCell(p, 'injuries'), wcCell(p, 'lost_time_days'), wcCell(p, 'restricted_duty_days'), p.seps, p.rate == null ? na(NA_HC) : pct(p.rate), p.per100 == null ? na(p.wc ? NA_HC : NA_WC) : p.per100.toFixed(1)])
        .concat([['Total', w.injuries, w.lost, w.restricted, w.periods.reduce((a, p) => a + p.seps, 0), '', w.per100 == null ? na(NA_HC) : w.per100.toFixed(1)]]), { totalLast: true }),
  });

  // 7.4 tenure at injury, same buckets as the separations tenure chart (section 01)
  const known = w.byTenure.reduce((a, b) => a + b, 0), within = w.byTenure[0] + w.byTenure[1] + w.byTenure[2];
  const lv = calc.tenure(D, { ...s, cat: 'All', tenure: 'All', dept: seg === 'SG&A' ? 'SG&A' : 'All MFG' }), lvTot = lv.reduce((a, b) => a + b.n, 0), lv180 = lv[0].n + lv[1].n + lv[2].n;
  const bl = TENURES.concat(w.unknown ? ['Unknown'] : []), bv = w.byTenure.concat(w.unknown ? [w.unknown] : []);
  figure('c74', {
    takeaway: known ? `${within} of ${known} ${segName} injuries with a known hire date (${pct(within / known, 0)}) happened in the first 180 days on the job${lvTot ? `; ${pct(lv180 / lvTot, 0)} of ${segName} leavers left within 180 days` : ''}.` : `No ${segName} injuries with a known hire date in ${rng}.`,
    caption: `Tenure at injury = date of injury − hire date (roster seniority date, or the hire date in the Terms and Hires tabs for people who have left). ${w.unknown ? `${w.unknown} injur${w.unknown === 1 ? 'y has' : 'ies have'} no hire date before the injury date and ${w.unknown === 1 ? 'is' : 'are'} shown as Unknown.` : ''} ${segName}, ${rng}.`,
    tall: true,
    config: { type: 'bar', data: { labels: bl, datasets: [{ label: 'Injuries', data: bv, backgroundColor: bl.map(b => (b === 'Unknown' ? COLORS.light : COLORS.dark)), labelFmt: v => String(v) }] },
      options: { indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 }, suggestedMax: Math.max(...bv, 1) * 1.3 }, y: { grid: { display: false } } }, plugins: { legend: { display: false } } } },
  });
}

const TABS = ['s0', 's1', 's2', 's3', 's7', 's5', 's4', 's6'];
// Readable names in the address bar (#injuries, #retention&dept=Packaging). Section ids stay fixed inside the page,
// and old links (#tab=s2) still resolve.
const SLUG = { s0: 'overview', s1: 'turnover', s2: 'retention', s3: 'shifts', s7: 'injuries', s5: 'bridge', s4: 'voice', s6: 'basis' };
const tabFrom = x => (TABS.includes(x) ? x : Object.keys(SLUG).find(k => SLUG[k] === x));
let tab = 's0';
function showTab(id, scrollTop = true) {
  if (!TABS.includes(id)) id = 's0';
  tab = id;
  document.querySelectorAll('.panel-tab').forEach(p => p.classList.toggle('active', p.id === id));
  document.querySelectorAll('.tabs a').forEach(a => { if (a.dataset.tab === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  // Replay each chart's grow-in when its section comes into view, so every tab arrives animated.
  Object.values(charts).forEach(c => { if (el(id).contains(c.canvas)) { c.resize(); c.reset(); c.update(); } });
  if (id === 's0') countUp();
  writeHash();
  if (scrollTop) window.scrollTo({ top: 0, behavior: 'instant' });
}
function pagers() {
  TABS.forEach((id, i) => {
    const sec = el(id); let p = sec.querySelector('.pager');
    if (!p) { p = document.createElement('nav'); p.className = 'pager'; p.setAttribute('aria-label', 'Previous and next section'); sec.appendChild(p); }
    const name = t => document.querySelector(`.tabs a[data-tab="${t}"] span`).textContent;
    p.innerHTML = (i > 0 ? `<a href="#${SLUG[TABS[i - 1]]}" class="prev"><span>Previous</span>${name(TABS[i - 1])}</a>` : '') + (i < TABS.length - 1 ? `<a href="#${SLUG[TABS[i + 1]]}" class="next"><span>Next</span>${name(TABS[i + 1])}</a>` : '');
  });
}
function writeHash() {
  const q = new URLSearchParams();
  if (state.cat !== 'All') q.set('cat', state.cat);
  if (state.dept !== 'All MFG') q.set('dept', state.dept);
  if (state.tenure !== 'All') q.set('tenure', state.tenure);
  if (state.m0 !== DEFAULT_STATE.m0 || state.m1 !== DEFAULT_STATE.m1) q.set('m', `${state.m0}-${state.m1}`);
  const h = [tab !== 's0' ? SLUG[tab] : '', q.toString()].filter(Boolean).join('&');
  history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
  const sw = el('to-concept'); if (sw) sw.href = 'concept/' + (q.toString() ? '#' + q : ''); // same filters in the briefing view
}

function setState(patch) {
  state = { ...state, ...patch };
  if (state.m0 > state.m1) [state.m0, state.m1] = [state.m1, state.m0];
  el('f-cat').value = state.cat; el('f-dept').value = state.dept; el('f-tenure').value = state.tenure; el('f-m0').value = state.m0; el('f-m1').value = state.m1;
  writeHash();
  renderAll();
}

function renderAll() {
  el('f-cat').value = state.cat; el('f-dept').value = state.dept; el('f-tenure').value = state.tenure; el('f-m0').value = state.m0; el('f-m1').value = state.m1;
  renderSelection(state);
  renderKpis(state);
  renderSection1(state);
  if (el('f2-source').options.length > 1) renderSection2();  // skipped on the first pass; init draws it once the source list exists
  renderSection3(state);
  renderSection5(state);
  renderSection7(state);
}

function init(data) {
  D = data;
  el('basis').textContent = D.meta.basis;
  const title = D.meta.title.replace(/^Nazdar /, ''); document.title = title.charAt(0).toUpperCase() + title.slice(1); document.querySelector('h1').textContent = document.title;
  el('ret-def').textContent = `Retention counts a hire as retained if they are still employed N days after hire; only hires with at least N days of service by ${full(D.meta.months[D.meta.months.length - 1]).replace(/(\w+) (\d+)/, '$1 ' + new Date(D.meta.as_of + 'T00:00:00').getDate() + ', $2')} are eligible.`;
  D.meta.months.forEach((m, i) => { el('f-m0').add(new Option(m, i + 1)); el('f-m1').add(new Option(m, i + 1)); });
  el('f-m1').value = D.meta.months.length;
  DEFAULT_STATE.m1 = D.meta.months.length; state.m1 = DEFAULT_STATE.m1;
  const read = () => setState({ cat: el('f-cat').value, dept: el('f-dept').value, tenure: el('f-tenure').value, m0: +el('f-m0').value, m1: +el('f-m1').value });
  ['f-cat', 'f-dept', 'f-tenure', 'f-m0', 'f-m1'].forEach(id => el(id).addEventListener('change', read));
  ['f2-scope', 'f2-source'].forEach(id => el(id).addEventListener('change', renderSection2));
  el('btn-reset').onclick = () => setState({ ...DEFAULT_STATE });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setState({ ...DEFAULT_STATE }); });
  // The section and filters live in the URL so a view can be shared: #turnover&cat=Voluntary&dept=Processing&tenure=0-30+days&m=8-8
  const q = new URLSearchParams(location.hash.slice(1));
  const [qm0, qm1] = (q.get('m') || '').split('-').map(Number);
  // An old link may still carry dept=Other MFG, which is no longer offered: fall back to All MFG.
  state = { ...state, ...(q.get('cat') && { cat: q.get('cat') }), ...(HC_KEY[q.get('dept')] && { dept: q.get('dept') }), ...(q.get('tenure') && { tenure: q.get('tenure') }), ...(qm0 && qm1 && { m0: qm0, m1: qm1 }) };
  renderStory();
  pagers();
  // The filter bar wraps at narrower widths; keep the tab rail parked just below it.
  new ResizeObserver(() => document.documentElement.style.setProperty('--fb', document.querySelector('.filterbar').offsetHeight + 'px')).observe(document.querySelector('.filterbar'));
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"]'), t = a && tabFrom(a.getAttribute('href').slice(1).replace(/^tab=/, ''));
    if (t) { e.preventDefault(); showTab(t); }
  });
  // #injuries&dept=SG%26A, or the old #tab=s7 form
  showTab(tabFrom(q.get('tab')) || [...q.keys()].map(tabFrom).find(Boolean) || 's0', false);
  el('notes').innerHTML = D.meta.notes.map(n => `<li>${esc(n)}</li>`).join('');
  el('footer-line').textContent = `As of ${D.meta.as_of}. Source: HR separations and hires log, aggregated ${D.meta.as_of}.`;
  renderAll();
  renderSection2();
  renderSection4();
  renderSection6();
  const checks = calc.selfCheck(D), bad = checks.filter(c => !c.ok);
  window.__checks = checks;
  console[bad.length ? 'error' : 'info'](`Acceptance checks: ${checks.length - bad.length}/${checks.length} passed`, bad);
}

// Prefer the JSON file (GitHub Pages); fall back to the inlined copy when fetch is blocked (file://).
// no-cache: always ask the server whether the data changed, so a refresh never shows yesterday's numbers.
fetch('data/turnover-data.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(init).catch(() => init(window.TURNOVER_DATA));
}
// The concept page (concept/index.html) sets TURNOVER_NO_UI and draws its own screen from the same calc and data.
if (typeof document !== 'undefined' && !(typeof window !== 'undefined' && window.TURNOVER_NO_UI)) ui();
