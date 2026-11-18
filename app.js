// Xダイジェスト — X の投稿を FxTwitter の公開API から直接取得し、選別・整理して表示する
(() => {
'use strict';
const C = window.XD_CONFIG;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

// ---------- 保存（localStorage） ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem('xd.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) {
    try { localStorage.setItem('xd.' + k, JSON.stringify(v)); }
    catch (e) { // 容量オーバー: 翻訳キャッシュを捨ててもう一度
      try { localStorage.removeItem('xd.tr'); localStorage.setItem('xd.' + k, JSON.stringify(v)); } catch (e2) { console.warn('storage full', e2); }
    }
  },
  del(k) { try { localStorage.removeItem('xd.' + k); } catch (e) {} }
};

const TOPICS = C.topics;
const T = id => TOPICS.find(t => t.id === id) || TOPICS[0];
const EXCL = new Set(C.excludeAuthors.map(s => s.toLowerCase()));

const urlTopic = new URLSearchParams(location.search).get('t'); // ?t=claude で開くタブを指定できる
const state = {
  topic: T(urlTopic || LS.get('topic', TOPICS[0].id)).id,
  windowH: LS.get('windowH', 24),
  sort: LS.get('sort', 'hot'),
  region: 'all',
  term: null,
  q: '',
  caches: {},          // topicId -> {posts:{id:post}, fetchedAt}
  loading: {},
  result: {},          // topicId -> {ok, fail:[], at}
  prevVisit: {},       // topicId -> 前回見た時刻
  limits: {},          // `${topic}.${section}` -> 表示件数
  expanded: new Set(), // 全文表示した投稿
  showOrig: new Set(), // 原文表示にした投稿
  ai: { busy: false, err: '' },
  mute: LS.get('mute', { words: [], authors: [] })
};
let TR = LS.get('tr', {});               // 't'+id -> 日本語訳
const trTried = new Set();

// ---------- 小物 ----------
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => {
  n = +n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(n >= 1e9 ? 0 : 1).replace(/\.0$/, '') + '億';
  if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + '万';
  return n.toLocaleString('ja-JP');
};
const pad = n => String(n).padStart(2, '0');
const jst = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ago = sec => {
  const m = Math.floor((Date.now() / 1000 - sec) / 60);
  if (m < 1) return 'たった今';
  if (m < 60) return m + '分前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '時間前';
  return Math.floor(h / 24) + '日前';
};
const ymdUTC = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const stripUrls = s => s.replace(/https?:\/\/\S+/g, ' ').replace(/[ \t]+/g, ' ').trim();

async function getJSON(url, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (r.status === 204) return { results: [] };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function pool(items, n, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

// ---------- キャッシュ ----------
function cache(tid) {
  if (!state.caches[tid]) state.caches[tid] = LS.get('cache.' + tid, { posts: {}, fetchedAt: 0 });
  return state.caches[tid];
}
function saveCache(tid) {
  const c = cache(tid), topic = T(tid);
  const now = Date.now() / 1000;
  const latestSecs = new Set(topic.sections.filter(s => s.latest).map(s => s.id));
  let arr = Object.values(c.posts).filter(p => p.ts >= now - (latestSecs.has(sectionOf(topic, p)) ? C.keepHoursLatest : C.keepHours) * 3600);
  if (arr.length > C.maxPostsPerTopic) { // 多すぎるときは、公式・リリース欄を残して古い順に捨てる
    arr.sort((a, b) => (latestSecs.has(sectionOf(topic, b)) - latestSecs.has(sectionOf(topic, a))) || b.ts - a.ts);
    arr = arr.slice(0, C.maxPostsPerTopic);
  }
  c.posts = {};
  for (const p of arr) { delete p._sec; delete p._hot; c.posts[p.id] = p; }
  LS.set('cache.' + tid, c);
}
function saveTR() {
  const keys = Object.keys(TR);
  if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1200)) delete TR[k];
  LS.set('tr', TR);
}

