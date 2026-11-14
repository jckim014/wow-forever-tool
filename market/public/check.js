// Method check page: how our sale-rate estimate does against Josh's own TSM records (no names shown or kept).
import { moneyHtml } from './shared.js';
import { scatterLog } from './charts.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const when = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

const KIND_LABEL = { sale: 'Your sales', buy: 'Your buys', cancel: 'Your cancels', expiry: 'Your expiries' };
const KIND_ONE = { sale: 'sale', buy: 'buy', cancel: 'cancel', expiry: 'expiry' };
const OUTCOME = {
  certain: 'counted as sold (part of a stack was bought)',
  probable: 'counted as sold (vanished with 2+ hours left)',
  reposted: 'not counted: a cheaper listing of the same size appeared, taken for a cancel-and-repost',
  unclear: 'not counted: vanished with under 2 hours left, so it could also have expired',
  invisible: 'not checkable: never in a snapshot (listed and gone within the same hour)',
  unmatched: 'not checkable: a matching listing was there but never seen to change',
  'no-data': 'not checkable: a snapshot is missing around that time',
};
const WHY_WRONG = {
  sale: { unclear: 'Sold near the end of its listing time: hourly snapshots can\'t tell that from an expiry.', reposted: 'Taken for a repost.' },
  buy: { unclear: 'Bought near the end of its listing time: hourly snapshots can\'t tell that from an expiry.', reposted: 'Taken for a repost.' },
  cancel: { probable: 'Counted as sold: a cancellation with no cheaper repost looks exactly like a sale.' },
  expiry: { probable: 'Counted as sold: should not happen (2+ hours left can\'t expire within the hour); check the match.' },
};

let loaded = false;
export async function showCheck() {
  if (loaded) return;
  const box = $('#check');
  box.innerHTML = '<p class="mempty">Checking your TSM records against the snapshots (about 10 seconds)…</p>';
  try {
    const r = await (await fetch('/api/method-check')).json();
    if (r.error) throw new Error(r.error);
    render(box, r);
    loaded = true;
  } catch (e) {
    box.innerHTML = `<p class="mempty">The check failed: ${esc(e.message)}</p>`;
  }
}

