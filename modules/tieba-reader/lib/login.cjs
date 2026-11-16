// 登录窗口里执行的账号探测：与 lib/tieba.mjs 的 loginState() 同一套判定。
// /f/user/json_userinfo 在新版贴吧已下线（302 跳 passport），只认它会让登录窗口永远不自动关闭。
const LOGIN_PROBE = `(async () => {
  if (/安全验证|访问验证|验证码/.test(document.title) || document.querySelector('#captcha,#vcode,#wappassverify')) return { loggedIn: null };
  const probe = async (path, init) => {
    try { const r = await fetch(path, Object.assign({ credentials: 'include', cache: 'no-store' }, init || {})); return r.ok ? await r.json() : null; } catch { return null; }
  };
  const j1 = await probe('/mo/q/newmoindex?need_user=1');
  const d = (j1 && j1.data) || {};
  if (j1 && Number(j1.no) === 0 && d.is_login === true) {
    const name = String(d.name_show || d.name || d.temp_name || '').slice(0, 100);
    return name ? { loggedIn: true, name } : { loggedIn: true, name: '' };
  }
  const j2 = await probe('/dc/common/tbs', { method: 'POST' });
  if (j2 && Number(j2.is_login) === 1) return { loggedIn: true, name: '' };
  const j3 = await probe('/f/user/json_userinfo');
  const u = (j3 && (j3.data?.user || j3.data || j3.user || j3)) || {};
  const name3 = u.user_name || u.name_show || u.user_name_show;
  return name3 ? { loggedIn: true, name: String(name3).slice(0, 100) } : { loggedIn: false };
})()`;

// 确认账号登录后才关闭；跳转或保存 Cookie 本身不足以证明登录成功。
async function waitForLogin({ probe, save, close, closed, pause = () => new Promise(resolve => setTimeout(resolve, 2000)) }) {
  let ended = false;
  const end = closed.then(() => { ended = true; return null; });
  while (!ended) {
    const account = await Promise.race([Promise.resolve().then(probe).catch(() => null), end]);
    if (account?.loggedIn === true && typeof account.name === 'string' && account.name.trim()) {
      await save();
      const autoClosed = !ended;
      if (autoClosed) close();
      return { loggedIn: true, name: account.name.trim().slice(0, 100), autoClosed, message: '已确认登录，会话已保存。' };
    }
    if (!ended) await Promise.race([pause(), end]);
  }
  await save();
  return { loggedIn: null, autoClosed: false, message: '登录窗口已手动关闭，会话已保存；尚未确认登录，可点击检查登录。' };
}
module.exports = { waitForLogin, LOGIN_PROBE };