// ---------- 取得 ----------
function srcUrl(s, cursor) {
  const cur = cursor ? '&cursor=' + encodeURIComponent(cursor) : '';
  if (s.type === 'user') return `${C.api}/profile/${encodeURIComponent(s.h)}/statuses?count=20${cur}`;
  const q = s.q.replace('{since3d}', ymdUTC(Date.now() - 3 * 864e5));
  return `${C.api}/search?q=${encodeURIComponent(q)}&feed=${s.feed || 'latest'}&count=40${cur}`;
}
function slim(r) {
  const a = r.author || {};
  const all = (r.media && r.media.all) || [];
  const m = all.slice(0, 4).map(x => ({ t: x.type, u: x.type === 'photo' ? x.url : (x.thumbnail_url || ''), w: x.width || 0, h: x.height || 0 })).filter(x => x.u);
  const qa = r.quote && r.quote.author;
  let cn = '';
  if (r.community_note) cn = typeof r.community_note === 'string' ? r.community_note : (r.community_note.text || '');
  return {
    id: String(r.id), u: r.url || `https://x.com/i/status/${r.id}`, x: r.text || '', l: r.lang || '',
    ts: +r.created_timestamp || 0,
    lk: +r.likes || 0, rp: +r.reposts || 0, qt: +r.quotes || 0, bm: +r.bookmarks || 0, vw: +r.views || 0,
    a: { h: a.screen_name || '', n: a.name || '', av: a.avatar_url || '', f: +a.followers || 0 },
    m, q: r.quote ? { h: qa ? qa.screen_name : '', n: qa ? qa.name : '', x: (r.quote.text || '').slice(0, 300), u: r.quote.url || '' } : null,
    cn: String(cn).slice(0, 400)
  };
}
function ingest(c, s, results, now) {
  const re = s.match ? C.matchWords[s.match] : null;
  for (const r of results) {
    if (!r || (r.type && r.type !== 'status') || !r.id) continue;
    if (r.reposted_by || r.replying_to) continue;       // リポストと返信は除く
    const h = ((r.author && r.author.screen_name) || '').toLowerCase();
    if (EXCL.has(h)) continue;
    if (re && !re.test(r.text || '')) continue;
    const p = slim(r);
    const old = c.posts[p.id];
    if (old) {
      Object.assign(old, { lk: p.lk, rp: p.rp, qt: p.qt, bm: p.bm, vw: p.vw, cn: p.cn || old.cn });
      if (p.m.length) old.m = p.m;
      if (!old.src.includes(s.id)) old.src.push(s.id);
    } else {
      p.src = [s.id]; p.fs = now;
      c.posts[p.id] = p;
    }
  }
}
async function refresh(tid) {
  if (state.loading[tid]) return;
  const topic = T(tid);
  const c = cache(tid);
  const now = Date.now();
  state.loading[tid] = true;
  renderStatus();
  const fail = []; let ok = 0;
  await pool(topic.sources, 4, async s => {
    try {
      let cursor = null;
      for (let pg = 0; pg < (s.pages || 1); pg++) {
        let j;
        try { j = await getJSON(srcUrl(s, cursor)); }
        catch (e) { await new Promise(r => setTimeout(r, 1500)); j = await getJSON(srcUrl(s, cursor)); } // 1回だけ再試行
        ingest(c, s, j.results || [], now);
        cursor = j.cursor && j.cursor.bottom;
        if (!cursor) break;
      }
      ok++;
    } catch (e) {
      console.warn('fetch failed', s.id, e);
      fail.push(s.label || s.h || s.id);
    }
  });
  if (ok) c.fetchedAt = now;
  saveCache(tid);
  state.loading[tid] = false;
  state.result[tid] = { ok, fail, at: now, total: topic.sources.length };
  if (tid === state.topic) { render(); translateVisible(); }
  else renderTabs();
}

