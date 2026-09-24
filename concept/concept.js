/* Concept screen: every number comes from calc (../app.js) and the same data file as the live dashboard. */
'use strict';
(() => {
  const C = { red: '#CF102D', redDark: '#A91623', ink: '#323E48', ink2: '#56626C', muted: '#6B7780', line: '#E1E5E8', ret: '#B9C2C9', teal: '#1F8A8A' };
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = s => document.querySelector(s);
  const pct = (v, d = 0) => (v == null ? null : (v * 100).toFixed(d) + '%');
  const num = v => (v == null ? '' : String(+(+v).toFixed(1)));
  const MON = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December' };
  const full = l => { const [m, y] = l.split(' '); return `${MON[m]} ${y}`; };
  const na = why => `<span class="na" title="${why}">n/a</span>`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  let D, S;
  const last = () => D.meta.months.length;
  const seg = () => calc.wcSeg(S);
  const deptWord = () => ({ 'All MFG': 'manufacturing', Packaging: 'Packaging', Processing: 'Processing', 'SG&A': 'SG&A' }[S.dept]);
  const rangeWord = () => (S.m0 === S.m1 ? `in ${full(D.meta.months[S.m0 - 1])}` : `from ${full(D.meta.months[S.m0 - 1])} to ${full(D.meta.months[S.m1 - 1])}`);

  // ---------- charts ----------
  Chart.defaults.font.family = '"IBM Plex Sans", Arial, Helvetica, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = C.muted;
  Chart.defaults.scale.grid.color = '#EEF1F3';
  Chart.defaults.scale.border.display = false;
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.plugins.tooltip.backgroundColor = C.ink;
  Chart.defaults.plugins.tooltip.cornerRadius = 6;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.datasets.bar.borderRadius = 3;
  Chart.defaults.datasets.bar.maxBarThickness = 44;
  const ANIM = REDUCED ? false : { duration: 650, easing: 'easeOutQuart', delay: c => (c.type === 'data' && c.mode === 'default' ? c.dataIndex * 35 : 0) };
  // Total above each stack / value above each bar, in text ink (never the series color).
  const topLabels = { id: 'topLabels', afterDatasetsDraw(ch) {
    const { ctx } = ch, n = ch.data.labels.length, stacked = ch.options.scales.y.stacked;
    ctx.save(); ctx.font = '600 12px "IBM Plex Sans", Arial'; ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (let i = 0; i < n; i++) {
      const vis = ch.data.datasets.map((d, k) => [d, ch.getDatasetMeta(k)]).filter(([, m]) => !m.hidden);
      const tot = stacked ? vis.reduce((a, [d]) => a + (d.data[i] || 0), 0) : null;
      if (stacked) { if (!tot) continue; const top = Math.min(...vis.map(([, m]) => m.data[i].y)); ctx.fillText(tot, vis[0][1].data[i].x, top - 4); }
      else vis.forEach(([d, m]) => { if (d.data[i]) ctx.fillText(d.data[i], m.data[i].x, m.data[i].y - 4); });
    }
    ctx.restore();
  } };
  Chart.register(topLabels);
  const charts = {};
  const draw = (id, cfg) => { if (charts[id]) charts[id].destroy(); cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: ANIM, layout: { padding: { top: 18 } } }, cfg.options); charts[id] = new Chart($(id), cfg); };
  const monthTick = { autoSkip: false, maxRotation: 0, callback(v, i) { const [m, y] = this.getLabelForValue(v).split(' '); return i === 0 || m === 'Jan' ? [m, y] : m; } };

  // ---------- state ----------
  const setState = patch => {
    S = { ...S, ...patch };
    if (S.m0 > S.m1) [S.m0, S.m1] = [S.m1, S.m0];
    const q = new URLSearchParams();
    if (S.dept !== 'All MFG') q.set('dept', S.dept);
    if (S.cat !== 'All') q.set('cat', S.cat);
    if (S.tenure !== 'All') q.set('tenure', S.tenure);
    if (S.m0 !== 1 || S.m1 !== last()) q.set('m', `${S.m0}-${S.m1}`);
    history.replaceState(null, '', q.toString() ? '#' + q : location.pathname);
    $('#to-classic').href = '../' + (q.toString() ? '#' + q : ''); // same filters in the classic view
    render();
  };

  // ---------- controls ----------
  let drag = null;
  function renderTimeline() {
    const f = calc.pred(S, ['months']), counts = D.meta.months.map((_, i) => calc.sum(D, r => f(r) && r.month === i + 1)), mx = Math.max(...counts, 1);
    $('#timeline').classList.toggle('all', S.m0 === 1 && S.m1 === last());
    $('#timeline').innerHTML = D.meta.months.map((l, i) => {
      const m = i + 1, on = m >= S.m0 && m <= S.m1;
      return `<button type="button" class="tl-cell" data-m="${m}" aria-pressed="${on}" aria-label="${full(l)}: ${plural(counts[i], 'separation', 'separations')}">
        <span class="tl-n">${counts[i]}</span><span class="tl-plot"><span class="tl-bar" style="height:${Math.max(6, counts[i] / mx * 100)}%"></span></span><span class="tl-m">${l.slice(0, 3)}${i === 0 || l.startsWith('Jan') ? ' ' + l.slice(-2) : ''}</span></button>`;
    }).join('');
  }
  function wireTimeline() {
    const cellOf = e => e.target.closest('.tl-cell');
    $('#timeline').addEventListener('pointerdown', e => {
      const c = cellOf(e); if (!c) return; e.preventDefault();
      const m = +c.dataset.m; drag = { anchor: m, wasSingle: S.m0 === m && S.m1 === m, moved: false };
      setState({ m0: m, m1: m });
    });
    $('#timeline').addEventListener('pointerover', e => {
      const c = cellOf(e); if (!drag || !c) return;
      const m = +c.dataset.m; if (m !== drag.anchor) drag.moved = true;
      if (m !== S.m1 || drag.anchor !== S.m0) setState({ m0: Math.min(drag.anchor, m), m1: Math.max(drag.anchor, m) });
    });
    window.addEventListener('pointerup', () => { if (drag && drag.wasSingle && !drag.moved) setState({ m0: 1, m1: last() }); drag = null; });
    $('#timeline').addEventListener('click', e => { // keyboard: Enter / Space picks one month, again resets
      const c = cellOf(e); if (!c || e.detail !== 0) return;
      const m = +c.dataset.m; setState(S.m0 === m && S.m1 === m ? { m0: 1, m1: last() } : { m0: m, m1: m });
    });
  }
  function pills(id, label, key, options) {
    $(id).innerHTML = `<span class="pl">${label}</span>` + options.map(([v, t]) => `<button type="button" class="pill" data-k="${key}" data-v="${v}" aria-pressed="${S[key] === v}">${t}</button>`).join('');
  }

  // ---------- tiles ----------
  function renderLede(y, monthly) {
    const peak = monthly.reduce((a, b) => (b.total > a.total ? b : a), monthly[0]);
    const extra = [S.cat === 'All' ? '' : S.cat.toLowerCase(), S.tenure === 'All' ? '' : S.tenure === 'Over 180 days' ? 'after 180 days' : `within ${S.tenure.replace(' days', '').replace('0-', '')} days`].filter(Boolean);
    let t = `<strong>${y.seps}</strong> ${y.seps === 1 ? 'person' : 'people'} left ${deptWord()}${extra.length ? ` (${extra.join(', ')})` : ''} ${rangeWord()}`;
    t += y.rate != null && S.cat === 'All' && S.tenure === 'All' ? `, <strong>${pct(y.rate)}</strong> of average headcount.` : '.';
    if (monthly.length > 1 && peak.total) t += ` The worst month was <span class="hl">${full(peak.label)}</span>, with ${peak.total}.`;
    $('#lede').innerHTML = t;
  }
  function renderMonth(monthly) {
    const peak = monthly.reduce((a, b) => (b.total > a.total ? b : a), monthly[0]), prev = monthly[monthly.indexOf(peak) - 1];
    $('#t-month-h').textContent = !peak.total ? 'No separations match these filters.'
      : prev && prev.total && peak.total / prev.total >= 1.95 ? `${full(peak.label)} had ${peak.total} separations, ${Math.round(peak.total / prev.total)} times ${full(prev.label)}.`
        : `${full(peak.label)} had the most separations (${peak.total}).`;
    const color = c => (S.cat === 'All' || S.cat === c ? { Voluntary: C.red, Involuntary: C.ink, Retirement: C.ret }[c] : '#E4E8EB');
    draw('#c-month', { type: 'bar', data: { labels: monthly.map(x => x.label), datasets: CATS.map(c => ({ label: c, data: monthly.map(x => x[c]), backgroundColor: color(c), stack: 's', borderRadius: 0, borderSkipped: false })) },
      options: { scales: { x: { stacked: true, grid: { display: false }, ticks: monthTick }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grace: '10%' } },
        plugins: { legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: false } },
          tooltip: { callbacks: { footer: it => { const x = monthly[it[0].dataIndex]; return x.rate == null ? 'Turnover: n/a (no headcount yet)' : `Turnover: ${pct(x.rate, 1)} of ${x.hc}`; } } } },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        onClick: (e, els) => { if (!els.length) return; const m = monthly[els[0].index].month; setTimeout(() => setState(S.m0 === m && S.m1 === m ? { m0: 1, m1: last() } : { m0: m, m1: m }), 0); } } });
  }
  function renderStats(y) {
    const t = calc.tenure(D, { ...S, tenure: 'All' }), all = t.reduce((a, b) => a + b.n, 0);
    const scope = S.dept === 'SG&A' ? 'sga' : S.dept === 'All MFG' ? 'all' : 'frontline', co = calc.cohorts(D, scope, 'All', S.m0, S.m1).total, w = calc.wc(D, S);
    const stat = (v, l, s, lead) => `<div class="stat${lead ? ' lead' : ''}"><span class="v">${v ?? na('No headcount reported')}</span><span class="l">${l}</span><span class="s">${s}</span></div>`;
    $('#t-stats').innerHTML =
      stat(pct(y.rate), 'Turnover rate', y.avg ? `${y.seps} separations ÷ ${num(y.avg)} average headcount` : 'no headcount for these months', true) +
      stat(all ? pct(t[0].n / all) : na('No separations'), 'Gone within 30 days', `${t[0].n} of ${all} leavers`) +
      stat(co.hires ? pct(co.still_employed / co.hires) : na('No hires'), 'Hires still employed', `${co.still_employed} of ${co.hires} ${S.dept === 'SG&A' ? 'SG&A' : S.dept === 'All MFG' ? 'MFG' : 'Packaging + Processing'} hires`) +
      stat(w.per100 == null ? null : w.per100.toFixed(1), 'Injuries per 100 people', `${plural(w.injuries, 'injury', 'injuries')}, ${w.lost} lost and ${w.restricted} restricted days (${w.seg})`);
  }
  function hbars(id, rows, onPick) {
    const mx = Math.max(...rows.map(r => r.n), 1);
    $(id).innerHTML = rows.map((r, i) => `<${onPick ? 'button type="button"' : 'div'} class="bar" data-i="${i}"${onPick ? ` aria-pressed="${!!r.on}"` : ''}>
      <span class="bar-l" title="${r.label}">${r.label}</span><span class="bar-t"><span class="bar-f${r.hot ? ' hot' : ''}" style="width:${r.n / mx * 100}%;animation-delay:${i * 40}ms"></span></span>
      <span class="bar-v">${r.n} <small>${r.share != null ? pct(r.share) : ''}</small></span></${onPick ? 'button' : 'div'}>`).join('');
    if (onPick) $(id).querySelectorAll('button.bar').forEach(b => { b.onclick = () => onPick(rows[+b.dataset.i]); });
  }
  function renderTenure() {
    const t = calc.tenure(D, { ...S, tenure: 'All' }), tot = t.reduce((a, b) => a + b.n, 0), w180 = t[0].n + t[1].n + t[2].n;
    $('#t-tenure-h').textContent = tot ? `${pct(w180 / tot)} left within 180 days; ${pct(t[0].share)} within 30.` : 'No separations match these filters.';
    hbars('#b-tenure', t.map((x, i) => ({ label: x.bucket, n: x.n, share: x.share, hot: i === 0, on: S.tenure === x.bucket, v: x.bucket })), r => setState({ tenure: S.tenure === r.v ? 'All' : r.v }));
  }
  function renderReasons() {
    const r = calc.reasons(D, S), top = r.list.slice(0, 5), frontline = r.depts.includes('Packaging') || r.depts.includes('Processing');
    $('#t-reasons-h').textContent = !r.total ? 'No coded reasons for these filters.' : frontline ? `Attendance and abandonment: ${pct(r.attnShare)} of exits (${r.attn} of ${r.total}).` : `${r.list[0].reason} is the top reason (${r.list[0].n} of ${r.total}).`;
    $('#t-reasons-hint').textContent = `Coded exit reasons, ${r.depts.join(' + ')}${r.list.length > 5 ? `, top 5 of ${r.list.length}` : ''}${S.cat === 'All' ? '' : ', ' + S.cat.toLowerCase()}${S.tenure === 'All' ? '' : ', ' + S.tenure}.`;
    // one row per reason name (the log codes a few reasons both ways; Details shows the split)
    const merged = [...top.reduce((m, x) => m.set(x.reason, (m.get(x.reason) || 0) + x.n), new Map())].map(([label, n]) => ({ label, n, share: r.total ? n / r.total : 0, hot: label === 'Poor Attendance' || label === 'Job Abandonment' }));
    hbars('#b-reasons', merged);
  }
  function renderShift() {
    if (S.dept === 'SG&A') { $('#t-shift-h').textContent = 'Shift is not recorded for SG&A.'; $('#h-shift').innerHTML = '<div class="empty" style="grid-column:1/-1">Pick All MFG, Packaging or Processing to compare shifts.</div>'; return; }
    const st = calc.shiftTable(D, S), mx = Math.max(...st.map(x => x.ratio || 0), .01), top = [...st].sort((a, b) => b.ratio - a.ratio)[0];
    $('#t-shift-h').textContent = top && top.seps ? `${top.label} loses the most per head: ${pct(top.ratio)} of its roster.` : 'No shift separations in these months.';
    const cell = (dept, shift) => {
      const x = st.find(r => r.dept === dept && r.shift === shift), a = x.ratio ? .12 + .88 * x.ratio / mx : .06, dark = a > .78; // white text only on the deepest red, where it clears 4.5:1
      return `<button type="button" class="cell" data-dept="${dept}" aria-pressed="${S.dept === dept}" style="background:rgba(207,16,45,${a.toFixed(2)});color:${dark ? '#fff' : C.ink}"
        aria-label="${x.label}: ${x.seps} separations, ${pct(x.ratio)} of an average roster of ${num(x.avg)}"><b>${pct(x.ratio) ?? 'n/a'}</b><span>${x.seps} of ${num(x.avg)} avg</span></button>`;
    };
    $('#h-shift').innerHTML = `<span></span><span class="hh">Day shift</span><span class="hh">Mid-shift</span>` +
      ['Packaging', 'Processing'].map(d => `<span class="hr">${d}</span>${cell(d, 'Day Shift')}${cell(d, 'Mid-Shift')}`).join('');
    $('#h-shift').querySelectorAll('.cell').forEach(b => { b.onclick = () => setState({ dept: S.dept === b.dataset.dept ? 'All MFG' : b.dataset.dept }); });
  }
  function renderRetention() {
    const scope = S.dept === 'SG&A' ? 'sga' : S.dept === 'All MFG' ? 'all' : 'frontline', T = calc.cohorts(D, scope, 'All', S.m0, S.m1).total;
    const best = [180, 90, 30].find(n => T['eligible_' + n]);
    $('#t-retention-h').textContent = !T.hires ? 'No hires in these months.' : best ? `${pct(T['r' + best])} of hires reached ${best} days (${T['retained_' + best]} of ${T['eligible_' + best]}).` : `${T.hires} hires, none with us 30 days yet.`;
    const step = (l, r, sub, i) => `<div class="step"><span class="step-l">${l}</span><span class="step-t"><span class="step-f" style="width:${r == null ? 0 : r * 100}%;animation-delay:${i * 60}ms"></span></span><span class="step-v">${r == null ? na('Nobody with us that long yet') : pct(r)}<small>${sub}</small></span></div>`;
    $('#f-retention').innerHTML = step('Hired', T.hires ? 1 : null, plural(T.hires, 'person', 'people'), 0) +
      [30, 90, 180].map((n, i) => step(`Stayed ${n} days`, T['eligible_' + n] ? T['r' + n] : null, T['eligible_' + n] ? `${T['retained_' + n]} of ${T['eligible_' + n]}` : '', i + 1)).join('');
  }
  function renderInjury() {
    const w = calc.wc(D, S), have = w.periods.filter(p => p.wc), labels = w.periods.map(p => p.label);
    const pk = (arr, f) => { const mx = Math.max(...arr.map(f)); return { mx, at: arr.filter(p => f(p) === mx).map(p => full(p.label)) }; };
    const pi = pk(have, p => p.wc.injuries), ps = pk(have, p => p.seps);
    $('#t-injury-h').textContent = !have.length || !pi.mx ? `No ${w.seg} injuries recorded ${rangeWord()}.`
      : pi.at.length === 1 && ps.at.length === 1 && pi.at[0] === ps.at[0] ? `Injuries and separations both peaked in ${pi.at[0]}.` : `Injuries peaked in ${pi.at.join(', ')}; separations in ${ps.at.join(', ')}.`;
    $('#t-injury-hint').textContent = `Workers' comp, ${w.seg}${S.dept === 'Packaging' || S.dept === 'Processing' ? ' (recorded for all of MFG, not by department)' : ''}. Same months, separate scales.`;
    const opt = { scales: { x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, callback(v) { return this.getLabelForValue(v).slice(0, 3); } } }, y: { beginAtZero: true, ticks: { precision: 0, maxTicksLimit: 4 } } } };
    draw('#c-inj', { type: 'bar', data: { labels, datasets: [{ label: 'Injuries', data: w.periods.map(p => (p.wc ? p.wc.injuries : null)), backgroundColor: C.ink }] }, options: { ...opt, scales: { ...opt.scales, y: { ...opt.scales.y, suggestedMax: 3 } } } });
    draw('#c-sep', { type: 'bar', data: { labels, datasets: [{ label: 'Separations', data: w.periods.map(p => p.seps), backgroundColor: C.red }] }, options: opt });
    const c = calc.wcCorrelation(D, S);
    $('#t-injury-r').innerHTML = c.r == null ? `Only ${plural(c.n, "month", "months")} with both figures here, too few for a correlation.`
      : `MFG correlation r = <strong>${c.r.toFixed(2)}</strong> over ${c.n} months${c.without && c.without.r != null ? `; without ${full(c.without.label)}, r = ${c.without.r.toFixed(2)}` : ''}. A correlation on a sample this small is a signal to investigate, not proof of cause.`;
  }
  function renderNewInjury() {
    const t = calc.injuryLead(D, S, false);
    $('#t-newinj-h').textContent = t.title;
    $('#t-newinj-vs').innerHTML = t.known && t.wfShare != null ? `<div><b>${pct(t.wfShare)}</b><span>of ${t.seg} workers are new</span></div><div class="hot"><b>${pct(t.injShare)}</b><span>of ${t.seg} injuries were new employees (${t.first180} of ${t.known})</span></div>` : '';
    $('#t-newinj-n').textContent = t.note;
    $('#t-newinj-n').hidden = !t.note;
  }
  function hcSeries() { return D.headcount_start_of_month[HC_KEY[S.dept]]; }
  function renderBridge() {
    const hc = hcSeries(), pts = D.meta.months.map((l, i) => ({ l, v: hc[i], m: i + 1 })).filter(p => p.m >= S.m0 && p.m <= S.m1);
    const known = pts.filter(p => p.v != null), a = known[0], b = known[known.length - 1];
    $('#t-bridge-h').textContent = !a ? 'No headcount reported for these months.' : a === b ? `${a.v} people at the start of ${full(a.l)}.` : `Headcount went from ${a.v} in ${full(a.l)} to ${b.v} in ${full(b.l)}.`;
    draw('#c-hc', { type: 'line', data: { labels: pts.map(p => p.l), datasets: [{ label: 'Start-of-month headcount', data: pts.map(p => p.v), borderColor: C.ink, backgroundColor: 'rgba(50,62,72,.08)', fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: C.ink, spanGaps: false }] },
      options: { scales: { x: { grid: { display: false }, ticks: monthTick }, y: { grace: '15%', ticks: { precision: 0, maxTicksLimit: 4 } } } } });
  }

  // ---------- details drawer ----------
  const table = (head, rows, totalLast) => `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr${totalLast && i === rows.length - 1 ? ' class="total"' : ''}>${r.map(c => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const DETAILS = {
    month: () => ['Separations by fiscal month', `<p>${S.dept}, ${rangeWord()}. Turnover = separations ÷ start-of-month headcount.</p>` + table(['Month', 'Voluntary', 'Involuntary', 'Retirement', 'Total', 'Headcount', 'Turnover'],
      calc.monthly(D, S).map(x => [x.label, x.Voluntary, x.Involuntary, x.Retirement, x.total, x.hc ?? na('Not reported yet'), x.rate == null ? na('No headcount yet') : pct(x.rate, 1)]))],
    tenure: () => ['Time on the job at exit', `<p>${S.dept}, ${rangeWord()}, ${S.cat === 'All' ? 'all categories' : S.cat.toLowerCase()}.</p>` + table(['Time on the job', 'Leavers', 'Share'], calc.tenure(D, { ...S, tenure: 'All' }).map(x => [x.bucket, x.n, pct(x.share, 1)]))],
    reasons: () => { const r = calc.reasons(D, S); return ['Coded exit reasons', `<p>${r.depts.join(' + ')}, ${rangeWord()}. Coding quirks (one Job Abandonment coded Involuntary) are kept as recorded.</p>` + table(['Reason', 'Coded as', 'Count', 'Share'], r.list.map(x => [x.reason, x.category, x.n, pct(x.share, 1)]).concat([['Total', '', r.total, '100%']]), true)]; },
    shift: () => { const st = calc.shiftTable(D, S), sup = D.supervisors_packaging_processing;
      return ['Shifts and supervisors', `<p>Roster headcount from the monthly roster tabs. ${sup.note}</p>` + table(['Department and shift', 'Separations', 'Voluntary', 'Average roster', 'Separations ÷ roster', 'Left within 90 days'], st.map(x => [x.label, x.seps, x.vol, num(x.avg), pct(x.ratio, 1), x.left90])) +
        `<p style="margin-top:18px">Supervisors, whole period ${D.meta.months[0]} to ${D.meta.months[last() - 1]}.</p>` + table(['Supervisor', 'Department', 'Shift', 'Separations', 'Voluntary', 'Left within 90 days'], sup.rows.map(r => [r.supervisor, r.departments, r.shifts, r.separations, r.voluntary, r.left_within_90_days]))]; },
    retention: () => { const scope = S.dept === 'SG&A' ? 'sga' : S.dept === 'All MFG' ? 'all' : 'frontline', c = calc.cohorts(D, scope, 'All', S.m0, S.m1), cell = (x, n) => (x['eligible_' + n] ? `${pct(x['retained_' + n] / x['eligible_' + n])} (${x['retained_' + n]} of ${x['eligible_' + n]})` : na('Nobody with us that long yet'));
      return ['New-hire retention by hire month', '<p>Retained = still employed that many days after hire. Only hires employed long enough by the as-of date count.</p>' + table(['Hire month', 'Hires', '30 days', '90 days', '180 days', 'Still employed'],
        c.byMonth.map(x => [x.label, x.hires, cell(x, 30), cell(x, 90), cell(x, 180), x.still_employed]).concat([['Total', c.total.hires, cell(c.total, 30), cell(c.total, 90), cell(c.total, 180), c.total.still_employed]]), true)]; },
    injury: () => { const w = calc.wc(D, S);
      return [`Workers' comp, ${w.seg}`, "<p>From the Mo WC Loss Days tab of HR's monthly report. Days are recorded in the period they occur, so an injury keeps adding days later.</p>" + table(['Period', 'Injuries', 'Lost days', 'Restricted days', 'Separations', 'Turnover', 'Per 100 people'],
        w.periods.map(p => [p.label, p.wc ? p.wc.injuries : na('Not in the report yet'), p.wc ? p.wc.lost_time_days : '', p.wc ? p.wc.restricted_duty_days : '', p.seps, p.rate == null ? na('No headcount yet') : pct(p.rate, 1), p.per100 == null ? '' : p.per100.toFixed(1)]))]; },
    bridge: () => { const key = S.dept === 'SG&A' ? null : S.dept === 'All MFG' ? 'Nazdar MFG' : 'Packaging + Processing';
      if (!key) return ['Monthly bridge', '<p>The bridge is built for manufacturing only.</p>'];
      return [`Monthly bridge, ${key}`, '<p>Implied end = start + hires − separations. Gap = next month\'s reported start − implied end (likely transfers, which are tracked separately and not in these lists, or timing).</p>' + table(['Month', 'Start', 'Hires', 'Separations', 'Net', 'Implied end', 'Next start', 'Gap'],
        calc.bridge(D, key, S).map(x => [x.label, x.start ?? na('Not reported yet'), x.hires, x.seps, x.net > 0 ? '+' + x.net : x.net, x.implied ?? '', x.next ?? '', x.diff == null ? '' : x.diff > 0 ? '+' + x.diff : x.diff]))]; },
  };
  let lastFocus = null;
  function openDrawer(key) {
    const [h, body] = DETAILS[key](); $('#drawer-h').textContent = h; $('#drawer-body').innerHTML = body;
    lastFocus = document.activeElement; $('#scrim').hidden = false; $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#drawer-close').focus();
  }
  function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#scrim').hidden = true; if (lastFocus) lastFocus.focus(); }

  // ---------- render ----------
  function render() {
    pills('#p-dept', 'Department', 'dept', [['All MFG', 'All MFG'], ['Packaging', 'Packaging'], ['Processing', 'Processing'], ['SG&A', 'SG&A']]);
    pills('#p-cat', 'Category', 'cat', [['All', 'All'], ['Voluntary', 'Voluntary'], ['Involuntary', 'Involuntary'], ['Retirement', 'Retirement']]);
    pills('#p-tenure', 'Time on the job', 'tenure', [['All', 'All'], ['0-30 days', '0-30 d'], ['31-90 days', '31-90 d'], ['91-180 days', '91-180 d'], ['Over 180 days', '180+ d']]);
    renderTimeline();
    const y = calc.ytd(D, S), monthly = calc.monthly(D, S);
    renderLede(y, monthly); renderMonth(monthly); renderStats(y); renderTenure(); renderReasons(); renderShift(); renderRetention(); renderInjury(); renderNewInjury(); renderBridge();
    if ($('#drawer').classList.contains('open')) { const k = $('#drawer').dataset.key; if (k) { const [h, b] = DETAILS[k](); $('#drawer-h').textContent = h; $('#drawer-body').innerHTML = b; } }
  }

  function init(data) {
    D = data;
    const q = new URLSearchParams(location.hash.slice(1)), [a, b] = (q.get('m') || '').split('-').map(Number);
    S = { cat: q.get('cat') || 'All', dept: HC_KEY[q.get('dept')] ? q.get('dept') : 'All MFG', tenure: q.get('tenure') || 'All', m0: a || 1, m1: b || last() };
    $('#to-classic').href = '../' + location.hash;
    $('#asof').textContent = `Data as of ${new Date(D.meta.as_of + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    $('#about-basis').textContent = D.meta.basis; $('#about-notes').innerHTML = D.meta.notes.map(n => `<li>${n.replace(/</g, '&lt;')}</li>`).join('');
    document.addEventListener('click', e => {
      const p = e.target.closest('.pill'); if (p) setState({ [p.dataset.k]: p.dataset.v });
      const m = e.target.closest('.more'); if (m) { $('#drawer').dataset.key = m.dataset.detail; openDrawer(m.dataset.detail); }
    });
    $('#reset').onclick = () => setState({ cat: 'All', dept: 'All MFG', tenure: 'All', m0: 1, m1: last() });
    $('#drawer-close').onclick = closeDrawer; $('#scrim').onclick = closeDrawer;
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#drawer').classList.contains('open')) closeDrawer(); });
    wireTimeline();
    render();
    const bad = calc.selfCheck(D).filter(c => !c.ok); window.__checks = bad; console[bad.length ? 'error' : 'info'](`Acceptance checks: ${bad.length} failing`);
  }
  fetch('../data/turnover-data.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : Promise.reject(r.status))).then(init).catch(() => init(window.TURNOVER_DATA));
})();