function render(box, r) {
  const s = r.summary;
  const g = (k, f) => s[k]?.[f] ?? 0;
  const detected = g('sale', 'right') + g('buy', 'right'), judged = detected + g('sale', 'wrong') + g('buy', 'wrong');
  const notCheckable = Object.values(s).reduce((n, x) => n + x.invisible + x.unmatched + x.noData, 0);
  const wrongList = r.results.filter((x) => !x.right && !['invisible', 'unmatched', 'no-data'].includes(x.outcome));

  box.innerHTML = `
    <div class="mcheck">
      <p class="mlead">Method version ${r.method}, checked against <strong>${r.records}</strong> of your TSM records between
        ${esc(when(r.from))} and ${esc(when(r.to))}. Your records are only used to test the method; they don't feed the estimate.</p>
      <div class="mtiles">
        <div class="mtile"><div class="mtile-v">${pct(detected, judged)}</div><div class="mtile-l">of your sales and buys detected<br><span>${detected} of ${judged}</span></div></div>
        <div class="mtile"><div class="mtile-v">${g('cancel', 'wrong')} of ${g('cancel', 'right') + g('cancel', 'wrong')}</div><div class="mtile-l">of your cancels wrongly counted as sales</div></div>
        <div class="mtile"><div class="mtile-v">${g('expiry', 'wrong')} of ${g('expiry', 'right') + g('expiry', 'wrong')}</div><div class="mtile-l">of your expiries wrongly counted as sales</div></div>
        <div class="mtile"><div class="mtile-v">${notCheckable}</div><div class="mtile-l">not checkable<br><span>listed and gone within an hour, or a missing snapshot</span></div></div>
      </div>

      <h3>By record type</h3>
      <table class="mtable">
        <tr><th>Record</th><th>Right</th><th>Wrong</th><th>Not checkable</th><th>What the estimate made of them</th></tr>
        ${Object.entries(KIND_LABEL).map(([k, label]) => {
          const x = s[k];
          if (!x) return `<tr><td>${label}</td><td colspan="4" class="blank">none yet</td></tr>`;
          return `<tr><td>${label}</td><td>${x.right}</td><td>${x.wrong}</td><td>${x.invisible + x.unmatched + x.noData}</td>
            <td class="mleft">${Object.entries(x.byOutcome).map(([o, n]) => `${n} ${esc(o)}`).join(' · ')}</td></tr>`;
        }).join('')}
      </table>

      <h3>Where it went wrong (${wrongList.length})</h3>
      ${wrongList.length ? `<table class="mtable">
        <tr><th>When</th><th class="mleft">Record</th><th class="mleft">Item</th><th>Size</th><th title="As TSM recorded it: for sales, what you received after the 5% AH cut">Price (TSM)</th><th class="mleft">Why</th></tr>
        ${wrongList.map((x) => `<tr><td>${esc(when(x.time))}</td><td class="mleft">${esc(KIND_ONE[x.kind])}</td>
          <td class="mleft">${esc(x.name)}</td><td>${x.stack}${x.count > 1 ? ` ×${x.count}` : ''}</td><td>${x.price === null ? '' : moneyHtml(x.price)}</td>
          <td class="mleft">${esc(WHY_WRONG[x.kind]?.[x.outcome] ?? OUTCOME[x.outcome] ?? x.outcome)}</td></tr>`).join('')}
      </table>` : '<p class="mempty">Nothing wrong among the checkable records.</p>'}

      <h3>Versions</h3>
      <table class="mtable">
        <tr><th>Version</th><th>Sales + buys detected</th><th>Cancels counted as sales</th><th>Expiries counted as sales</th><th class="mleft">What changed</th></tr>
        ${r.history.map((h) => {
          const x = h.summary;
          const d = x.sale.right + x.buy.right, j = d + x.sale.wrong + x.buy.wrong;
          return `<tr><td>v${h.version}${h.version === r.method ? ' (current)' : ''}</td><td>${pct(d, j)} (${d} of ${j})</td>
            <td>${x.cancel.wrong} of ${x.cancel.right + x.cancel.wrong}</td><td>${x.expiry.wrong} of ${x.expiry.right + x.expiry.wrong}</td>
            <td class="mleft">${esc(h.note)}</td></tr>`;
        }).join('')}
      </table>

      <h3>Sanity check against TSM, every item</h3>
      <p class="mnote">Each dot is an item: our estimate (both factions, units per day that left early, from ${r.hours} hours of data)
        against TSM's region sold per day. They measure different things (NA PvE vs TSM users across the region), so only
        the ordering should agree. Rank agreement: <strong>${r.agreement === null ? '—' : r.agreement.toFixed(2)}</strong>
        (1 = same order, 0 = unrelated), over ${r.points.length.toLocaleString()} items.</p>
      <div id="c-scatter"></div>
      <details class="mtablewrap"><summary>Show the outcome of every record</summary>
        <table class="mtable">
          <tr><th>When</th><th class="mleft">Record</th><th class="mleft">Item</th><th>Size</th><th class="mleft">Outcome</th></tr>
          ${r.results.map((x) => `<tr><td>${esc(when(x.time))}</td><td class="mleft">${esc(KIND_ONE[x.kind])}</td>
            <td class="mleft">${esc(x.name)}</td><td>${x.stack}${x.count > 1 ? ` ×${x.count}` : ''}</td>
            <td class="mleft">${x.right ? '✓ ' : ''}${esc(OUTCOME[x.outcome] ?? x.outcome)}${x.ambiguous ? ' (several matching listings)' : ''}</td></tr>`).join('')}
        </table>
      </details>
    </div>`;
  scatterLog($('#c-scatter'), {
    points: r.points.map(([, ours, tsm, name]) => ({ x: tsm, y: ours, label: name })),
    xLabel: 'TSM region sold per day', yLabel: 'our estimate per day',
  });
}