// ---------- 選別と並べ替え ----------
const srcMap = {};
for (const t of TOPICS) for (const s of t.sources) srcMap[t.id + ':' + s.id] = s;
function sectionOf(topic, p) {
  const secs = p.src.map(id => (srcMap[topic.id + ':' + id] || {}).section);
  for (const sec of topic.sectionPriority) if (secs.includes(sec)) return sec;
  return topic.sectionPriority[topic.sectionPriority.length - 1];
}
function badgeOf(topic, p) {
  for (const sec of topic.sectionPriority) {
    for (const id of p.src) {
      const s = srcMap[topic.id + ':' + id];
      if (s && s.section === sec && s.badge) return s.badge;
    }
  }
  return '';
}
const eng = p => p.lk + 2 * p.rp + 2 * p.qt + 3 * p.bm;
function infoF(p) {
  const len = stripUrls(p.x).length;
  let f = 0.55 + 0.45 * Math.min(1, len / 140);
  if (p.lk > 20 && p.bm / p.lk >= 0.15) f += 0.3;   // 保存される投稿＝役に立つ情報
  if (p.m.length || /https?:\/\//.test(p.x)) f += 0.1;
  return f;
}
function hot(topic, p) {
  const age = Math.max(0, (Date.now() / 1000 - p.ts) / 3600);
  let w = 1;
  if (topic.langWeight) w = p.l === 'ja' ? topic.langWeight.ja : topic.langWeight.other;
  return eng(p) * infoF(p) * w / Math.pow(age + 3, 0.7);
}
const NG = C.ngWords.map(w => w.toLowerCase());
function spamReason(p) {
  const t = p.x.toLowerCase();
  for (const w of NG) if (t.includes(w)) return 'ng';
  if (p.vw >= 300 && p.lk / p.vw > C.botRatio) return 'bot';
  return '';
}
// 注目ポストのうち、話題の言葉が冒頭に出てこない（ついでに触れただけの）投稿を除く
function offTopic(topic, p) {
  const r = topic.relevance;
  if (!r) return false;
  const near = s => { const m = r.re.exec(s || ''); return !!m && m.index <= r.within; };
  return !near(p.x) && !near(p.q && p.q.x);
}
// FxTwitter の翻訳は、まれに翻訳でない文（翻訳サービスのエラー文など）が返るので確かめる
function goodTranslation(orig, tr) {
  if (!tr || !/[ぁ-んァ-ヴ一-龥]/.test(tr)) return false;
  if (/deepl/i.test(tr) && !/deepl/i.test(orig)) return false;
  return tr.length <= orig.length * 3 + 150;
}
const trOf = p => { const t = TR['t' + p.id]; return t && p.l !== 'ja' && goodTranslation(p.x, t) ? t : ''; };
function muted(p) {
  const m = state.mute;
  if (m.authors.some(a => a.toLowerCase() === p.a.h.toLowerCase())) return true;
  return m.words.some(w => w && p.x.includes(w));
}
const textKey = p => stripUrls(p.x).replace(/\s+/g, '').slice(0, 50);
const norm = s => String(s || '').normalize('NFKC').toLowerCase();
function matchesFilter(p) {
  const tx = norm(p.x + ' ' + trOf(p));
  if (state.term && !tx.includes(norm(state.term))) return false;
  if (state.q) {
    for (const w of norm(state.q).split(/\s+/).filter(Boolean)) if (!tx.includes(w) && !norm(p.a.h).includes(w) && !norm(p.a.n).includes(w)) return false;
  }
  return true;
}
// 画面に出す投稿を欄ごとに組み立てる
function buildView(tid) {
  const topic = T(tid);
  const all = Object.values(cache(tid).posts);
  const cut = Date.now() / 1000 - state.windowH * 3600;
  const bySec = {};
  for (const sec of topic.sections) bySec[sec.id] = [];
  const dropped = { ng: 0, bot: 0, off: 0 };
  for (const p of all) {
    if (muted(p)) continue;
    const sec = sectionOf(topic, p);
    const def = topic.sections.find(s => s.id === sec);
    if (!def) continue;
    if (!def.latest && p.ts < cut) continue;
    if (sec === 'buzz') {
      const r = spamReason(p) || (offTopic(topic, p) ? 'off' : '');
      if (r) { dropped[r]++; continue; }
    }
    p._sec = sec; p._hot = hot(topic, p);
    bySec[sec].push(p);
  }
  const out = {};
  for (const def of topic.sections) {
    let arr = bySec[def.id];
    // 似た文面の重複は反響の大きい方だけ残す
    const seen = new Map();
    for (const p of arr.sort((a, b) => eng(b) - eng(a))) {
      let k = textKey(p);
      if (k.length < 12) k = 'id:' + p.id;
      if (!seen.has(k)) seen.set(k, p);
    }
    arr = Array.from(seen.values());
    const base = arr.slice();
    arr = arr.filter(matchesFilter);
    if (def.regions && state.region !== 'all') arr = arr.filter(p => state.region === 'ja' ? p.l === 'ja' : p.l !== 'ja');
    if (def.latest || state.sort === 'new') arr.sort((a, b) => b.ts - a.ts);
    else arr.sort((a, b) => b._hot - a._hot);
    if (def.id === 'buzz') { // 同じ人ばかりにならないように
      const cnt = {};
      arr = arr.filter(p => { const k = p.a.h.toLowerCase(); cnt[k] = (cnt[k] || 0) + 1; return cnt[k] <= C.authorCap; });
    }
    out[def.id] = { def, posts: arr, base };
  }
  return { topic, out, dropped };
}

// ---------- 話題のワード ----------
function extractTerms(text) {
  const t = text.normalize('NFKC').replace(/https?:\/\/\S+/g, ' ').replace(/@[A-Za-z0-9_]+/g, ' ');
  const set = new Set();
  for (const m of t.matchAll(/\$([A-Za-z]{1,6})\b/g)) set.add('$' + m[1].toUpperCase());
  for (const m of t.matchAll(/[ァ-ヴ][ァ-ヴー・]{2,}/g)) { const w = m[0].replace(/[・ー]+$/, ''); if (w.length >= 3) set.add(w); }
  // 英字は固有名詞らしいもの（大文字や数字を含む）か、Claude Code の用語だけ
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9+&]*(?:[.\-][A-Za-z0-9+&]+)*/g)) {
    const w = m[0].replace(/&+$/, '');
    if (!(w.length >= 3 || /^[A-Z]{2}$/.test(w))) continue;
    if (/[A-Z0-9]/.test(w) || TECH_WORDS.has(w.toLowerCase())) set.add(w);
  }
  for (const m of t.matchAll(/[一-龥々〆ヶ]{2,7}/g)) set.add(m[0]);
  return set;
}
const TECH_WORDS = new Set('hooks hook skills skill subagents subagent plugins plugin worktree worktrees mcp cli sdk api sandbox agents agent'.split(' '));
// どの話題でも意味の薄い言葉（漢字の切れ端を含む）
const COMMON_STOP = ('中心 見通 作業 会話 報告 非常 資産 リリース アップデート バージョン ポイント ページ リンク スレッド ポスト ツイート フォロー フォロワー コメント シェア チェック スタート サポート ベータ オプション ストレス メリット デメリット レベル タイミング イメージ パターン ケース スタイル ルール テーマ ニュース 可能性 内容 操作 最後 整理 重要 勘違 価格 理解 確認 説明 対応 対策 意味 部分 方向 予定 実際 簡単 最強 最高 最新 最大 最小 全然 絶対 本気 自体 他人 相手 相談 失敗 成功 勉強 経験 判断 意識 準備 継続 習慣 基本 特徴 注意 安心 不安 大丈夫 大変 一気 一部 一日 一年 毎月 毎年 今月 先月 来月 今朝 今夜 午前 午後 夕方 年間 月間 週間 数年 数日 何度 何回 以前 以降 以外 以内 前後 途中 最初 最終 次第 状態 環境 条件 方法 手順 仕組 設定 選択 比較 解決 改善 変化 変更 追加 削除 開始 終了 完了 登録 参加 発信 投稿 返信 共有 保存 表示 確実 正直 普段 自然 自由 無理 無駄 必須 用意 活用 効果 効率 結論 原因 背景 事実 事例 具体 全体像 前提 年収 生活 時代 将来 未来 過去 現実 未満 程度 多数 少数 一番目 本日中 年内 今年度 来年 去年 昨年 本当に').split(' ');
function topTerms(topic, posts) {
  const stop = new Set(topic.stopWords.concat(COMMON_STOP).map(s => s.toLowerCase()));
  const st = new Map(); // key -> {disp:{}, authors:Set, w}
  // 文頭で大文字になっただけの普通の英単語（Give, Check など）を省くため、小文字で使われた英単語を集めておく
  const lowerSeen = new Set();
  for (const p of posts) for (const m of p.x.matchAll(/(?:^|[^A-Za-z])([a-z]{3,})(?![A-Za-z])/g)) lowerSeen.add(m[1]);
  for (const p of posts) {
    const tr = trOf(p);
    const terms = Array.from(extractTerms(p.x + (tr ? '\n' + tr : ''))).filter(w => !(/^[A-Z][a-z]+$/.test(w) && lowerSeen.has(w.toLowerCase())));
    const wgt = Math.sqrt(eng(p) + 1);
    for (const raw of terms) {
      const k = raw.toLowerCase();
      if (stop.has(k) || /^\d/.test(k)) continue;
      let e = st.get(k);
      if (!e) { e = { disp: {}, authors: new Set(), w: 0 }; st.set(k, e); }
      e.disp[raw] = (e.disp[raw] || 0) + 1;
      e.authors.add(p.a.h);
      e.w += wgt;
    }
  }
  const arr = [];
  for (const [k, e] of st) {
    if (e.authors.size < 2) continue;
    const disp = Object.entries(e.disp).sort((a, b) => b[1] - a[1])[0][0];
    arr.push({ k, disp, n: e.authors.size, w: e.w * e.authors.size });
  }
  arr.sort((a, b) => b.w - a.w);
  // 他の語に含まれる短い語は省く（例：「日経平」と「日経平均」）
  const pick = [];
  for (const e of arr) {
    if (pick.some(x => x.k.includes(e.k) && x.n >= e.n * 0.8)) continue;
    pick.push(e);
    if (pick.length >= 14) break;
  }
  return pick;
}

