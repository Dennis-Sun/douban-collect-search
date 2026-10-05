// ==UserScript==
// @name         豆瓣收藏高级搜索（音乐/电影/读书）
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  在豆瓣音乐/电影/读书的个人收藏页（听过/看过/读过 等）右侧栏增加高级搜索：跨全部收藏按作品名、表演者/作者/导演、年份、标签、我的评分、标记日期精确检索
// @author       WorkBuddy
// @match        https://music.douban.com/people/*/collect*
// @match        https://music.douban.com/people/*/wish*
// @match        https://music.douban.com/people/*/do*
// @match        https://movie.douban.com/people/*/collect*
// @match        https://movie.douban.com/people/*/wish*
// @match        https://movie.douban.com/people/*/do*
// @match        https://book.douban.com/people/*/collect*
// @match        https://book.douban.com/people/*/wish*
// @match        https://book.douban.com/people/*/do*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @connect      music.douban.com
// @connect      movie.douban.com
// @connect      book.douban.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 站点识别
   * ------------------------------------------------------------------ */
  const mm = location.href.match(/(music|movie|book)\.douban\.com\/people\/([^/?#]+)\/(collect|wish|do)/);
  if (!mm) return;

  const SITE = mm[1];
  const UID = mm[2];
  const STATUS = mm[3];                    // collect | wish | do
  const BASE = 'https://' + SITE + '.douban.com/people/' + UID + '/' + STATUS;

  /* ------------------------------------------------------------------ *
   * 站点差异配置
   *
   * 三个站的 .intro 结构完全不同，不能用同一套解析：
   *   music  表演者 / 发行日期 / 类型 / 介质 / 风格          —— 分段干净
   *   book   作者 / 出版社 / 出版日期 / 价格                 —— 分段干净
   *   movie  上映日期 / 主演… / 国家 / 官网 / 导演 / 片长 / 原名 / 类型 / 编剧 / 语言
   *          —— 整行拍平，且「导演」位置不固定（有时在片长前、有时在类型后），
   *             硬切会错。因此电影站对「主演/导演/编剧」做整行全文匹配。
   *
   * 另外：读书站收藏页不渲染用户标签（无 .tags），故标签筛选对 book 隐藏。
   * ------------------------------------------------------------------ */

  // 音乐：表演者之后 1~2 段内找带年份的段作为发行日期
  function parseMusic(segs) {
    let credit = '', year = '', extra = '', di = -1;
    for (let i = 1; i <= 2 && i < segs.length; i++) {
      const m = segs[i].match(/(19|20)\d{2}/);
      if (m) { year = m[0]; di = i; break; }
    }
    if (di > 0) {
      credit = segs.slice(0, di).join(' / ');
      extra = segs.slice(di + 1).join(' / ');
    } else if (segs.length) {
      credit = segs[0];
      extra = segs.slice(1).join(' / ');
    }
    return { credit: credit, year: year, extra: extra };
  }

  // 读书：第 1 段固定是作者，出版年份在第 2~4 段
  function parseBook(segs) {
    const credit = segs[0] || '';
    let year = '';
    for (let i = 1; i <= 3 && i < segs.length; i++) {
      const m = segs[i].match(/(19|20)\d{2}/);
      if (m) { year = m[0]; break; }
    }
    return { credit: credit, year: year, extra: segs.slice(1).join(' / ') };
  }

  // 电影：年份取首段；主演取「开头连续上映日期段之后」的 3 段；整行留作全文匹配
  function parseMovie(segs) {
    let year = '';
    const m0 = (segs[0] || '').match(/(19|20)\d{2}/);
    if (m0) year = m0[0];
    if (!year) {
      for (let i = 1; i <= 2 && i < segs.length; i++) {
        const m = segs[i].match(/(19|20)\d{2}/);
        if (m) { year = m[0]; break; }
      }
    }
    let i = 0;
    while (i < segs.length && /^\s*[（(]?(19|20)\d{2}/.test(segs[i])) i++;
    const cast = segs.slice(i, i + 3)
      .filter(s => !/^\d+\s*分钟$/.test(s) && !/^(https?:\/\/|www\.)/i.test(s));
    return { credit: cast.join(' / '), year: year, extra: segs.join(' / ') };
  }

  const CFG = {
    music: {
      statusCn: { collect: '听过', wish: '想听', do: '在听' },
      creditLabel: '表演者', creditHint: '如：Coltrane',
      yearLabel: '发行年份',
      titleHint: '如：Blue Train',
      hasTags: true, tagHint: '如：Jazz, Bebop',
      artistScope: 'credit',
      parse: parseMusic
    },
    movie: {
      statusCn: { collect: '看过', wish: '想看', do: '在看' },
      creditLabel: '主演 / 导演 / 编剧', creditHint: '如：诺兰（匹配整条影片信息）',
      yearLabel: '上映年份',
      titleHint: '如：星际穿越',
      hasTags: true, tagHint: '如：科幻, 悬疑',
      artistScope: 'all',
      parse: parseMovie
    },
    book: {
      statusCn: { collect: '读过', wish: '想读', do: '在读' },
      creditLabel: '作者', creditHint: '如：刘慈欣',
      yearLabel: '出版年份',
      titleHint: '如：百年孤独',
      hasTags: false, tagHint: '',
      artistScope: 'credit',
      parse: parseBook
    }
  }[SITE];

  const STATUS_CN = CFG.statusCn[STATUS];

  const STORE = 'dbcas_v1_' + SITE + '_' + UID + '_' + STATUS;
  const META_KEY = STORE + ':meta';
  const LEGACY_STORE = 'dbmusic_as_v1_' + UID + '_' + STATUS;   // 0.2.x 的音乐索引键

  const PAGE_SIZE = 30;
  const DELAY_MIN = 1500;
  const DELAY_MAX = 2600;
  const MAX_PAGES = 400;
  const AUTO_REFRESH_MS = 12 * 3600 * 1000;

  const US = '\u0001';   // 字段分隔
  const RS = '\u0002';   // 记录分隔

  // 记录结构：[id, 作品名, 表演者/作者/主演, 年份, 标签, 我的评分, 标记日期, 补充信息]
  let INDEX = [];
  let META = null;
  let busy = false;

  /* ------------------------------------------------------------------ *
   * 索引持久化
   * ------------------------------------------------------------------ */
  function saveIndex(items) {
    const raw = items.map(r => r.join(US)).join(RS);
    const CHUNK = 400000;
    const n = Math.max(1, Math.ceil(raw.length / CHUNK));
    const prev = GM_getValue(STORE + ':n', 0);
    for (let i = n; i < prev; i++) GM_deleteValue(STORE + ':' + i);
    GM_setValue(STORE + ':n', n);
    for (let i = 0; i < n; i++) GM_setValue(STORE + ':' + i, raw.slice(i * CHUNK, (i + 1) * CHUNK));
  }

  function loadIndex() {
    const n = GM_getValue(STORE + ':n', 0);
    if (!n) return [];
    let raw = '';
    for (let i = 0; i < n; i++) raw += GM_getValue(STORE + ':' + i, '');
    if (!raw) return [];
    return raw.split(RS).filter(Boolean).map(s => s.split(US));
  }

  // 音乐站：从 0.2.x 的旧键迁移，避免让用户重新抓一次 5000 条
  function migrateLegacy() {
    if (SITE !== 'music') return;
    if (GM_getValue(STORE + ':n', 0)) return;
    const n = GM_getValue(LEGACY_STORE + ':n', 0);
    if (!n) return;
    for (let i = 0; i < n; i++) GM_setValue(STORE + ':' + i, GM_getValue(LEGACY_STORE + ':' + i, ''));
    GM_setValue(STORE + ':n', n);
    const om = GM_getValue(LEGACY_STORE + ':meta', null);
    if (om) GM_setValue(META_KEY, om);
  }

  function saveMeta(meta) { META = meta; GM_setValue(META_KEY, JSON.stringify(meta)); }
  function loadMeta() {
    try { return JSON.parse(GM_getValue(META_KEY, 'null')); } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ *
   * 页面解析
   * ------------------------------------------------------------------ */
  function parseList(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];

    doc.querySelectorAll('ul.list-view > li.item').forEach(li => {
      const idm = (li.id || '').match(/^list(\d+)$/);
      const sid = idm ? idm[1] : '';
      const a = li.querySelector('.title a');
      const title = a ? a.textContent.replace(/\s+/g, ' ').trim() : '';
      if (!title) return;

      let credit = '', year = '', extra = '';
      const introEl = li.querySelector('.grid-date .intro');
      if (introEl) {
        const segs = introEl.textContent.split('/').map(s => s.trim()).filter(Boolean);
        const p = CFG.parse(segs);
        credit = p.credit; year = p.year; extra = p.extra;
      }

      let tags = [];
      const tagEl = li.querySelector('.grid-date .tags');
      if (tagEl) {
        tags = tagEl.textContent.replace(/^\s*标签\s*[:：]\s*/, '').trim()
          .split(/[\s,，、]+/).filter(Boolean);
      }

      let rating = '', markDate = '';
      const dateEl = li.querySelector('.date');
      if (dateEl) {
        const rs = dateEl.querySelector('span[class*="rating"]');
        const rc = rs ? (rs.className.match(/rating(\d)-t/) || [])[1] : null;
        if (rc) rating = rc;
        const dm = dateEl.textContent.match(/(20\d{2})-(\d{2})-(\d{2})/);
        if (dm) markDate = dm[0];
      }

      out.push([sid, title, credit, year, tags.join(' '), rating, markDate, extra]);
    });

    let total = 0;
    const numEl = doc.querySelector('.subject-num');
    if (numEl) {
      const tm = numEl.textContent.match(/\/\s*([\d,]+)/);
      if (tm) total = parseInt(tm[1].replace(/,/g, ''), 10) || 0;
    }
    return { items: out, total: total };
  }

  /* ------------------------------------------------------------------ *
   * 网络
   * ------------------------------------------------------------------ */
  function fetchPage(start) {
    return new Promise(resolve => {
      const url = BASE + '?start=' + start + '&sort=time&mode=list&filter=all&tags_sort=count';
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Referer': 'https://' + SITE + '.douban.com/'
        },
        onload: r => resolve({ ok: r.status === 200, status: r.status, text: r.responseText }),
        onerror: () => resolve({ ok: false, status: 0, text: '' }),
        ontimeout: () => resolve({ ok: false, status: -1, text: '' })
      });
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const randDelay = () => DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);

  /* ------------------------------------------------------------------ *
   * 建索引 / 增量更新
   * ------------------------------------------------------------------ */
  function mergeItems(base, incoming) {
    const seen = new Set(base.map(r => r[0] + '|' + r[1]));
    let added = 0;
    incoming.forEach(r => {
      const k = r[0] + '|' + r[1];
      if (!seen.has(k)) { seen.add(k); base.push(r); added++; }
    });
    return added;
  }

  async function buildIndex(full) {
    if (busy) return;
    busy = true;
    setButtonsEnabled(false);

    const isFull = full || !INDEX.length;
    let collected = isFull ? [] : INDEX.slice();
    let start = 0, pages = 0, total = (META && META.total) || 0;
    let aborted = null;

    while (pages < MAX_PAGES) {
      setStatus((isFull ? '正在建立全量索引…' : '正在增量更新…') +
        ' 第 ' + (pages + 1) + ' 页 · 已收录 ' + collected.length + (total ? ' / ' + total : '') + ' 条');

      const res = await fetchPage(start);
      if (!res.ok) {
        aborted = res.status === 403
          ? '被豆瓣拒绝（403），请稍后再试；若刚建过索引，等一会儿再试'
          : '请求失败（HTTP ' + res.status + '），已安全中断';
        break;
      }
      const parsed = parseList(res.text);
      if (parsed.total) total = parsed.total;
      if (!parsed.items.length) break;

      const added = mergeItems(collected, parsed.items);
      pages++;
      start += PAGE_SIZE;

      if (isFull) {
        // 部分页会因条目下架返回不足 30 条，因此只在拿不到总数时才用「短页」判尾
        if (total > 0 && start >= total) break;
        if (total === 0 && parsed.items.length < PAGE_SIZE) break;
      } else {
        if (added === 0) break;
        if (pages >= 8) break;
      }

      await sleep(randDelay());
    }

    if (collected.length) {
      INDEX = collected;
      saveIndex(INDEX);
      saveMeta({ builtAt: Date.now(), total: total || INDEX.length, count: INDEX.length });
    }

    busy = false;
    setButtonsEnabled(true);
    renderMeta();
    if (aborted) setStatus(aborted + '（已保留已收录的 ' + INDEX.length + ' 条）', true);
    else setStatus((isFull ? '索引建立完成' : '增量更新完成') + '：共 ' + INDEX.length + ' 条');
    doSearch();
  }

  /* ------------------------------------------------------------------ *
   * 检索
   * ------------------------------------------------------------------ */

  // 归一化：压掉斜杠两侧空白，让「AC/DC」能匹配到信息行里的「AC / DC」
  const norm = s => (s || '').toLowerCase().replace(/\s*\/\s*/g, '/');
  const tokens = s => (s || '').split(/[\s,，、]+/).filter(Boolean);

  function search(f) {
    const tTitle = tokens(f.title).map(norm);
    const tArtist = tokens(f.artist).map(norm);
    const tTags = tokens(f.tags).map(s => s.toLowerCase());
    const yFrom = parseInt(f.yFrom, 10);
    const yTo = parseInt(f.yTo, 10);
    const hasFrom = !isNaN(yFrom), hasTo = !isNaN(yTo);
    const rFrom = parseInt(f.rFrom, 10);
    const rTo = parseInt(f.rTo, 10);
    const hasRFrom = !isNaN(rFrom), hasRTo = !isNaN(rTo);

    return INDEX.filter(r => {
      if (tTitle.length && !tTitle.every(t => norm(r[1]).includes(t))) return false;

      if (tArtist.length) {
        const hay = norm(CFG.artistScope === 'all' ? (r[2] + ' ' + r[7]) : r[2]);
        if (!tArtist.every(t => hay.includes(t))) return false;
      }

      if (hasFrom || hasTo) {
        if (!r[3]) { if (!f.includeUnknown) return false; }
        else {
          const y = parseInt(r[3], 10);
          if (hasFrom && y < yFrom) return false;
          if (hasTo && y > yTo) return false;
        }
      }

      if (f.rFrom === '0') {
        if (r[5]) return false;                              // 只看未评分
      } else if (hasRFrom || hasRTo) {
        if (!r[5]) { if (!f.includeUnknown) return false; }
        else {
          const rv = parseInt(r[5], 10);
          if (hasRFrom && rv < rFrom) return false;
          if (hasRTo && rv > rTo) return false;
        }
      }

      if (f.dFrom || f.dTo) {
        if (!r[6]) return false;
        if (f.dFrom && r[6] < f.dFrom) return false;
        if (f.dTo && r[6] > f.dTo) return false;
      }

      if (tTags.length) {
        const itemTags = (r[4] || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!f.tagOr
          ? !tTags.every(t => itemTags.includes(t))
          : !tTags.some(t => itemTags.includes(t))) return false;
      }
      return true;
    });
  }

  /* ------------------------------------------------------------------ *
   * 界面
   * ------------------------------------------------------------------ */
  GM_addStyle(`
    .dmas{border:1px solid #e0e0e0;border-radius:6px;background:#fbfbfb;padding:10px 12px;margin-bottom:14px;font-size:13px;color:#333;line-height:1.6}
    .dmas h3{margin:0 0 8px;font-size:14px;font-weight:700;color:#333;border-bottom:1px solid #eee;padding-bottom:6px}
    .dmas label{display:block;margin:7px 0 3px;color:#666;font-size:12px}
    .dmas input[type=text],.dmas input[type=number],.dmas input[type=date],.dmas select{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid #ccc;border-radius:3px;font-size:13px;background:#fff;color:#333}
    .dmas .row{display:flex;gap:6px;align-items:center}
    .dmas .row input{width:100%}
    .dmas .sep{color:#999;flex:0 0 auto}
    .dmas .opts{margin:8px 0 0;font-size:12px;color:#666}
    .dmas .opts label{display:inline;margin:0 10px 0 0;color:#666}
    .dmas .btns{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap}
    .dmas button{border:1px solid #ccc;background:#fff;color:#333;border-radius:3px;padding:4px 10px;cursor:pointer;font-size:12px}
    .dmas button:hover{background:#f0f0f0}
    .dmas button.primary{background:#42bd56;border-color:#3aa94e;color:#fff}
    .dmas button.primary:hover{background:#3aa94e}
    .dmas button:disabled{opacity:.5;cursor:default}
    .dmas .status{margin-top:8px;font-size:12px;color:#777;min-height:1.6em}
    .dmas .status.err{color:#c33}
    .dmas .res{margin-top:10px;border-top:1px solid #eee;padding-top:8px}
    .dmas .res-head{font-size:12px;color:#666;margin-bottom:6px}
    .dmas .res-head b{color:#c33}
    .dmas ul{margin:0;padding:0;list-style:none;max-height:420px;overflow:auto}
    .dmas li{padding:5px 0;border-bottom:1px dotted #eee}
    .dmas li:last-child{border-bottom:0}
    .dmas li a{color:#37a;font-size:13px;text-decoration:none}
    .dmas li a:hover{text-decoration:underline}
    .dmas .meta{color:#888;font-size:12px}
    .dmas .tag{display:inline-block;background:#f2f2f2;color:#666;border-radius:2px;padding:0 4px;margin:2px 3px 0 0;font-size:11px;cursor:pointer}
    .dmas .tag:hover{background:#e0e0e0}
    .dmas .more{font-size:12px;color:#37a;cursor:pointer;margin-top:6px;display:inline-block}
    .dmas .hint{font-size:11px;color:#999;margin-top:4px}
  `);

  const aside = document.querySelector('.aside');
  if (!aside) return;

  const tagsBlock = CFG.hasTags ? `
    <label>标签（逗号或空格分隔，精确匹配）</label>
    <input type="text" id="dmas-tags" list="dmas-taglist" placeholder="${CFG.tagHint}">
    <datalist id="dmas-taglist"></datalist>` : '';

  const root = document.createElement('div');
  root.className = 'dmas';
  root.innerHTML = `
    <h3>高级搜索 · ${STATUS_CN}</h3>
    <label>作品名（空格分隔多个关键词 = 同时满足）</label>
    <input type="text" id="dmas-title" placeholder="${CFG.titleHint}">
    <label>${CFG.creditLabel}</label>
    <input type="text" id="dmas-artist" placeholder="${CFG.creditHint}">
    <label>${CFG.yearLabel}</label>
    <div class="row">
      <input type="number" id="dmas-yfrom" placeholder="起始">
      <span class="sep">–</span>
      <input type="number" id="dmas-yto" placeholder="结束">
    </div>${tagsBlock}
    <label>我的评分</label>
    <div class="row">
      <select id="dmas-rfrom">
        <option value="">最低</option><option value="1">★</option><option value="2">★★</option>
        <option value="3">★★★</option><option value="4">★★★★</option><option value="5">★★★★★</option>
        <option value="0">只看未评分</option>
      </select>
      <span class="sep">–</span>
      <select id="dmas-rto">
        <option value="">最高</option><option value="1">★</option><option value="2">★★</option>
        <option value="3">★★★</option><option value="4">★★★★</option><option value="5">★★★★★</option>
      </select>
    </div>
    <label>标记日期</label>
    <div class="row">
      <input type="date" id="dmas-dfrom" title="起始日期">
      <span class="sep">–</span>
      <input type="date" id="dmas-dto" title="结束日期">
    </div>
    <div class="opts">
      ${CFG.hasTags ? '<label><input type="checkbox" id="dmas-tagor"> 标签任一匹配（OR）</label>' : ''}
      <label><input type="checkbox" id="dmas-unk"> 包含年份未知 / 未评分</label>
    </div>
    <div class="btns">
      <button class="primary" id="dmas-go">搜索</button>
      <button id="dmas-clear">清空</button>
      <button id="dmas-build">建立/重建全量索引</button>
      <button id="dmas-upd">增量更新</button>
    </div>
    <div class="status" id="dmas-status"></div>
    <div class="hint" id="dmas-meta"></div>
    <div class="res" id="dmas-res" style="display:none"></div>
  `;
  aside.insertBefore(root, aside.firstChild);

  const $ = id => document.getElementById(id);
  const elStatus = $('dmas-status'), elRes = $('dmas-res'), elMeta = $('dmas-meta');

  function setStatus(msg, isErr) {
    elStatus.textContent = msg;
    elStatus.className = 'status' + (isErr ? ' err' : '');
  }
  function setButtonsEnabled(on) {
    ['dmas-go', 'dmas-build', 'dmas-upd'].forEach(id => { $(id).disabled = !on; });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderMeta() {
    if (!META) { elMeta.textContent = '尚未建立索引，点击「建立全量索引」以搜索全部' + STATUS_CN + '。'; return; }
    elMeta.textContent = '索引：' + META.count + ' 条 · 更新于 ' + fmtDate(META.builtAt);
    if (!CFG.hasTags) return;
    const dl = $('dmas-taglist');
    if (!dl) return;
    const counter = new Map();
    INDEX.forEach(r => (r[4] || '').split(/\s+/).filter(Boolean)
      .forEach(t => counter.set(t, (counter.get(t) || 0) + 1)));
    dl.innerHTML = [...counter.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 300)
      .map(([t, c]) => '<option value="' + esc(t) + '">' + esc(String(c)) + '</option>').join('');
  }

  /* ------------------------------------------------------------------ *
   * 结果渲染
   * ------------------------------------------------------------------ */
  let lastResults = [];
  let expanded = false;

  function renderResults() {
    if (!lastResults.length) {
      elRes.style.display = '';
      elRes.innerHTML = '<div class="res-head">没有匹配的条目。</div>';
      return;
    }
    elRes.style.display = '';
    const LIMIT = expanded ? lastResults.length : 100;
    const shown = lastResults.slice(0, LIMIT);

    const lis = shown.map(r => {
      const sid = r[0], title = r[1], credit = r[2], year = r[3], tags = r[4], rating = r[5], date = r[6];
      const url = sid ? 'https://' + SITE + '.douban.com/subject/' + sid + '/' : '#';
      const metaParts = [];
      if (credit) metaParts.push(esc(credit));
      metaParts.push(year ? year : '年份未知');
      if (rating) metaParts.push('★'.repeat(parseInt(rating, 10)));
      if (date) metaParts.push(date + ' 标记');
      const tagHtml = tags
        ? tags.split(/\s+/).filter(Boolean)
          .map(t => '<span class="tag" data-tag="' + esc(t) + '">' + esc(t) + '</span>').join('')
        : '';
      return '<li><a href="' + url + '" target="_blank" rel="noreferrer">' + esc(title) + '</a>' +
        '<div class="meta">' + metaParts.join(' · ') + '</div>' +
        (tagHtml ? '<div>' + tagHtml + '</div>' : '') + '</li>';
    }).join('');

    elRes.innerHTML =
      '<div class="res-head">命中 <b>' + lastResults.length + '</b> 条' +
      (LIMIT < lastResults.length ? '（显示前 ' + LIMIT + ' 条）' : '') +
      ' <span id="dmas-exp" class="more">导出 CSV</span></div>' +
      '<ul>' + lis + '</ul>' +
      (LIMIT < lastResults.length ? '<span class="more" id="dmas-more">展开全部 ' + lastResults.length + ' 条</span>' : '') +
      (expanded && lastResults.length > 100 ? '<span class="more" id="dmas-collapse">收起</span>' : '');

    const exp = $('dmas-exp');
    if (exp) exp.onclick = exportCsv;
    const more = $('dmas-more');
    if (more) more.onclick = () => { expanded = true; renderResults(); };
    const col = $('dmas-collapse');
    if (col) col.onclick = () => { expanded = false; renderResults(); };

    elRes.querySelectorAll('.tag').forEach(t => {
      t.onclick = () => {
        const input = $('dmas-tags');
        if (!input) return;
        const cur = input.value.trim();
        const v = t.dataset.tag;
        if (!new RegExp('(^|[,，\\s])' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([,，\\s]|$)', 'i').test(cur)) {
          input.value = cur ? cur + ', ' + v : v;
          doSearch();
        }
      };
    });
  }

  function exportCsv() {
    const head = ['作品名', CFG.creditLabel, '年份', '标签', '我的评分', '标记日期', '链接'];
    const rows = lastResults.map(r => [
      r[1], r[2], r[3] || '未知', r[4], r[5] ? '★'.repeat(parseInt(r[5], 10)) : '', r[6],
      r[0] ? 'https://' + SITE + '.douban.com/subject/' + r[0] + '/' : ''
    ]);
    const csv = [head].concat(rows)
      .map(row => row.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(','))
      .join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '豆瓣' + STATUS_CN + '_搜索结果.csv';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function doSearch() {
    if (!INDEX.length) {
      elRes.style.display = '';
      elRes.innerHTML = '<div class="res-head">索引为空，请先建立索引。</div>';
      return;
    }
    const f = {
      title: $('dmas-title').value,
      artist: $('dmas-artist').value,
      yFrom: $('dmas-yfrom').value,
      yTo: $('dmas-yto').value,
      tags: CFG.hasTags ? $('dmas-tags').value : '',
      rFrom: $('dmas-rfrom').value,
      rTo: $('dmas-rto').value,
      dFrom: $('dmas-dfrom').value,
      dTo: $('dmas-dto').value,
      tagOr: $('dmas-tagor') ? $('dmas-tagor').checked : false,
      includeUnknown: $('dmas-unk').checked
    };
    const any = ['title', 'artist', 'yFrom', 'yTo', 'tags', 'rFrom', 'rTo', 'dFrom', 'dTo']
      .some(k => String(f[k]).trim() !== '');
    if (!any) {
      elRes.style.display = 'none';
      lastResults = [];
      setStatus('');
      return;
    }
    lastResults = search(f);
    expanded = false;
    renderResults();
    setStatus('命中 ' + lastResults.length + ' / ' + INDEX.length + ' 条');
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */
  const FIELD_IDS = ['dmas-title', 'dmas-artist', 'dmas-yfrom', 'dmas-yto']
    .concat(CFG.hasTags ? ['dmas-tags'] : [])
    .concat(['dmas-rfrom', 'dmas-rto', 'dmas-dfrom', 'dmas-dto']);

  $('dmas-go').onclick = doSearch;
  FIELD_IDS.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  });
  ['dmas-rfrom', 'dmas-rto', 'dmas-dfrom', 'dmas-dto'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', doSearch);
  });
  const tagOr = $('dmas-tagor');
  if (tagOr) tagOr.onchange = doSearch;
  $('dmas-unk').onchange = doSearch;

  $('dmas-clear').onclick = () => {
    FIELD_IDS.forEach(id => { const el = $(id); if (el) el.value = ''; });
    $('dmas-unk').checked = false;
    if (tagOr) tagOr.checked = false;
    lastResults = []; elRes.style.display = 'none'; setStatus('');
  };
  $('dmas-build').onclick = () => {
    if (INDEX.length && !confirm('将重新抓取全部收藏页（约需数分钟），确定重建索引？')) return;
    buildIndex(true);
  };
  $('dmas-upd').onclick = () => buildIndex(false);

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  migrateLegacy();
  INDEX = loadIndex();
  META = loadMeta();
  renderMeta();

  if (INDEX.length) {
    setStatus('已载入本地索引 ' + INDEX.length + ' 条');
    if (META && Date.now() - META.builtAt > AUTO_REFRESH_MS) {
      setStatus('索引已超过 12 小时，后台增量更新中…');
      buildIndex(false);
    }
  } else {
    setStatus('尚未建立索引。点击「建立全量索引」后即可跨全部' + STATUS_CN + '搜索。');
  }
})();
