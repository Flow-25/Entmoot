'use strict';

// Routes: "/" → create moot, "/m/:id" → vote / results, "/m/:id/admin/:token" → admin view.
const app = document.getElementById('app');
const POLL_MS = 4000;

const state = {
  id: null,
  token: null, // voter token for this moot
  adminToken: null,
  moot: null, // last server view of the moot
  snapshot: '', // JSON of `moot`, to skip re-rendering identical polls
  draft: null, // ballot being edited
  confirmClose: false,
  busy: false,
  pollTimer: null,
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const METHODS = {
  approval: {
    name: 'Approval',
    glyph: '✓',
    blurb: 'Tick every option you would be happy with. Most ticks wins.',
    how: 'Tick every choice you would be happy with.',
  },
  ranked: {
    name: 'Ranked',
    glyph: '1·2·3',
    blurb: 'Order the options from best to worst. Counted with the Schulze method.',
    how: 'Put the choices in order, best first. Anything you leave unranked counts as tied last.',
  },
  score: {
    name: 'Score',
    glyph: '★',
    blurb: 'Rate each option from 0 to 5. Highest total wins.',
    how: 'Rate every choice. Unrated choices count as zero.',
  },
};

// ---- scenery ---------------------------------------------------------------

const EMBLEM = `
<svg class="emblem" viewBox="0 0 120 120" role="img" aria-label="An old tree with watchful eyes">
  <g class="emblem-canopy">
    <circle cx="60" cy="30" r="24"/><circle cx="36" cy="42" r="19"/><circle cx="84" cy="42" r="19"/>
    <circle cx="46" cy="22" r="15"/><circle cx="75" cy="21" r="15"/><circle cx="24" cy="56" r="11"/>
    <circle cx="96" cy="56" r="11"/>
  </g>
  <g class="emblem-canopy-hi">
    <circle cx="52" cy="24" r="9"/><circle cx="78" cy="34" r="8"/><circle cx="36" cy="40" r="7"/>
  </g>
  <path class="emblem-trunk" d="M46 112 Q53 90 49 68 L33 50 l5 -4 L53 58 L56 36 h7 L66 58 L81 45 l5 4 L71 68 Q67 90 74 112 q9 -1 14 4 H32 q5 -5 14 -4 Z"/>
  <path class="emblem-bark" d="M56 104 q2 -10 0 -18 M64 106 q-1 -8 1 -14 M52 74 q7 4 16 0 M57 90 q3 5 6 0"/>
  <circle class="emblem-eye" cx="55" cy="80" r="2.4"/><circle class="emblem-eye" cx="65" cy="80" r="2.4"/>
</svg>`;

// Deterministic pseudo-random numbers so the forest looks the same on every visit.
function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildScene() {
  const rnd = mulberry(1954);
  const W = 1600;
  const H = 300;
  const layer = (cls, count, minH, maxH, ground) => {
    let out = `<g class="${cls}"><path d="M0 ${H} V${H - ground} Q${W / 4} ${H - ground - 18} ${W / 2} ${H - ground} T${W} ${H - ground} V${H} Z"/>`;
    for (let i = 0; i < count; i++) {
      const x = ((i + 0.15 + rnd() * 0.7) / count) * W;
      const h = minH + rnd() * (maxH - minH);
      const r = h * (0.26 + rnd() * 0.12);
      const base = H - ground + 6;
      const top = base - h;
      const tw = 3 + h * 0.05;
      out += `<path d="M${x - tw} ${base} L${x - tw * 0.5} ${top + r} h${tw} L${x + tw} ${base} Z"/>`;
      out += `<ellipse cx="${x}" cy="${top + r * 0.9}" rx="${r}" ry="${r * 0.9}"/>`;
      out += `<circle cx="${x - r * 0.75}" cy="${top + r * 1.35}" r="${r * 0.62}"/>`;
      out += `<circle cx="${x + r * 0.75}" cy="${top + r * 1.3}" r="${r * 0.62}"/>`;
    }
    return out + '</g>';
  };
  const forest = `<svg class="forest" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">${
    layer('far', 20, 150, 240, 40)}${layer('mid', 17, 110, 190, 26)}${layer('near', 14, 60, 130, 12)}</svg>`;

  // Fireflies by night, drifting leaves by day (styled per theme in CSS).
  let motes = '';
  for (let i = 0; i < 14; i++) {
    motes += `<span class="mote" style="--x:${(rnd() * 100).toFixed(1)}%;--y:${(8 + rnd() * 80).toFixed(1)}%;--d:${(9 + rnd() * 12).toFixed(1)}s;--delay:-${(rnd() * 20).toFixed(1)}s;--s:${(0.7 + rnd() * 0.8).toFixed(2)}"></span>`;
  }
  document.getElementById('scene').innerHTML = `<div class="motes">${motes}</div>${forest}`;
}

// ---- small UI helpers ------------------------------------------------------

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, isError ? 5000 : 2600);
}

const themeLabel = () => (document.documentElement.dataset.theme === 'light' ? '☾ Night' : '☀ Day');