// ---------- 描画 ----------
function linkify(s) {
  let h = esc(s);
  h = h.replace(/https?:\/\/[^\s<]+/g, u => {
    const disp = u.replace(/^https?:\/\/(www\.)?/, '');
    return `<a href="${u}" target="_blank" rel="noopener">${disp.length > 34 ? disp.slice(0, 33) + '…' : disp}</a>`;
  });
  h = h.replace(/(^|[^\w/])@([A-Za-z0-9_]{1,15})/g, (m, pre, n) => `${pre}<a href="https://x.com/${n}" target="_blank" rel="noopener">@${n}</a>`);
  h = h.replace(/(^|\s)#([^\s#<]{1,40})/g, (m, pre, tag) => `${pre}<a href="https://x.com/hashtag/${encodeURIComponent(tag)}" target="_blank" rel="noopener">#${tag}</a>`);
  return h;
}
const thumb = u => /pbs\.twimg\.com\/media\//.test(u) ? u.replace(/\?.*$/, '').replace(/\.(jpg|png|webp)$/, '') + '?format=jpg&name=small' : u;
function badgeCls(b) {
  if (b === '公式' || b === '開発者' || b === 'Anthropic') return '';
  if (b === '著名投資家') return 'inv';
  if (b === '更新履歴') return 'rel';
  return 'news';
}
function isNew(tid, p) { const pv = state.prevVisit[tid]; return pv > 0 && p.fs > pv; }
function postCard(tid, p, badge) {
  const tr = trOf(p);
  const useTr = tr && !state.showOrig.has(p.id);
  const body = useTr ? tr : p.x;
  const ex = state.expanded.has(p.id);
  const noMedia = (T(tid).sections.find(s => s.id === sectionOf(T(tid), p)) || {}).noMedia;
  const media = p.m.length && !noMedia ? `<div class="media" style="--n:${Math.min(p.m.length, 2)}">${p.m.map(m => `<a href="${esc(p.u)}" target="_blank" rel="noopener"><img src="${esc(thumb(m.u))}" loading="lazy" alt="">${m.t !== 'photo' ? '<span class="play">▶</span>' : ''}</a>`).join('')}</div>` : '';
  const q = p.q ? `<div class="qt"><b>${esc(p.q.n)}</b> @${esc(p.q.h)}\n${esc(p.q.x)}</div>` : '';
  const trl = tr && p.l !== 'ja' ? `<div class="trline">${useTr ? '🌐 自動翻訳' : '原文'} · <button data-act="orig" data-id="${p.id}">${useTr ? '原文を見る' : '訳を見る'}</button></div>` : '';
  return `<article class="post" id="p-${p.id}" data-id="${p.id}">
  <div class="ph"><img class="av" src="${esc(p.a.av)}" loading="lazy" alt="">
    <div class="who"><b>${esc(p.a.n)}${badge ? `<i class="badge ${badgeCls(badge)}">${esc(badge)}</i>` : ''}${isNew(tid, p) ? '<i class="newb">NEW</i>' : ''}</b><span>@${esc(p.a.h)}${p.a.f ? ' · フォロワー ' + num(p.a.f) : ''}</span></div>
    <time title="${jst(p.ts * 1000)}">${ago(p.ts)}</time></div>
  <div class="tx${ex ? '' : ' clamp'}" data-act="expand" data-id="${p.id}">${linkify(body)}</div>${trl}
  ${p.cn ? `<div class="cn">⚠ コミュニティノート：${esc(p.cn)}</div>` : ''}${q}${media}
  <div class="pf"><span title="いいね">♥ ${num(p.lk)}</span><span title="リポスト">🔁 ${num(p.rp)}</span><span title="ブックマーク">🔖 ${num(p.bm)}</span>${p.vw ? `<span title="表示回数">👁 ${num(p.vw)}</span>` : ''}<span class="sp"></span>
    <button class="mute" data-act="mute" data-h="${esc(p.a.h)}">非表示</button><a href="${esc(p.u)}" target="_blank" rel="noopener">Xで開く ↗</a></div>
</article>`;
}
function rowItem(tid, p, badge) {
  return `<a class="row" href="${esc(p.u)}" target="_blank" rel="noopener" id="p-${p.id}"><img class="av" src="${esc(p.a.av)}" loading="lazy" alt="">
  <div style="min-width:0;flex:1"><div class="meta"><b>${esc(p.a.n)}</b>${badge ? `<i class="badge ${badgeCls(badge)}">${esc(badge)}</i>` : ''}${isNew(tid, p) ? '<i class="newb">NEW</i>' : ''} · ${ago(p.ts)}${p.lk ? ' · ♥' + num(p.lk) : ''}</div>
  <div class="t">${esc(stripUrls(p.x))}</div></div></a>`;
}

function countNew(t) { // 別のタブの「前回見てから増えた投稿」の数
  const pv = state.prevVisit[t.id] || LS.get('visit.' + t.id, 0);
  if (!pv) return 0;
  const cut = Date.now() / 1000 - state.windowH * 3600;
  let n = 0;
  for (const p of Object.values(cache(t.id).posts)) {
    if (p.fs <= pv || muted(p)) continue;
    const sec = sectionOf(t, p);
    const def = t.sections.find(s => s.id === sec);
    if (!def || (!def.latest && p.ts < cut) || (sec === 'buzz' && spamReason(p))) continue;
    n++;
  }
  return n;
}
function renderTabs() {
  $('#tabs').innerHTML = TOPICS.map(t => {
    const n = t.id === state.topic ? 0 : countNew(t);
    return `<button class="tab" role="tab" data-t="${t.id}" aria-selected="${t.id === state.topic}">${t.icon} ${esc(t.label)}${n ? `<span class="cnt">${n > 99 ? '99+' : n}</span>` : ''}</button>`;
  }).join('');
}
function renderStatus() {
  const tid = state.topic, c = cache(tid), r = state.result[tid];
  const btn = $('#refresh');
  btn.classList.toggle('spin', !!state.loading[tid]);
  let s = '';
  if (state.loading[tid]) s = '取得中…';
  else if (c.fetchedAt) s = `${jst(c.fetchedAt)} 更新`;
  if (!state.loading[tid] && r && r.fail.length) s += ` · ${r.fail.length}件失敗`;
  $('#status').textContent = s;
}
function renderControls() {
  $$('#winSeg button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.w === state.windowH));
  $$('#sortSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.s === state.sort));
}

function aiCard(tid) {
  const topic = T(tid);
  const key = LS.get('apiKey', '');
  const model = C.models.find(m => m.id === LS.get('model', C.models[0].id)) || C.models[0];
  if (!key) {
    return `<div class="card ai"><h3>🤖 AIまとめ <span class="muted">（任意）</span></h3>
      <div class="muted">設定で Claude の APIキーを入れると、ここに「いま押さえるべき要点」が出ます。キーがなくても下の一覧はそのまま使えます。</div>
      <div class="foot"><span></span><button class="btn ghost" data-act="settings">設定を開く</button></div></div>`;
  }
  const s = LS.get('ai.' + tid, null);
  const busy = state.ai.busy;
  const err = state.ai.err ? `<div class="caution">${esc(state.ai.err)}</div>` : '';
  if (!s) {
    return `<div class="card ai"><h3>🤖 AIまとめ</h3>
      <div class="muted">直近${state.windowH}時間の反響の大きい投稿（最大40件）を ${esc(model.label.replace(/（.*/, ''))} で要約します。</div>${err}
      <div class="foot"><span>1回 約$${estCost(model)} の目安</span><button class="btn" data-act="ai" ${busy ? 'disabled' : ''}>${busy ? '要約中…' : 'AIで要約する'}</button></div></div>`;
  }
  const d = s.data;
  const pts = (d.points || []).map(pt => {
    const refs = (pt.refs || []).map(n => s.ids[n - 1] ? `<button data-act="ref" data-id="${s.ids[n - 1]}" data-u="${esc(s.urls[n - 1] || '')}">#${n}</button>` : '').join('');
    return `<li><b>${esc(pt.title)}</b>${esc(pt.detail)}${refs ? `<span class="refs">${refs}</span>` : ''}</li>`;
  }).join('');
  const usd = s.usd != null ? ` · $${s.usd.toFixed(3)}` : '';
  return `<div class="card ai"><h3>🤖 AIまとめ <span class="muted">${jst(s.at)} · 直近${s.windowH}時間 · ${esc(s.modelLabel || s.model)}${usd}</span></h3>
    <div class="hl">${esc(d.headline)}</div><ol>${pts}</ol>
    ${d.caution ? `<div class="caution">⚠ ${esc(d.caution)}</div>` : ''}${err}
    <div class="foot"><span>番号を押すと元の投稿へ移動します</span><button class="btn ghost" data-act="ai" ${busy ? 'disabled' : ''}>${busy ? '要約中…' : '最新で要約し直す'}</button></div></div>`;
}
function estCost(model) { // 入力 約1.2万トークン・出力 約3千トークン（思考を含む）として
  return (12000 * model.inUsd / 1e6 + 3000 * model.outUsd / 1e6).toFixed(model.inUsd < 1 ? 4 : 2);
}

let visibleIds = [];
function render() {
  const tid = state.topic;
  renderTabs(); renderStatus(); renderControls();
  const c = cache(tid);
  const { topic, out, dropped } = buildView(tid);
  visibleIds = [];
  let h = '';
  const r = state.result[tid];
  if (r && r.ok === 0) h += `<div class="banner">Xのデータを取得できませんでした（FxTwitter API の不調か、通信エラーの可能性）。少し待ってから ↻ を押してください。${c.fetchedAt ? '前回取得した内容を表示しています。' : ''}</div>`;
  h += aiCard(tid);

  // 話題のワード（注目ポスト＋報道の、絞り込み前の母集団から）
  const pop = [];
  for (const k in out) if (!out[k].def.latest) pop.push(...out[k].base);
  const terms = topTerms(topic, pop);
  if (terms.length) {
    h += `<h2>話題のワード <small>直近${state.windowH}時間で複数の人が触れた言葉</small></h2><div class="terms">${terms.map(t => `<button class="term" data-act="term" data-k="${esc(t.disp)}" aria-pressed="${state.term && state.term.toLowerCase() === t.k}">${esc(t.disp)}<i>${t.n}</i></button>`).join('')}</div>`;
  }
  if (state.term || state.q) h += `<div class="filterbar">「${esc([state.term, state.q].filter(Boolean).join(' ＋ '))}」で絞り込み中 <button class="btn ghost" data-act="clearf" style="padding:1px 10px;font-size:12px">解除</button></div>`;

  const firstLoad = !c.fetchedAt && state.loading[tid];
  for (const def of topic.sections) {
    const { posts } = out[def.id];
    const lk = tid + '.' + def.id;
    const lim = state.limits[lk] || def.limit;
    const regions = def.regions ? `<span class="seg regions" role="group">${[['all', 'すべて'], ['ja', '国内'], ['en', '海外']].map(([v, l]) => `<button data-act="region" data-v="${v}" aria-pressed="${state.region === v}">${l}</button>`).join('')}</span>` : '';
    h += `<h2>${esc(def.title)} <span class="n">${posts.length}件</span><small>${esc(def.desc)}</small>${regions}</h2>`;
    if (firstLoad) { h += '<div class="skel"></div><div class="skel"></div>'; continue; }
    if (!posts.length) {
      h += `<div class="empty">${state.term || state.q ? '絞り込みに当てはまる投稿はありません' : def.latest ? 'まだ取得できていません' : `直近${state.windowH}時間の投稿はありません。期間を広げてみてください`}</div>`;
      continue;
    }
    const shown = posts.slice(0, lim);
    shown.forEach(p => visibleIds.push(p.id));
    if (def.style === 'compact') h += `<div class="list">${shown.map(p => rowItem(tid, p, badgeOf(topic, p))).join('')}</div>`;
    else h += shown.map(p => postCard(tid, p, badgeOf(topic, p))).join('');
    if (posts.length > lim) h += `<button class="more" data-act="more" data-k="${lk}" data-step="${def.limit}">もっと見る（残り${posts.length - lim}件）</button>`;
  }
  const why = [];
  if (dropped.ng) why.push(`煽り・宣伝の言葉で ${dropped.ng}件`);
  if (dropped.bot) why.push(`いいね水増しの疑いで ${dropped.bot}件`);
  if (dropped.off) why.push(`話題から外れているため ${dropped.off}件`);
  h += `<footer class="note">${esc(topic.disclaimer)}<br>${why.length ? `注目ポストから、${why.join('、')}を除外しました。<br>` : ''}${r && r.fail.length ? `前回の更新で取得できなかったもの：${esc(r.fail.join('、'))}（次の更新で再取得します）<br>` : ''}データ：FxTwitter の公開API（非公式）経由で X の公開投稿を取得。表示は X の各投稿へのリンク付きです。</footer>`;
  $('#main').innerHTML = h;
}
let rafPending = false;
function renderSoon() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; render(); }); }

