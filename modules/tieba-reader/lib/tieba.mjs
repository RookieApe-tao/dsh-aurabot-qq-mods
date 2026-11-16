import { load } from 'cheerio/slim';

export const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export const cleanTitle = raw => clean(raw)
  .replace(/\s*[-_]\s*百度贴吧\s*icon_[\s\S]*$/i, '')
  .replace(/\s*[-_]\s*百度贴吧\s*$/, '').trim().slice(0, 250);
const nodeText = node => { const copy = node.clone(); copy.find('svg,script,style,noscript').remove(); return copy.text(); };
const documentTitle = $ => $('head > title').first().text() || $('title').filter((_i, el) => !$(el).parents('svg').length).first().text();
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 10; Pixel 3) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';
export function barNames(raw) {
  return [...new Set(String(raw || '').split(/[\n,，;；]+/).map((s) => clean(s).replace(/吧$/, '')).filter(Boolean))].slice(0, 20);
}
export function postUrl(raw) {
  const s = String(raw || '').trim();
  if (/^\d{5,20}$/.test(s)) return `https://tieba.baidu.com/p/${s}`;
  let u;
  try { u = new URL(s, 'https://tieba.baidu.com'); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'tieba.baidu.com' || u.port || u.username || u.password) return null;
  const m = u.pathname.match(/^\/p\/(\d{5,20})\/?$/);
  return m ? `https://tieba.baidu.com/p/${m[1]}` : null;
}
export function cookieHeader(raw) {
  if (/[\r\n]/.test(String(raw || ''))) throw new Error('Cookie 不能含换行。');
  const allowed = new Set(['BDUSS', 'BDUSS_BFESS', 'STOKEN', 'BAIDUID', 'BAIDUID_BFESS', 'TIEBAUID', 'USER_JUMP', 'PSTM']);
  return String(raw || '').split(';').map((p) => p.trim()).filter((p) => allowed.has(p.split('=')[0])).join('; ');
}
export function checkPage(html) {
  const $ = load(html);
  const title = documentTitle($);
  if (/百度安全验证|安全验证|访问验证|验证码/.test(title) || $('#captcha,#vcode,#wappassverify').length) {
    throw new Error('贴吧要求安全验证，请在浏览器登录贴吧并完成验证；本模块不自动绕过验证。');
  }
  return $;
}
export function parseList(html, mode = 'forum') {
  const $ = checkPage(html);
  // 贴吧有时把列表放在 HTML 注释里。
  if (!$('.j_thread_list').length) {
    const block = String(html).match(/<!--[\s\S]*?j_thread_list[\s\S]*?-->/);
    if (block) $.root().append(block[0].slice(4, -3));
  }
  const out = [];
  const selector = mode === 'search' ? '.s_post' : '.thread-card, .j_thread_list, .threadlist_li';
  $(selector).each((_i, el) => {
    const root = $(el);
    const a = root.find(mode === 'search' ? '.p_title a, a.bluelink' : 'a.thread-content-link, a.j_th_tit, .threadlist_title a, a[href*="/p/"]').first();
    const url = postUrl(a.attr('href'));
    const title = cleanTitle(a.attr('title') || nodeText(root.find('.thread-title').first()) || nodeText(a));
    if (url && title && !out.some((p) => p.url === url)) out.push({ url, title,
      snippet: clean(root.find('.thread-content,.threadlist_abs,.p_content').first().text()).slice(0, 700), source: '贴吧列表（尚未读取正文）' });
  });
  return out.slice(0, 8);
}
export function parseHome(html) {
  const $ = checkPage(html);
  const seen = new Set(); const items = [];
  $('a[href]').each((_i, el) => {
    const a = $(el); const url = postUrl(a.attr('href'));
    if (!url || seen.has(url)) return;
    const card = a.closest('.thread-card,.feed-card,.feed-item,.feed_item,.feed_card,.threadlist_li,li,article').first();
    const title = cleanTitle(a.attr('title') || nodeText(card.find('.thread-title,.feed-title,.post-title,h2,h3').first()) || nodeText(a));
    if (title.length < 2 || /^\d+[万亿]?$/.test(title)) return;
    const hot = a.closest('.hot-list,.hot_list,.hot-thread,.hot_thread,.rank-list,.rank_list,[class^="hot-"],[class^="hot_"],[class^="rank-"],[class^="rank_"]').length > 0;
    const forum = card.find('a[href*="/f?"]').first();
    let bar = '';
    try { bar = clean(new URL(forum.attr('href'), 'https://tieba.baidu.com').searchParams.get('kw')).replace(/吧$/, ''); } catch {}
    seen.add(url);
    items.push({ url, title: title.slice(0, 250), bar, section: hot ? '首页热门' : '首页推荐',
      source: `贴吧${hot ? '首页热门' : '首页推荐'}（尚未读取正文）` });
  });
  return items.slice(0, 12);
}
export function parsePost(html, url) {
  const $ = checkPage(html);
  const title = cleanTitle(nodeText($('.core_title_txt').first()) || documentTitle($));
  const posts = [];
  const textOf = node => {
    const content = node.clone();
    content.find('svg,script,style,noscript').remove();
    content.find('br').replaceWith('\n');
    return clean(content.text());
  };
  const opening = $('.pb-content-wrap').first();
  if (opening.length) {
    const imageCount = opening.find('img').length;
    const text = textOf(opening);
    posts.push({ section: '楼主正文', text: text.slice(0, 3000) || (imageCount ? '[楼主主要发布图片，此工具未识别图片内容。]' : '[楼主没有可读取的文字正文。]') });
    $('.d_post_content,.pb-content-item').each((_i, el) => {
      if (opening.find(el).length || $(el).parents('.d_post_content,.pb-content-item').length) return;
      const text = textOf($(el));
      if (text) posts.push({ section: '可见回复（顺序，不代表楼层号）', text: text.slice(0, 2500) });
    });
    return { url, title, posts: posts.slice(0, 10), imageCount, source: '贴吧正文（第 1 页，最多 10 段，未展开全部楼中楼）' };
  }
  $('.l_post').each((_i, el) => {
    const root = $(el);
    const content = root.find('.d_post_content').first().clone();
    content.find('svg,script,style').remove();
    content.find('br').replaceWith('\n');
    const text = clean(content.text());
    if (!text) return;
    let field = {};
    try { field = JSON.parse(root.attr('data-field') || '{}'); } catch {}
    posts.push({ author: clean(root.find('.p_author_name').first().text()),
      floor: field.content?.post_no || posts.length + 1, text: text.slice(0, 2500) });
  });
  if (!posts.length) throw new Error('未读到帖子正文，可能需要登录、帖子已删除或页面结构已变化。');
  return { url, title, posts: posts.slice(0, 10), source: '贴吧正文（第 1 页，最多 10 楼）' };
}
/**
 * 手机版列表：新版桌面页是 JS 渲染的 SPA，服务端直读只能拿到空壳；
 * /mo/q/threadlist 仍是服务端渲染的 HTML，移动 UA 下无需浏览器也能解析。
 * 结构：li.tl_shadow > a.ti_item[href="/p/..."] > .ti_title（置顶项会带 .ti_title_icon）。
 */