const topbar = () => `
  <nav class="topbar">
    <a class="brand" href="/" data-nav><span class="brand-leaf">❦</span> Entmoot</a>
    <span class="topbar-tools">
      <a class="ghost small button" href="/#guide" data-nav>What is this?</a>
      <button class="ghost small" type="button" data-act="theme" aria-label="Switch between day and night">${themeLabel()}</button>
    </span>
  </nav>`;

const footer = () => `<footer class="foot"><span class="orn">❧</span> “Do not be hasty.” <span class="orn flip">❧</span></footer>`;

async function api(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (state.adminToken) headers['X-Admin-Token'] = state.adminToken;
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('The forest is silent — could not reach the server.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || 'Something went wrong.'), { status: res.status });
  return json;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Link copied.');
}

// ---- guide: "What is this?" ------------------------------------------------

// Screenshots come in a light and a dark variant; CSS shows the one matching the theme.
const guideShot = (name, alt) => `
  <img class="only-light" src="/img/guide-${name}.png" alt="${alt}" loading="lazy">
  <img class="only-dark" src="/img/guide-${name}-dark.png" alt="${alt}" loading="lazy">`;

const guideStep = (numeral, title, text, shots) => `
  <section class="guide-step">
    <div class="guide-text">
      <span class="step-n">${numeral}</span>
      <h3>${title}</h3>
      ${text}
    </div>
    <figure>${shots}</figure>
  </section>`;

const guide = () => `
  <details class="guide" id="guide">
    <summary><span><span class="orn">❦</span> What is this?</span><small>A short walk through the forest</small></summary>
    <div class="guide-body">
      <p class="guide-intro">Entmoot is a small tool for <b>deciding things together</b>: where to go, what to eat,
        which name to pick. One person asks the question, everyone else votes through a shared link.
        There are no accounts and nothing to install. It is named after the gathering of the Ents in
        Fangorn — who took their time, and then acted.</p>

      ${guideStep('I', 'Call a moot', `
        <p>Write the <b>question</b>, list the <b>choices</b>, and pick how the votes are counted
          (the three methods are shown in step IV).</p>
        <p>Two switches shape the moot:</p>
        <ul>
          <li><b>Open options</b> — everyone who joins may add choices of their own.</li>
          <li><b>Secret ballots</b> — everyone sees <i>who</i> has voted, but never <i>how</i>.
            Left off, each ballot is shown by name.</li>
        </ul>`, guideShot('call', 'The form for calling a moot, filled in with a question and three choices'))}

      ${guideStep('II', 'Keep your two links', `
        <p>Once the moot is called you become its <b>keeper</b> and get two links:</p>
        <ul>
          <li>The <b>moot link</b> is for everyone. Send it to the group.</li>
          <li>The <b>admin link</b> is for you alone. It is the only way to <b>close the moot</b>, and it
            lets you add or remove choices while voting is open.</li>
        </ul>
        <p>The browser you called the moot from remembers that you are the keeper, but save the admin
          link anyway — there is no other way to get it back.</p>`,
        guideShot('keeper', 'The keeper panel with the moot link, the admin link and the button that closes the moot'))}

      ${guideStep('III', 'Join under a name', `
        <p>Anyone with the moot link types a <b>name</b> and is in. That is the whole sign-up.</p>
        <p>A <b>password</b> is optional. With one, nobody else can use your name to change your ballot.
          It cannot be reset, so pick something you will remember.</p>
        <p>Come back later with the same name and your ballot is waiting for you. Your browser also
          remembers who you are in each moot.</p>
        <p>Below the ballot, everyone can see who has gathered: <b>✓</b> has voted, <b>…</b> is still pondering.</p>`,
        guideShot('join', 'The join form with a name and an optional password') +
        guideShot('gathered', 'The list of participants, with a tick next to those who have voted'))}

      <section class="guide-step wide">
        <div class="guide-text">
          <span class="step-n">IV</span>
          <h3>Cast your vote</h3>
          <p>The ballot looks different depending on the method the keeper chose.</p>
        </div>
        <div class="guide-methods">
          <figure>${guideShot('approval', 'An approval ballot with two of three choices ticked')}
            <figcaption><b>Approval</b> Tick every choice you would be happy with — one, some, or all.
              The choice with the most ticks wins. Good for quick, low-stakes decisions.</figcaption></figure>
          <figure>${guideShot('ranked', 'A ranked ballot with two choices in order and one not yet ranked')}
            <figcaption><b>Ranked</b> Tap the choices from best to worst, and reorder with the arrows.
              Whatever you leave unranked counts as tied last. Votes are counted with the
              <i>Schulze method</i>: every pair of choices is compared head to head, and a choice that beats
              each of the others one-on-one always wins.</figcaption></figure>
          <figure>${guideShot('score', 'A score ballot with each choice rated from zero to five')}
            <figcaption><b>Score</b> Rate every choice from 0 to 5. The highest total wins.
              Good when you care how <i>much</i> people like each choice, not only in which order.</figcaption></figure>
        </div>
      </section>

      ${guideStep('V', 'Watch the standings', `
        <p>Until you have voted, the standings stay <b>hidden</b>, so that nobody is swayed by how
          things are going.</p>
        <p>After you vote they appear, and the page <b>refreshes by itself</b> as others vote.</p>
        <p>You may <b>change your vote</b> at any time until the moot is closed. That does mean someone
          could vote, look, and vote again — a moot trusts the people in it.</p>`,
        guideShot('veil', 'The standings panel, hidden until you have voted') +
        guideShot('standings', 'The standings after voting, with a bar for each choice and the current leader'))}

      ${guideStep('VI', 'Reach the decision', `
        <p>When everyone has had their say, the keeper <b>closes the moot</b>. Ballots are frozen and the
          final result is shown to everyone who opens the link — voter or not.</p>
        <ul>
          <li>Choices that are level <b>share a place</b>; there is no tie-break.</li>
          <li>Ranked moots add a <b>head to head</b> table (<i>“A beats B 4–2”</i>), so the result can be explained.</li>
          <li>Unless ballots are secret, <b>who voted how</b> is listed by name.</li>
        </ul>
        <p>A closed moot stays readable for <b>30 days</b> and is then deleted. A moot that is never
          closed is deleted after 180 days without activity.</p>`,
        guideShot('decision', 'The final decision with the ranking, the head to head table and each ballot by name'))}

      <p class="guide-end"><a class="primary button" href="#create-form" data-act="guide-top">Call a moot</a></p>
    </div>
  </details>`;

function openGuide() {
  const el = document.getElementById('guide');
  if (!el) return;
  el.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- home: call a moot -----------------------------------------------------

const optionRow = (n, value = '') => `
  <div class="option-row">
    <span class="leafmark">❧</span>
    <input name="option" maxlength="100" placeholder="Choice ${n}" value="${esc(value)}" autocomplete="off" aria-label="Choice ${n}">
    <button type="button" class="icon" data-act="del-row" aria-label="Remove this choice">✕</button>
  </div>`;

function renderHome() {
  document.title = 'Entmoot';
  app.innerHTML = `
  <div class="page">
    ${topbar()}
    <header class="hero">
      ${EMBLEM}
      <h1>Entmoot</h1>
      <p class="tagline">Call a moot, share the link, and let everyone have their say.<br>
        It may take as long as it needs — but it ends in a decision.</p>
    </header>

    <form class="card" id="create-form" novalidate>
      <h2><span class="orn">❦</span> Call a moot</h2>

      <label class="field">
        <span class="label">What must be decided?</span>
        <input name="question" maxlength="200" placeholder="Where do we go for the May weekend?" autocomplete="off" required>
      </label>

      <div class="field">
        <span class="label">The choices</span>
        <div id="option-rows">${optionRow(1)}${optionRow(2)}${optionRow(3)}</div>
        <button type="button" class="ghost small" data-act="add-row">+ Add another choice</button>
      </div>

      <fieldset class="field methods">
        <legend class="label">How shall the moot decide?</legend>
        <div class="method-grid">
          ${Object.entries(METHODS).map(([key, m], i) => `
          <label class="method">
            <input type="radio" name="method" value="${key}" ${i === 0 ? 'checked' : ''}>
            <span class="method-body">
              <span class="method-glyph">${m.glyph}</span>
              <b>${m.name}</b>
              <small>${m.blurb}</small>
            </span>
          </label>`).join('')}
        </div>
      </fieldset>

      <label class="switch">
        <input type="checkbox" name="openOptions">
        <span class="track"></span>
        <span><b>Open options</b><small>Anyone who joins may add choices of their own.</small></span>
      </label>
      <label class="switch">
        <input type="checkbox" name="secret">
        <span class="track"></span>
        <span><b>Secret ballots</b><small>Everyone sees who has voted, but not how.</small></span>
      </label>

      <button class="primary big" type="submit">Call the moot</button>
      <p class="hint center">No accounts, no sign-up. You will get a link to share and a private link to close the moot.</p>
    </form>

    <section class="steps">
      <div><span class="step-n">I</span><b>Call</b><small>Ask a question and name the choices.</small></div>
      <div><span class="step-n">II</span><b>Gather</b><small>Share the link. Everyone votes under a name.</small></div>
      <div><span class="step-n">III</span><b>Decide</b><small>Close the moot. The result stands.</small></div>
    </section>
    ${guide()}
    ${footer()}
  </div>`;
  if (location.hash === '#guide') openGuide();
}

function renumberRows() {
  document.querySelectorAll('#option-rows input').forEach((input, i) => {
    input.placeholder = `Choice ${i + 1}`;
    input.setAttribute('aria-label', `Choice ${i + 1}`);
  });
}

function addRow() {
  const rows = document.getElementById('option-rows');
  if (rows.children.length >= 50) return toast('A moot can have at most 50 choices.', true);
  rows.insertAdjacentHTML('beforeend', optionRow(rows.children.length + 1));
  rows.lastElementChild.querySelector('input').focus();
}

async function createMoot(form) {
  const fd = new FormData(form);
  const question = fd.get('question').trim();
  const options = fd.getAll('option').map(o => o.trim()).filter(Boolean);
  if (!question) {
    form.elements.question.focus();
    return toast('First, what must be decided?', true);
  }
  if (new Set(options.map(o => o.toLowerCase())).size < 2) return toast('A moot needs at least two different choices.', true);
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const { id, adminToken } = await api('POST', '/moots', {
      question,
      options,
      method: fd.get('method'),
      openOptions: fd.has('openOptions'),
      secret: fd.has('secret'),
    });
    navigate(`/m/${id}/admin/${adminToken}`);
  } catch (err) {
    button.disabled = false;
    toast(err.message, true);
  }
}

// ---- moot: ballots ---------------------------------------------------------

const emptyBallot = method =>
  method === 'approval' ? { approved: [] } : method === 'ranked' ? { ranking: [] } : { scores: {} };

function copyBallot(method, ballot) {
  if (!ballot) return emptyBallot(method);
  if (method === 'approval') return { approved: [...ballot.approved] };
  if (method === 'ranked') return { ranking: [...ballot.ranking] };
  return { scores: { ...ballot.scores } };
}

function sameBallot(moot, a, b) {
  if (moot.method === 'approval') {
    return a.approved.length === b.approved.length && a.approved.every(id => b.approved.includes(id));
  }
  if (moot.method === 'ranked') {
    return a.ranking.length === b.ranking.length && a.ranking.every((id, i) => b.ranking[i] === id);
  }
  return moot.options.every(o => (a.scores[o.id] || 0) === (b.scores[o.id] || 0));
}

const serverBallot = moot => copyBallot(moot.method, moot.you && moot.you.ballot);
const isDirty = () => !sameBallot(state.moot, state.draft, serverBallot(state.moot));

function setMoot(moot) {
  const hadEdits = state.moot && state.draft && state.moot.you && moot.you && isDirty();
  state.moot = moot;
  state.snapshot = JSON.stringify(moot);
  if (!moot.you && state.token) {
    state.token = null;
    store.del(`entmoot-token-${moot.id}`);
  }
  if (!hadEdits) {
    state.draft = serverBallot(moot);
  } else {
    // keep unsaved edits, minus options that no longer exist
    const ids = new Set(moot.options.map(o => o.id));
    const d = state.draft;
    if (d.approved) d.approved = d.approved.filter(id => ids.has(id));
    if (d.ranking) d.ranking = d.ranking.filter(id => ids.has(id));
    if (d.scores) for (const id of Object.keys(d.scores)) if (!ids.has(id)) delete d.scores[id];
  }
  if (moot.closed) state.confirmClose = false;
}

const addedBy = o => (o.addedBy ? `<small class="added-by">added by ${esc(o.addedBy)}</small>` : '');

function ballotEditor(moot) {
  const d = state.draft;
  if (moot.method === 'approval') {
    return `<ul class="choices">${moot.options.map(o => `
      <li><label class="choice check ${d.approved.includes(o.id) ? 'on' : ''}">
        <input type="checkbox" data-approve="${o.id}" data-fid="approve:${o.id}" ${d.approved.includes(o.id) ? 'checked' : ''}>
        <span class="box" aria-hidden="true"></span>
        <span class="choice-label">${esc(o.label)}${addedBy(o)}</span>
      </label></li>`).join('')}</ul>`;
  }

  if (moot.method === 'score') {
    const steps = Array.from({ length: moot.scoreMax + 1 }, (_, i) => i);
    return `<ul class="choices">${moot.options.map(o => {
      const value = d.scores[o.id] || 0;
      return `
      <li class="choice score">
        <span class="choice-label">${esc(o.label)}${addedBy(o)}</span>
        <span class="pips" role="group" aria-label="Score for ${esc(o.label)}">${steps.map(n => `
          <button type="button" class="pip ${n === 0 ? 'zero' : ''} ${n !== 0 && n <= value ? 'lit' : ''} ${n === value ? 'current' : ''}"
            data-act="score" data-id="${o.id}" data-val="${n}" data-fid="score:${o.id}:${n}" aria-pressed="${n === value}">${n}</button>`).join('')}
        </span>
      </li>`;
    }).join('')}</ul>`;
  }

  const byId = new Map(moot.options.map(o => [o.id, o]));
  const unranked = moot.options.filter(o => !d.ranking.includes(o.id));
  return `
    ${d.ranking.length ? `<ol class="choices ranking">${d.ranking.map((id, i) => `
      <li class="choice ranked">
        <span class="rank-badge">${i + 1}</span>
        <span class="choice-label">${esc(byId.get(id).label)}${addedBy(byId.get(id))}</span>
        <span class="rank-tools">
          <button type="button" class="icon" data-act="rank-up" data-id="${id}" data-fid="up:${id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button type="button" class="icon" data-act="rank-down" data-id="${id}" data-fid="down:${id}" ${i === d.ranking.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button type="button" class="icon" data-act="rank-remove" data-id="${id}" data-fid="rm:${id}" aria-label="Remove from ranking">✕</button>
        </span>
      </li>`).join('')}</ol>` : `<p class="empty-rank">Your ranking is empty. Pick your favourite first.</p>`}
    ${unranked.length ? `
      <p class="label sub">${d.ranking.length ? 'Not yet ranked — tap to add next' : 'Tap the choices in order of preference'}</p>
      <div class="unranked">${unranked.map(o => `
        <button type="button" class="chip-btn" data-act="rank-add" data-id="${o.id}" data-fid="add:${o.id}">+ ${esc(o.label)}</button>`).join('')}
      </div>` : ''}`;
}

const addOptionForm = () => `
  <form class="inline-form" id="option-form">
    <input name="label" maxlength="100" placeholder="Add a choice…" autocomplete="off" data-keep="new-option" aria-label="New choice">
    <button class="ghost" type="submit">Add</button>
  </form>`;

function ballotCard(moot) {
  const hasVoted = Boolean(moot.you.ballot);
  const dirty = isDirty();
  const emptyRanking = moot.method === 'ranked' && state.draft.ranking.length === 0;
  let action;
  if (!hasVoted) {
    action = `<button class="primary big" type="button" data-act="cast" data-fid="cast" ${emptyRanking || state.busy ? 'disabled' : ''}>Cast your vote</button>`;
  } else if (dirty) {
    action = `<button class="primary big" type="button" data-act="cast" data-fid="cast" ${emptyRanking || state.busy ? 'disabled' : ''}>Change your vote</button>
      <button class="ghost" type="button" data-act="discard">Discard changes</button>`;
  } else {
    action = `<p class="cast-note"><span class="orn">❦</span> Your vote is cast. You may change it until the moot is closed.</p>`;
  }
  return `
  <section class="card">
    <div class="card-head">
      <h2><span class="orn">❦</span> Your ballot</h2>
      <span class="whoami">as <b>${esc(moot.you.name)}</b> · <button class="link" type="button" data-act="leave">not you?</button></span>
    </div>
    <p class="hint">${METHODS[moot.method].how}</p>
    ${ballotEditor(moot)}
    ${moot.openOptions && !moot.isAdmin ? addOptionForm() : ''}
    <div class="actions">${action}</div>
  </section>`;
}

function joinCard(moot) {
  return `
  <section class="card">
    <h2><span class="orn">❦</span> Join the moot</h2>
    <p class="hint">Give the name the others know you by. Coming back? Use the same name to find your ballot again.</p>
    <form id="join-form" class="join">
      <label class="field"><span class="label">Your name</span>
        <input name="name" maxlength="40" autocomplete="nickname" required data-keep="join-name"></label>
      <label class="field"><span class="label">Password <small>(optional — guards your ballot)</small></span>
        <input name="password" type="password" maxlength="200" autocomplete="off" data-keep="join-pass"></label>
      <button class="primary" type="submit">Step into the dingle</button>
    </form>
  </section>`;
}

// ---- moot: results ---------------------------------------------------------

function describeBallot(moot, ballot, labels) {
  if (moot.method === 'approval') {
    return ballot.approved.length ? ballot.approved.map(id => esc(labels.get(id))).join(', ') : '<i>none</i>';
  }
  if (moot.method === 'ranked') {
    return ballot.ranking.length ? ballot.ranking.map(id => esc(labels.get(id))).join(' <span class="gt">›</span> ') : '<i>none</i>';
  }
  return moot.options.map(o => `${esc(o.label)} <b>${ballot.scores[o.id] || 0}</b>`).join(' · ');
}

function resultsCard(moot) {
  const r = moot.results;
  const labels = new Map(moot.options.map(o => [o.id, o.label]));
  const n = moot.options.length;
  const winners = r.ranking.filter(row => row.rank === 1);

  let verdict;
  if (r.count === 0) {
    verdict = `<p class="verdict quiet">${moot.closed ? 'The moot ended before anyone spoke.' : 'No one has spoken yet.'}</p>`;
  } else if (winners.length === 1) {
    verdict = `<p class="verdict"><small>${moot.closed ? 'The moot has decided' : 'Leading so far'}</small>
      <strong>${esc(labels.get(winners[0].option))}</strong></p>`;
  } else {
    verdict = `<p class="verdict"><small>${moot.closed ? 'The moot ends in shared first place' : 'Tied for the lead'}</small>
      <strong>${winners.map(w => esc(labels.get(w.option))).join(' <span class="amp">&amp;</span> ')}</strong></p>`;
  }

  const bar = row => {
    let fraction;
    let detail;
    if (moot.method === 'approval') {
      fraction = r.count ? row.score / r.count : 0;
      detail = `${row.score} of ${r.count}`;
    } else if (moot.method === 'score') {
      fraction = r.count ? row.score / (r.count * moot.scoreMax) : 0;
      detail = `${row.score} pts${r.count ? ` · avg ${(row.score / r.count).toFixed(1)}` : ''}`;
    } else {
      fraction = n > 1 ? row.score / (n - 1) : 0;
      detail = `beats ${row.score} of ${n - 1}`;
    }
    const lead = r.count > 0 && row.rank === 1;
    return `
    <li class="result ${lead ? 'lead' : ''}">
      <span class="result-rank">${r.count ? row.rank : '–'}</span>
      <span class="result-main">
        <span class="result-line"><span class="result-label">${esc(labels.get(row.option))}</span><span class="result-detail">${detail}</span></span>
        <span class="track-bar"><span class="fill" style="--w:${(fraction * 100).toFixed(1)}%"></span></span>
      </span>
    </li>`;
  };

  let pairwise = '';
  if (moot.method === 'ranked' && r.count > 0) {
    const ids = r.ranking.map(row => row.option);
    const cell = (a, b) => {
      if (a === b) return '<td class="self">·</td>';
      const x = r.pairwise[a][b];
      const y = r.pairwise[b][a];
      return `<td class="${x > y ? 'win' : x < y ? 'loss' : 'tie'}">${x}–${y}</td>`;
    };
    let explain = '';
    if (winners.length === 1) {
      const w = winners[0].option;
      explain = `<ul class="explain">${ids.filter(id => id !== w).map(id => {
        const x = r.pairwise[w][id];
        const y = r.pairwise[id][w];
        const verb = x > y ? 'beats' : x < y ? 'trails' : 'ties with';
        return `<li><b>${esc(labels.get(w))}</b> ${verb} <b>${esc(labels.get(id))}</b> <span class="tally">${x}–${y}</span></li>`;
      }).join('')}</ul>`;
    }
    pairwise = `
    <details class="pairwise" ${moot.closed ? 'open' : ''}>
      <summary>Head to head</summary>
      ${explain}
      <p class="hint">Each cell reads <i>row</i> against <i>column</i>: voters preferring the row choice – voters preferring the column choice.</p>
      <div class="table-wrap"><table>
        <thead><tr><th></th>${ids.map(id => `<th scope="col">${esc(labels.get(id))}</th>`).join('')}</tr></thead>
        <tbody>${ids.map(a => `<tr><th scope="row">${esc(labels.get(a))}</th>${ids.map(b => cell(a, b)).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </details>`;
  }

  let ballots = '';
  if (r.ballots && r.ballots.length) {
    ballots = `
    <details class="pairwise">
      <summary>Who voted how</summary>
      <div class="table-wrap"><table class="ballots">
        <tbody>${r.ballots.map(b => `<tr><th scope="row">${esc(b.name)}</th><td>${describeBallot(moot, b.ballot, labels)}</td></tr>`).join('')}</tbody>
      </table></div>
    </details>`;
  }

  return `
  <section class="card results ${moot.closed ? 'final' : ''}">
    <div class="card-head">
      <h2><span class="orn">❦</span> ${moot.closed ? 'The decision' : 'The standings'}</h2>
      <span class="whoami">${plural(r.count, 'ballot')}${moot.secret ? ' · secret' : ''}</span>
    </div>
    ${verdict}
    <ol class="result-list">${r.ranking.map(bar).join('')}</ol>
    ${pairwise}
    ${ballots}
  </section>`;
}

const veilCard = () => `
  <section class="card veil">
    <h2><span class="orn">❦</span> The standings</h2>
    <p>Hidden among the leaves until you have cast your vote — so that no one is swayed.</p>
  </section>`;

// ---- moot: page ------------------------------------------------------------

function adminCard(moot) {
  const origin = location.origin;
  const linkRow = (label, url, note) => `
    <div class="link-row">
      <span class="label">${label} <small>${note}</small></span>
      <div class="link-box"><input readonly value="${esc(url)}" aria-label="${label}" onfocus="this.select()">
        <button class="ghost" type="button" data-act="copy" data-text="${esc(url)}">Copy</button></div>
    </div>`;
  let closing = '';
  if (!moot.closed) {
    closing = state.confirmClose
      ? `<div class="confirm"><p>Close the moot for good? Ballots will be frozen and the result shown to all.</p>
          <button class="danger" type="button" data-act="close-yes" data-fid="close-yes">Yes, close the moot</button>
          <button class="ghost" type="button" data-act="close-no" data-fid="close">Not yet</button></div>`
      : `<button class="danger" type="button" data-act="close" data-fid="close">Close the moot</button>`;
  }
  return `
  <section class="card admin">
    <h2><span class="orn">❦</span> Keeper of the moot</h2>
    ${linkRow('Moot link', `${origin}/m/${moot.id}`, '— share this with everyone')}
    ${linkRow('Admin link', `${origin}/m/${moot.id}/admin/${state.adminToken}`, '— keep it private; it closes the moot')}
    ${moot.closed ? '' : `
    <details class="manage">
      <summary>Manage the choices</summary>
      <ul class="manage-list">${moot.options.map(o => `
        <li><span>${esc(o.label)}${addedBy(o)}</span>
          <button class="icon" type="button" data-act="remove-option" data-id="${o.id}" ${moot.options.length <= 2 ? 'disabled' : ''} aria-label="Remove ${esc(o.label)}">✕</button></li>`).join('')}
      </ul>
      ${addOptionForm()}
    </details>`}
    ${closing}
  </section>`;
}

function votersCard(moot) {
  if (!moot.voters.length) {
    return `<section class="card gathered"><h2><span class="orn">❦</span> Gathered at the moot</h2>
      <p class="hint">No one has come yet. Share the link and wait — unhastily.</p></section>`;
  }
  const voted = moot.voters.filter(v => v.voted).length;
  return `
  <section class="card gathered">
    <div class="card-head">
      <h2><span class="orn">❦</span> Gathered at the moot</h2>
      <span class="whoami">${voted} of ${moot.voters.length} voted</span>
    </div>
    <ul class="voters">${moot.voters.map(v => `
      <li class="${v.voted ? 'voted' : 'waiting'} ${moot.you && moot.you.name === v.name ? 'me' : ''}"
        title="${v.voted ? 'has voted' : 'still pondering'}"><span class="mark">${v.voted ? '✓' : '…'}</span>${esc(v.name)}</li>`).join('')}
    </ul>
  </section>`;
}

function mootHtml(moot) {
  const m = METHODS[moot.method];
  let body;
  if (moot.closed) {
    body = resultsCard(moot);
  } else if (!moot.you) {
    body = joinCard(moot) + veilCard();
  } else {
    body = ballotCard(moot) + (moot.results ? resultsCard(moot) : veilCard());
  }
  return `
  <div class="page">
    ${topbar()}
    <header class="moot-head">
      <p class="eyebrow">${moot.closed ? 'The moot has ended' : 'A moot has been called'}</p>
      <h1>${esc(moot.question)}</h1>
      <p class="chips">
        <span class="chip" title="${esc(m.blurb)}">${m.name} voting</span>
        <span class="chip">${moot.secret ? 'Secret ballots' : 'Public ballots'}</span>
        ${moot.openOptions ? '<span class="chip">Open options</span>' : ''}
        <span class="chip ${moot.closed ? 'closed' : 'open'}">${moot.closed ? 'Closed' : 'Open'}</span>
      </p>
    </header>
    ${moot.isAdmin ? adminCard(moot) : ''}
    ${body}
    ${votersCard(moot)}
    ${footer()}
  </div>`;
}

// Re-renders the moot while keeping typed text and keyboard focus where they were.
function render() {
  if (!state.moot) return;
  const kept = {};
  app.querySelectorAll('[data-keep]').forEach(el => { kept[el.dataset.keep] = el.value; });
  const openDetails = [...app.querySelectorAll('details')].map(d => d.open);
  const active = document.activeElement;
  const focusKey = active && active.dataset ? active.dataset.fid || active.dataset.keep : null;
  const caret = focusKey && active.dataset.keep && active.type !== 'password' ? [active.selectionStart, active.selectionEnd] : null;

  document.title = `${state.moot.question} · Entmoot`;
  app.innerHTML = mootHtml(state.moot);

  app.querySelectorAll('[data-keep]').forEach(el => {
    if (kept[el.dataset.keep] !== undefined) el.value = kept[el.dataset.keep];
  });
  const details = app.querySelectorAll('details');
  if (details.length === openDetails.length) details.forEach((d, i) => { d.open = openDetails[i]; });
  if (focusKey) {
    const el = [...app.querySelectorAll('[data-fid],[data-keep]')].find(e => (e.dataset.fid || e.dataset.keep) === focusKey);
    if (el && !el.disabled) {
      el.focus({ preventScroll: true });
      if (caret) el.setSelectionRange(caret[0], caret[1]);
    }
  }
}

function renderMissing(message) {
  document.title = 'Entmoot';
  app.innerHTML = `
  <div class="page">
    ${topbar()}
    <header class="hero">${EMBLEM}<h1>Lost in the forest</h1><p class="tagline">${esc(message)}</p>
      <p><a class="primary button" href="/" data-nav>Call a new moot</a></p></header>
    ${footer()}
  </div>`;
}

async function loadMoot({ quiet = false } = {}) {
  const id = state.id;
  try {
    const moot = await api('GET', `/moots/${id}`);
    if (state.id !== id) return;
    if (JSON.stringify(moot) === state.snapshot) return;
    setMoot(moot);
    render();
  } catch (err) {
    if (state.id !== id || quiet) return;
    stopPolling();
    state.moot = null;
    renderMissing(err.message);
  }
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

// Runs a mutating API call that answers with the fresh moot view.
async function act(fn, success) {
  if (state.busy) return;
  state.busy = true;
  try {
    const moot = await fn();
    if (moot && moot.id === state.id) setMoot(moot);
    if (success) toast(success);
  } catch (err) {
    toast(err.message, true);
    if (err.status === 404 || err.status === 409) await loadMoot({ quiet: true });
  } finally {
    state.busy = false;
    render();
  }
}

function castVote() {
  const moot = state.moot;
  const ballot = copyBallot(moot.method, state.draft);
  if (moot.method === 'score') for (const o of moot.options) ballot.scores[o.id] = ballot.scores[o.id] || 0;
  const changed = Boolean(moot.you.ballot);
  act(async () => {
    const fresh = await api('PUT', `/moots/${moot.id}/ballot`, { ballot });
    state.draft = copyBallot(fresh.method, fresh.you.ballot); // drop the "unsaved edits" state
    state.moot = fresh;
    return fresh;
  }, changed ? 'Your vote is changed.' : 'Your voice is heard.');
}

async function joinMoot(form) {
  const fd = new FormData(form);
  const name = fd.get('name').trim();
  if (!name) return toast('Please give a name.', true);
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const { token } = await api('POST', `/moots/${state.id}/join`, { name, password: fd.get('password') });
    state.token = token;
    store.set(`entmoot-token-${state.id}`, token);
    state.snapshot = '';
    await loadMoot();
  } catch (err) {
    button.disabled = false;
    toast(err.message, true);
  }
}

function addOption(form) {
  const input = form.elements.label;
  const label = input.value.trim();
  if (!label) return input.focus();
  act(async () => {
    const fresh = await api('POST', `/moots/${state.id}/options`, { label });
    input.value = '';
    return fresh;
  }, 'A new choice takes root.');
}

// ---- routing & events ------------------------------------------------------

function route() {
  stopPolling();
  Object.assign(state, { id: null, token: null, adminToken: null, moot: null, snapshot: '', draft: null, confirmClose: false });
  window.scrollTo(0, 0);
  const m = location.pathname.match(/^\/m\/([\w-]+)(?:\/admin\/([\w-]+))?\/?$/);
  if (!m) return renderHome();

  state.id = m[1];
  if (m[2]) store.set(`entmoot-admin-${m[1]}`, m[2]);
  state.adminToken = m[2] || store.get(`entmoot-admin-${m[1]}`);
  state.token = store.get(`entmoot-token-${m[1]}`);
  app.innerHTML = `<div class="page">${topbar()}<p class="loading">The leaves are rustling…</p></div>`;
  loadMoot();
  state.pollTimer = setInterval(() => {
    if (!document.hidden && !state.busy) loadMoot({ quiet: true });
  }, POLL_MS);
}

function navigate(path) {
  // Opening the guide from the home page must not re-render (and wipe) the create form.
  if (path === '/#guide' && location.pathname === '/') {
    history.replaceState(null, '', path);
    return openGuide();
  }
  history.pushState(null, '', path);
  route();
}

document.addEventListener('click', e => {
  const link = e.target.closest('a[data-nav]');
  if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    return navigate(link.getAttribute('href'));
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act: action, id } = el.dataset;
  const d = state.draft;

  switch (action) {
    case 'theme': {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      store.set('entmoot-theme', next);
      document.querySelectorAll('[data-act=theme]').forEach(b => { b.textContent = themeLabel(); });
      return;
    }
    case 'guide-top':
      e.preventDefault();
      history.replaceState(null, '', '/');
      document.getElementById('create-form').scrollIntoView({ behavior: 'smooth' });
      return document.querySelector('#create-form [name=question]').focus({ preventScroll: true });
    case 'add-row':
      return addRow();
    case 'del-row': {
      const rows = document.getElementById('option-rows');
      if (rows.children.length <= 2) return toast('A moot needs at least two choices.', true);
      el.closest('.option-row').remove();
      return renumberRows();
    }
    case 'copy':
      return copyText(el.dataset.text);
    case 'score':
      d.scores[id] = Number(el.dataset.val);
      break;
    case 'rank-add':
      d.ranking.push(id);
      break;
    case 'rank-remove':
      d.ranking = d.ranking.filter(x => x !== id);
      break;
    case 'rank-up':
    case 'rank-down': {
      const i = d.ranking.indexOf(id);
      const j = i + (action === 'rank-up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= d.ranking.length) return;
      [d.ranking[i], d.ranking[j]] = [d.ranking[j], d.ranking[i]];
      break;
    }
    case 'discard':
      state.draft = serverBallot(state.moot);
      break;
    case 'cast':
      return castVote();
    case 'leave':
      store.del(`entmoot-token-${state.id}`);
      state.token = null;
      state.snapshot = '';
      state.draft = null;
      return loadMoot();
    case 'close':
      state.confirmClose = true;
      break;
    case 'close-no':
      state.confirmClose = false;
      break;
    case 'close-yes':
      return act(() => api('POST', `/moots/${state.id}/close`), 'The moot is closed.');
    case 'remove-option':
      return act(() => api('DELETE', `/moots/${state.id}/options/${id}`), 'The choice is removed.');
    default:
      return;
  }
  render();
});

document.addEventListener('change', e => {
  const id = e.target.dataset && e.target.dataset.approve;
  if (!id || !state.draft) return;
  const approved = state.draft.approved.filter(x => x !== id);
  if (e.target.checked) approved.push(id);
  state.draft.approved = approved;
  render();
});

document.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.id === 'create-form') createMoot(e.target);
  else if (e.target.id === 'join-form') joinMoot(e.target);
  else if (e.target.id === 'option-form') addOption(e.target);
});

// In the create form, Enter in a choice moves on to the next one instead of submitting.
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches || !e.target.matches('#option-rows input')) return;
  e.preventDefault();
  const next = e.target.closest('.option-row').nextElementSibling;
  if (next) next.querySelector('input').focus();
  else if (e.target.value.trim()) addRow();
});

window.addEventListener('popstate', route);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.id && state.pollTimer) loadMoot({ quiet: true });
});

buildScene();
route();