// ---------- 翻訳（FxTwitter の Grok 翻訳を投稿ごとに取得） ----------
let trBusy = false;
async function translateVisible() {
  if (trBusy) return;
  const tid = state.topic;
  const posts = cache(tid).posts;
  const need = visibleIds.map(id => posts[id]).filter(p => p && /^[a-z]{2}$/.test(p.l) && p.l !== 'ja' && !TR['t' + p.id] && !trTried.has(p.id)).slice(0, 30);
  if (!need.length) return;
  trBusy = true;
  let got = 0;
  await pool(need, 3, async p => {
    trTried.add(p.id);
    try {
      const j = await getJSON(`${C.api}/status/${p.id}?lang=ja`);
      const t = j.status && j.status.translation;
      if (t && t.text && t.source_lang !== 'ja' && goodTranslation(p.x, t.text)) {
        TR['t' + p.id] = t.text; got++;
        updateCardText(p);
      }
    } catch (e) { console.warn('translate failed', p.id, e); }
  });
  trBusy = false;
  if (got) saveTR();
  if (visibleIds.some(id => posts[id] && /^[a-z]{2}$/.test(posts[id].l) && posts[id].l !== 'ja' && !TR['t' + id] && !trTried.has(id))) translateVisible();
}
function updateCardText(p) {
  const el = document.getElementById('p-' + p.id);
  if (!el || !el.classList.contains('post')) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = postCard(state.topic, p, badgeOf(T(state.topic), p));
  el.replaceWith(tmp.firstElementChild);
}