export function parseMobileList(html) {
  const $ = checkPage(html);
  const out = []; const seen = new Set();
  $('a.ti_item[href]').each((_i, el) => {
    const a = $(el);
    const url = postUrl(a.attr('href'));
    if (!url || seen.has(url)) return;
    const titleNode = a.find('.ti_title').first().clone();
    titleNode.find('.ti_title_icon, svg, script, style, noscript').remove();
    const title = cleanTitle(titleNode.text() || a.attr('title') || '');
    if (!title) return;
    seen.add(url);
    out.push({ url, title: title.slice(0, 250), snippet: '', source: '贴吧手机版列表（尚未读取正文）' });
  });
  return out.slice(0, 12);
}
/**
 * 手机版帖子正文：li.j_post_list_item 内 .content 是服务端渲染的楼层正文，
 * data-info 里有楼层号和显示名；第一楼标题在 .post_title_embed。
 * 这条路径不依赖 Electron，适合没有内置浏览器组件的服务器/桌面环境。
 */
export function parseMobilePost(html, url) {
  const $ = checkPage(html);
  const title = cleanTitle(clean($('.post_title_embed').first().text()) || documentTitle($));
  const textOf = node => {
    const copy = node.clone();
    copy.find('svg,script,style,noscript').remove();
    copy.find('br').replaceWith('\n');
    return clean(copy.text());
  };
  const posts = []; let imageCount = 0; const seen = new Set();
  $('li.j_post_list_item, li.post_list_item').each((_i, el) => {
    if (seen.has(el)) return;
    seen.add(el);
    const root = $(el);
    const content = root.find('.content, .post_content, .d_post_content').first();
    if (!content.length) return;
    const imgs = content.find('img').length;
    imageCount += imgs;
    const text = textOf(content);
    if (!text) {
      if (posts.length === 0 && imgs) posts.push({ section: '楼主正文', text: '[楼主主要发布图片，此工具未识别图片内容。]' });
      return;
    }
    let info = {};
    try { info = JSON.parse(root.attr('data-info') || '{}'); } catch {}
    posts.push({
      author: clean(root.find('.user_name').first().text() || info.name_show || info.un || ''),
      floor: info.floor_num,
      section: posts.length === 0 ? '楼主正文' : '可见回复（顺序，不代表楼层号）',
      text: text.slice(0, 3000),
    });
  });
  if (!posts.length) throw new Error('手机版页面未读到帖子正文，可能已删除、需要验证或页面结构已变化。');
  return { url, title, posts: posts.slice(0, 10), imageCount, source: '贴吧正文（手机版第 1 页，最多 10 段，未展开全部楼中楼）' };
}
export function createTieba({ getCookie, searchWeb, fetchImpl = fetch, renderPage, browserAvailable = () => true, signal }) {
  const assertActive = () => signal?.throwIfAborted();
  // redirect: 'null' 时不把跳转当错误，直接返回 null —— 登录检查要靠它区分「未登录」和「读失败」。
  async function request(path, { method = 'GET', redirect = 'throw', mobile = false } = {}) {
    assertActive();
    const url = new URL(path, 'https://tieba.baidu.com');
    if (url.origin !== 'https://tieba.baidu.com') throw new Error('只允许访问百度贴吧。');
    const res = await fetchImpl(url, { method, redirect: 'manual',
      headers: { 'user-agent': mobile ? MOBILE_UA : DESKTOP_UA,
        referer: 'https://tieba.baidu.com/', cookie: cookieHeader(getCookie()) }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    if (res.status >= 300 && res.status < 400) {
      if (redirect === 'null') return null;
      throw new Error('贴吧要求跳转或登录，请先在浏览器打开贴吧并完成登录/验证。');
    }
    if (!res.ok) throw new Error(`贴吧返回 HTTP ${res.status}`);
    const chunks = []; let size = 0;
    for await (const c of res.body) { size += c.length; if (size > 2500000) throw new Error('贴吧页面过大，已停止读取。'); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }
  async function indexed(q, reason) {
    assertActive();
    const r = await searchWeb(q);
    assertActive();
    const items = []; const seen = new Set();
    for (const s of r.sources || []) {
      const url = postUrl(s.url);
      if (!url || seen.has(url)) continue;
      seen.add(url); items.push({ url, title: clean(s.title), snippet: clean(s.snippet).slice(0, 700), source: '搜索引擎收录摘要，尚未读取正文' });
    }
    return { ok: true, mode: 'indexed', warning: `${reason}；以下为搜索收录，可能不是最新帖子，也不保证严格属于目标贴吧。`, items: items.slice(0, 6) };
  }
  /**
   * 判断现在是不是登录状态。
   *
   * 以前只认 /f/user/json_userinfo：那个接口在桌面版已下线（现在无论 Cookie 有没有效都 302 跳 passport），
   * 于是 Cookie 明明有效也会被报成「登录状态检查失败」。改为按可靠性依次尝试：
   *   1. /mo/q/newmoindex?need_user=1 —— 登录时返回 name；未登录返回 { no: 1, error: 'not logined!' }，
   *      语义干净，顺带拿到昵称；
   *   2. /dc/common/tbs —— 只回 is_login，用来交叉确认；
   *   3. 旧的 json_userinfo —— 留给还有效的旧网关，302 或 null 直接跳过。
   * 三个都说不通才判「未登录」，并把每一步的原因带回去，方便主人判断是 Cookie 过期还是接口又改了。
   */
  async function loginState() {
    const notes = [];
    try {
      const raw = await request('/mo/q/newmoindex?need_user=1');
      const j = raw ? JSON.parse(raw) : null;
      const d = j?.data || {};
      if (j && Number(j.no) === 0 && d.is_login === true) {
        const name = clean(d.name_show || d.name || d.temp_name || '');
        return name
          ? { ok: true, loggedIn: true, name, message: `已登录：${name}` }
          : { ok: true, loggedIn: true, name: '', message: '已登录（这个账号没有设置昵称）。' };
      }
      notes.push('newmoindex 表示未登录');
    } catch (error) { notes.push('newmoindex 读取失败：' + error.message); }
    try {
      const raw = await request('/dc/common/tbs', { method: 'POST' });
      const j = raw ? JSON.parse(raw) : null;
      if (j && Number(j.is_login) === 1) return { ok: true, loggedIn: true, name: '', message: '已登录（接口没带昵称）。' };
    } catch (error) { notes.push('tbs 读取失败：' + error.message); }
    try {
      const raw = await request('/f/user/json_userinfo', { redirect: 'null' });
      const j = raw ? JSON.parse(raw) : null;
      const user = j?.data?.user || j?.data || j?.user || j;
      const name = user?.user_name || user?.name_show || user?.user_name_show;
      if (name) return { ok: true, loggedIn: true, name: clean(name), message: `已登录：${clean(name)}` };
    } catch (error) { notes.push('json_userinfo 读取失败：' + error.message); }
    return { ok: false, loggedIn: false, message: 'Cookie 里的 BDUSS 已失效或不被贴吧认可：请在浏览器重新登录贴吧后更新 Cookie（诊断：' + notes.join('；') + '）。' };
  }

  return {
    async home() {
      try {
        if (renderPage && browserAvailable()) {
          const page = await renderPage('https://tieba.baidu.com/', 'home');
          assertActive();
          const items = page.html ? parseHome(page.html) : (page.links || []).map(p => ({ ...p, url: postUrl(p.url), source: '贴吧首页列表（尚未读取正文）' })).filter(p => p.url && p.title).slice(0, 12);
          if (!items.length) throw new Error('贴吧首页没有可解析的帖子，可能尚未加载、需要验证或页面结构变化');
          return { ok: true, mode: 'browser', origin: 'home', items };
        }
        const items = parseHome(await request('/'));
        if (!items.length) throw new Error('贴吧首页没有可解析的帖子');
        return { ok: true, mode: 'direct', origin: 'home', items };
      } catch (error) { return { ...await indexed('site:tieba.baidu.com/p/ 热门帖子', error.message), origin: 'indexed' }; }
    },
    async account() {
      assertActive();
      if (renderPage && browserAvailable()) {
        try { return await renderPage('https://tieba.baidu.com/', 'account'); }
        catch { assertActive(); return { ok: false, loggedIn: null, message: '扩展浏览器登录检查失败，请检查组件、网络或打开扩展登录窗口完成验证。' }; }
      }
      if (!cookieHeader(getCookie()).includes('BDUSS=')) return { ok: true, loggedIn: false, message: '未配置 BDUSS 登录 Cookie，可匿名尝试读取。' };
      return loginState();
    },
    async search(query, bar = '') {
      const q = clean(query); if (!q || q.length > 160) throw new Error('搜索词应为 1～160 字符。');
      try {
        const json = JSON.parse(await request('/mo/q/search/thread?' + new URLSearchParams({ word: q, pn: 1 })));
        const results = json.data?.post_list;
        if (Array.isArray(results)) {
          const items = results.filter(p => !bar || clean(p.forum_name) === clean(bar).replace(/吧$/, '')).map(p => ({
            url: postUrl(String(p.tid)), title: clean(load(String(p.title || '')).text()),
            snippet: clean(load(String(p.content || '')).text()).slice(0, 1000),
            bar: p.forum_name, source: '贴吧搜索接口（实时结果摘要，尚未读取全文）',
          })).filter(p => p.url).slice(0, 8);
          return { ok: true, mode: 'direct', items };
        }
        const params = new URLSearchParams({ ie: 'utf-8', qw: q, ...(bar ? { kw: clean(bar) } : {}) });
        const items = parseList(await request('/f/search/res?' + params), 'search');
        if (!items.length) throw new Error('贴吧搜索页未返回可解析的帖子');
        return { ok: true, mode: 'direct', items };
      } catch (e) {
        assertActive();
        if (renderPage && browserAvailable()) {
          try {
            const page = await renderPage('https://tieba.baidu.com/f/search/res?' + new URLSearchParams({ ie: 'utf-8', qw: q, ...(bar ? { kw: clean(bar).replace(/吧$/, '') } : {}) }), 'search');
            const items = parseList(page.html, 'search');
            if (items.length) return { ok: true, mode: 'browser', items };
          } catch { assertActive(); }
        }
        return indexed(`site:tieba.baidu.com/p/ ${bar ? '"' + clean(bar) + '吧" ' : ''}${q}`, e.message);
      }
    },
    async browse(bar) {
      const name = clean(bar).replace(/吧$/, '');
      if (!name || name.length > 60) throw new Error('请填写 1～60 字的贴吧名称。');
      try {
        if (renderPage && browserAvailable()) {
          const page = await renderPage('https://tieba.baidu.com/f?' + new URLSearchParams({ kw: name, ie: 'utf-8' }), 'browse');
          assertActive();
          if (page.html) {
            const items = parseList(page.html);
            if (!items.length) throw new Error('浏览器页面没有可解析的帖子，可能是空吧、需要验证或页面结构变化。');
            return { ok: true, mode: 'browser', bar: name, items };
          }
          const seen = new Set();
          const items = (page.links || []).map(p => ({ ...p, url: postUrl(p.url), source: '贴吧浏览器实际加载的列表' }))
            .filter(p => p.url && p.title && !seen.has(p.url) && seen.add(p.url)).slice(0, 8);
          if (!items.length) throw new Error('浏览器未加载出帖子列表，可能需要登录或安全验证');
          return { ok: true, mode: 'browser', bar: name, items };
        }
        const items = parseList(await request('/f?' + new URLSearchParams({ kw: name, ie: 'utf-8' })));
        if (!items.length) throw new Error('贴吧列表未返回可解析的帖子');
        return { ok: true, mode: 'direct', bar: name, items };
      } catch (e) {
        // 桌面直读常常只拿到 SPA 空壳：改走仍需服务端渲染的手机版列表。
        try {
          const items = parseMobileList(await request('/mo/q/threadlist?' + new URLSearchParams({ kw: name, pn: '1' }), { mobile: true }));
          if (items.length) return { ok: true, mode: 'mobile', bar: name, items };
        } catch (mobileError) { assertActive(); }
        return { ...await indexed(`site:tieba.baidu.com/p/ "${name}吧"`, e.message), bar: name };
      }
    },
    async read(link) {
      const url = postUrl(link); if (!url) throw new Error('请输入 https://tieba.baidu.com/p/帖子编号，只允许读取贴吧帖子。');
      let browserError = '';
      try {
        if (renderPage && browserAvailable()) {
          const page = await renderPage(url, 'read');
          assertActive();
          if (page.html) return { ok: true, mode: 'browser', ...parsePost(page.html, url) };
          const posts = (page.contents || []).map((text,i) => ({ section: page.hasOpening && i === 0 ? '楼主正文' : '可见回复（顺序，不代表楼层号）', text: clean(text).slice(0,3000) })).filter(p => p.text);
          if (!posts.length) throw new Error('浏览器未读到帖子正文，可能已删除或需要验证');
          return { ok: true, mode: 'browser', url, title: cleanTitle(page.title), posts, imageCount: page.imageCount || 0,
            source: '贴吧正文（浏览器实际加载内容，最多10段，未展开全部楼中楼）' };
        }
        return { ok: true, ...parsePost(await request(url), url) };
      } catch (e) {
        browserError = e.message;
        assertActive();
      }
      // 没有内置浏览器 / 桌面页只有 SPA 空壳时，手机版帖子页仍是服务端渲染的正文。
      try {
        const tid = new URL(url).pathname.split('/').pop();
        return { ok: true, mode: 'mobile', ...parseMobilePost(await request('/mo/q/thread_page?' + new URLSearchParams({ kz: tid, pn: '1' }), { mobile: true }), url) };
      } catch (e) {
        assertActive();
        return { ok: false, url, message: browserError + (browserError ? '；' : '') + '手机版：' + e.message + '。未读取到正文，不能声称已看帖。' };
      }
    },
  };
}