// ---------- AI要約（Claude API・利用者自身のキー） ----------
let sdkPromise = null;
function loadSDK() { if (!sdkPromise) sdkPromise = import(C.sdkUrl).catch(e => { sdkPromise = null; throw e; }); return sdkPromise; }
const AI_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'points', 'caution'],
  properties: {
    headline: { type: 'string' },
    points: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['title', 'detail', 'refs'], properties: { title: { type: 'string' }, detail: { type: 'string' }, refs: { type: 'array', items: { type: 'integer' } } } }
    },
    caution: { type: 'string' }
  }
};
function aiPosts(tid) {
  const { out } = buildView(tid);
  const latest = [], rest = [];
  for (const k in out) {
    const { def, base } = out[k];
    if (def.latest) latest.push(...base.slice().sort((a, b) => b.ts - a.ts).slice(0, def.limit));
    else rest.push(...base);
  }
  rest.sort((a, b) => b._hot - a._hot);
  return latest.concat(rest).slice(0, 40);
}
function aiInput(topic, posts) {
  const lines = posts.map((p, i) => {
    let s = `[${i + 1}] @${p.a.h}（${p.a.n}）${jst(p.ts * 1000)} ♥${p.lk} 🔁${p.rp} 🔖${p.bm}`;
    const b = badgeOf(topic, p); if (b) s += ` 〔${b}〕`;
    if (p.cn) s += ' ※コミュニティノートあり: ' + stripUrls(p.cn).slice(0, 200);
    s += '\n' + stripUrls(p.x).slice(0, 700);
    if (p.q) s += `\n（引用元 @${p.q.h}: ${stripUrls(p.q.x).slice(0, 200)}）`;
    return s;
  });
  return `以下は「${topic.aiLabel}」について、日本時間 ${jst(Date.now())} 時点で直近${state.windowH}時間にXで反響の大きかった投稿です。[ ]内の数字が投稿番号です。\n\n${lines.join('\n\n')}`;
}
async function summarize() {
  const tid = state.topic, topic = T(tid);
  const key = LS.get('apiKey', '');
  if (!key) { openSettings(); return; }
  const model = C.models.find(m => m.id === LS.get('model', C.models[0].id)) || C.models[0];
  const posts = aiPosts(tid);
  if (posts.length < 3) { state.ai.err = '要約できるほどの投稿がまだありません。↻ で取得するか、期間を広げてください。'; render(); return; }
  state.ai = { busy: true, err: '' }; render();
  let Anthropic;
  try {
    Anthropic = (await loadSDK()).default;
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const params = {
      model: model.id,
      max_tokens: 16000,
      system: topic.aiSystem,
      messages: [{ role: 'user', content: aiInput(topic, posts) }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: AI_SCHEMA } }
    };
    if (model.fallback) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
    const res = await client.beta.messages.create(params);
    if (res.stop_reason === 'refusal') throw new Error('Claude がこの内容の要約を断りました（安全上の判定）。期間や内容を変えて試してください。');
    if (res.stop_reason === 'max_tokens') throw new Error('出力が長すぎて途中で切れました。もう一度試してください。');
    const block = res.content.find(b => b.type === 'text');
    if (!block) throw new Error('要約の結果が空でした。');
    const data = JSON.parse(block.text);
    const u = res.usage || {};
    const usd = ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)) * model.inUsd / 1e6 + (u.output_tokens || 0) * model.outUsd / 1e6;
    LS.set('ai.' + tid, { at: Date.now(), windowH: state.windowH, model: res.model, modelLabel: model.label.replace(/（.*/, ''), data, ids: posts.map(p => p.id), urls: posts.map(p => p.u), usd });
    state.ai = { busy: false, err: '' };
  } catch (e) {
    console.error(e);
    let msg = e && e.message ? e.message : String(e);
    if (Anthropic && e instanceof Anthropic.AuthenticationError) msg = 'APIキーが正しくないようです。設定で確かめてください。';
    else if (Anthropic && e instanceof Anthropic.PermissionDeniedError) msg = 'このAPIキーではこのモデルを使えません（権限エラー）。';
    else if (Anthropic && e instanceof Anthropic.RateLimitError) msg = '利用回数の上限に達しました。少し待ってから試してください。';
    else if (Anthropic && e instanceof Anthropic.BadRequestError) msg = 'リクエストが受け付けられませんでした：' + msg + '（残高不足のときもこのエラーになります）';
    else if (Anthropic && e instanceof Anthropic.APIConnectionError) msg = 'Claude API に接続できませんでした。通信状況を確かめてください。';
    else if (Anthropic && e instanceof Anthropic.APIError) msg = `Claude API のエラー（${e.status}）：${msg}`;
    else if (!Anthropic) msg = 'AI要約の部品（Anthropic SDK）を読み込めませんでした。通信状況を確かめてください。';
    state.ai = { busy: false, err: msg };
  }
  render();
}

// ---------- 設定 ----------
function openSettings() {
  const d = $('#settings');
  $('#sKey').value = LS.get('apiKey', '');
  $('#sModel').innerHTML = C.models.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  $('#sModel').value = LS.get('model', C.models[0].id);
  modelHint();
  $('#sWords').value = state.mute.words.join('\n');
  $('#sAuthors').value = state.mute.authors.join('\n');
  if (d.showModal) d.showModal(); else d.setAttribute('open', '');
}
function modelHint() {
  const m = C.models.find(x => x.id === $('#sModel').value) || C.models[0];
  $('#sModelHint').textContent = `1回の要約で 約$${estCost(m)}（目安）。${m.fallback ? '' : 'このモデルは安全判定で断られたときの自動切り替えがありません。'}`;
}
function closeSettings() { const d = $('#settings'); if (d.close) d.close(); else d.removeAttribute('open'); }
const lines = s => s.split(/\r?\n/).map(x => x.trim().replace(/^@/, '')).filter(Boolean);

// ---------- 操作 ----------
function switchTopic(tid) {
  if (tid === state.topic) return;
  LS.set('visit.' + state.topic, Date.now());
  state.topic = tid; LS.set('topic', tid);
  state.term = null; state.ai.err = '';
  state.prevVisit[tid] = LS.get('visit.' + tid, 0);
  render(); window.scrollTo(0, 0);
  maybeRefresh(tid, 5); translateVisible();
}
function maybeRefresh(tid, minutes) {
  const c = cache(tid);
  if (Date.now() - (c.fetchedAt || 0) > minutes * 60e3) refresh(tid);
}
document.addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (tab) { switchTopic(tab.dataset.t); return; }
  const w = e.target.closest('#winSeg button');
  if (w) { state.windowH = +w.dataset.w; LS.set('windowH', state.windowH); render(); translateVisible(); return; }
  const so = e.target.closest('#sortSeg button');
  if (so) { state.sort = so.dataset.s; LS.set('sort', state.sort); render(); translateVisible(); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'expand') {
    if (e.target.closest('a')) return;
    const id = a.dataset.id;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    a.classList.toggle('clamp');
  } else if (act === 'orig') {
    const id = a.dataset.id;
    if (state.showOrig.has(id)) state.showOrig.delete(id); else state.showOrig.add(id);
    const p = cache(state.topic).posts[id]; if (p) updateCardText(p);
  } else if (act === 'term') {
    const k = a.dataset.k;
    state.term = state.term && state.term.toLowerCase() === k.toLowerCase() ? null : k;
    render(); translateVisible();
  } else if (act === 'clearf') {
    state.term = null; state.q = ''; $('#q').value = ''; render();
  } else if (act === 'region') {
    state.region = a.dataset.v; render(); translateVisible();
  } else if (act === 'more') {
    const k = a.dataset.k;
    const def = T(state.topic).sections.find(s => state.topic + '.' + s.id === k);
    state.limits[k] = (state.limits[k] || def.limit) + (+a.dataset.step || 10);
    render(); translateVisible();
  } else if (act === 'mute') {
    const h = a.dataset.h;
    if (!confirm(`@${h} の投稿を今後表示しないようにしますか？（設定で戻せます）`)) return;
    if (!state.mute.authors.includes(h)) state.mute.authors.push(h);
    LS.set('mute', state.mute); render();
  } else if (act === 'ai') {
    summarize();
  } else if (act === 'settings') {
    openSettings();
  } else if (act === 'ref') {
    const el = document.getElementById('p-' + a.dataset.id);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
    else if (a.dataset.u) window.open(a.dataset.u, '_blank', 'noopener');
  }
});
let qTimer = 0;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); render(); translateVisible(); }, 250); });
$('#refresh').addEventListener('click', () => refresh(state.topic));
$('#settingsBtn').addEventListener('click', openSettings);
$('#sModel').addEventListener('change', modelHint);
$('#sCancel').addEventListener('click', closeSettings);
$('#setForm').addEventListener('submit', e => {
  e.preventDefault();
  const key = $('#sKey').value.trim();
  if (key) LS.set('apiKey', key); else LS.del('apiKey');
  LS.set('model', $('#sModel').value);
  state.mute = { words: lines($('#sWords').value), authors: lines($('#sAuthors').value) };
  LS.set('mute', state.mute);
  state.ai.err = '';
  closeSettings(); render();
});
$('#sClear').addEventListener('click', () => {
  if (!confirm('取得した投稿・翻訳・AI要約の保存データを消します（APIキーとミュート設定は残します）。よろしいですか？')) return;
  for (const t of TOPICS) { LS.del('cache.' + t.id); LS.del('ai.' + t.id); LS.del('visit.' + t.id); }
  LS.del('tr'); TR = {}; state.caches = {}; state.prevVisit = {};
  closeSettings(); render(); refresh(state.topic);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') LS.set('visit.' + state.topic, Date.now());
  else { state.prevVisit[state.topic] = LS.get('visit.' + state.topic, 0); maybeRefresh(state.topic, 10); }
});
window.addEventListener('pagehide', () => LS.set('visit.' + state.topic, Date.now()));

// ---------- 起動 ----------
state.prevVisit[state.topic] = LS.get('visit.' + state.topic, 0);
render();
maybeRefresh(state.topic, 3);
translateVisible();
// もう一方のタブも少し遅れて取っておく（切り替えたときにすぐ見られるように）
setTimeout(() => { for (const t of TOPICS) if (t.id !== state.topic) maybeRefresh(t.id, 10); }, 4000);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
(() => { // iPhone の Safari では「ホーム画面に追加」の案内を一度だけ出す
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!ios || standalone || LS.get('installTipShown', false)) return;
  const tip = $('#installTip'); tip.style.display = 'block';
  $('#installX').addEventListener('click', () => { tip.style.display = 'none'; LS.set('installTipShown', true); });
})();
window.XD = { state, cache, buildView, topTerms, refresh, spamReason, aiPosts, aiInput }; // テスト用
})();
