export function renderManagerPage(config = {}) {
  const teamsPath = escapeHtml(config.teamsPath || 'teams')
  const publicHost = escapeHtml(config.publicHost || 'localhost')
  const controllerPath = JSON.stringify(config.controllerPath || 'dsh')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>DS Headbot · 团队管理</title>
  <style>
    :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;color:#182235}
    *{box-sizing:border-box}body{margin:0;padding:32px 18px}main{max-width:1080px;margin:auto}
    header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px}
    h1{margin:0 0 8px;font-size:26px}p{margin:0;color:#667085;line-height:1.6}.host{font-size:13px;white-space:nowrap}
    section,.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;box-shadow:0 4px 18px #192c4810}
    .card{padding:20px;margin-bottom:18px}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
    h2{font-size:17px;margin:0}form{display:grid;grid-template-columns:1.1fr 1.3fr .8fr auto;gap:10px;align-items:end}
    label{display:grid;gap:6px;font-size:13px;color:#526072}input{width:100%;min-width:0;padding:10px 11px;border:1px solid #cfd7e4;border-radius:8px;font:inherit;background:#fff;color:#182235}
    button,.link{border:0;border-radius:8px;padding:9px 12px;background:#1f5fbd;color:#fff;font:inherit;font-size:13px;cursor:pointer;text-decoration:none;white-space:nowrap}
    button.secondary{background:#e8eef7;color:#1c3558}button.danger{background:#fff0f0;color:#a82d2d}button:disabled{opacity:.5;cursor:wait}
    table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:12px 9px;border-top:1px solid #edf0f5;vertical-align:middle}th{color:#667085;font-size:12px;font-weight:600}
    td.actions{display:flex;flex-wrap:wrap;gap:6px}.status{display:inline-flex;border-radius:99px;padding:4px 9px;background:#edf0f5;color:#526072;font-size:12px}
    .status.running{background:#e3f6ec;color:#17683d}.status.failed{background:#fff0f0;color:#a82d2d}.status.provisioning,.status.starting,.status.updating{background:#fff5dd;color:#8a5a00}
    .small{font-size:12px;color:#758095;overflow-wrap:anywhere}.error{color:#a82d2d;white-space:pre-wrap;margin:10px 0}.empty{text-align:center;padding:28px;color:#758095}
    .notice{background:#eef5ff;border:1px solid #d7e6ff;border-radius:9px;padding:12px 14px;color:#38577d;font-size:13px;line-height:1.55;margin-bottom:18px}
    details{max-width:620px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;max-height:360px;overflow:auto}.audit-filters{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.audit-filters input{max-width:260px}.audit-files{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
    @media(max-width:760px){body{padding:18px 10px}header{display:block}.host{margin-top:8px}form{grid-template-columns:1fr 1fr}.toolbar{align-items:flex-start}table,tbody,tr,td{display:block}thead{display:none}tr{border-top:1px solid #edf0f5;padding:8px 0}td{border:0;padding:5px 8px}td:first-child{font-weight:600}.actions{padding-top:9px!important}}
    @media(prefers-color-scheme:dark){:root{background:#10151d;color:#edf2fa}.card,section{background:#171f2a;border-color:#2a3545}p,label,.small,th{color:#aab5c5}input{background:#10151d;border-color:#3a4658;color:#edf2fa}.notice{background:#17283c;border-color:#284364;color:#c2d9f8}.status{background:#2a3545;color:#d2d9e4}.status.running{background:#183c2c;color:#a5e3be}.status.failed{background:#462525;color:#ffb5b5}.status.provisioning,.status.starting,.status.updating{background:#463719;color:#ffdc8a}button.secondary{background:#28384c;color:#dceaff}button.danger{background:#422626;color:#ffc1c1}td,th{border-color:#2a3545}}
  </style>
</head>
<body>
<main>
  <header><div><h1>DS Headbot 团队管理</h1><p>每个团队使用独立的 DSH 数据目录、DS Bot 状态和服务端口。</p></div><div class="host">入口：<strong>https://${publicHost}</strong></div></header>
  <div class="notice">管理接口要求当前 DSH 浏览器会话。首次访问时，请先用 DSH 启动日志打印的登录链接完成一次登录，再打开此管理页。</div>
  <section class="card">
    <div class="toolbar"><h2>添加团队副本</h2><a class="link" id="caddy-link">下载 Caddy 配置</a></div>
    <form id="add-form">
      <label>团队标识<input name="id" required pattern="[a-z0-9][a-z0-9-]{0,47}" placeholder="research" maxlength="48"></label>
      <label>团队名称<input name="name" required maxlength="80" placeholder="研究团队"></label>
      <label>独立服务端口<input name="port" type="number" min="1024" max="65535" required value="3101"></label>
      <button type="submit">创建并启动</button>
    </form>
    <div id="error" class="error" role="status"></div>
  </section>
  <section class="card">
    <div class="toolbar"><h2>团队实例</h2><button id="refresh" class="secondary" type="button">刷新</button></div>
    <table><thead><tr><th>团队</th><th>状态</th><th>端口</th><th>团队入口</th><th>管理</th></tr></thead><tbody id="teams"><tr><td colspan="5" class="empty">正在读取团队列表…</td></tr></tbody></table>
  </section>
  <section class="card">
    <div class="toolbar"><h2>团队通信审计</h2><a class="link" id="audit-export">导出完整审计档案</a></div>
    <p class="small">消息正文和附件副本长期留档。发送、读取与附件下载均记录在审计链中。</p>
    <div class="audit-filters"><input id="audit-team" placeholder="按团队标识筛选"><button id="audit-refresh" type="button" class="secondary">查询最新记录</button><button id="audit-older" type="button" class="secondary">查看更早记录</button></div>
    <div id="audit-status" class="small" role="status"></div>
    <table><thead><tr><th>时间 / 序号</th><th>操作</th><th>团队</th><th>内容与资料</th></tr></thead><tbody id="audit-events"></tbody></table>
  </section>
  <p class="small">团队网址采用 <code>/${teamsPath}/{团队标识}/</code>；HTTP 80 会跳转到 HTTPS 443。团队数据保存在 DSH 用户目录的 Headbot 子目录，不会写入工作项目。</p>
</main>
<script>
(() => {
  const api = '/' + ${controllerPath} + '/api/ds-headbot/v1';
  const rows = document.querySelector('#teams');
  const errorBox = document.querySelector('#error');
  const caddy = document.querySelector('#caddy-link');
  caddy.href = api + '/config/caddy';
  document.querySelector('#audit-export').href = api + '/audit/export';
  const labels = {running:'运行中',starting:'启动中',provisioning:'安装 DS Bot',updating:'更新 DS Bot',stopping:'停止中',deleting:'删除中',failed:'失败',stopped:'已停止'};
  async function call(path, options={}) {
    const response = await fetch(api + path, {credentials:'same-origin', ...options, headers:{'Content-Type':'application/json', ...(options.headers||{})}});
    if (response.status === 401) throw new Error('当前浏览器尚未登录主 DSH。请用主 DSH 启动日志中的 token 链接完成一次登录，然后刷新本页。');
    if (response.status === 403) throw new Error('请求被 DSH Host/Origin 安全检查拒绝；检查 publicHost、trusted-host 和代理是否保留 Host。');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  }
  function button(text, action, id, style='secondary') {
    const el = document.createElement('button'); el.type='button'; el.className=style; el.textContent=text;
    el.addEventListener('click', async () => { el.disabled=true; errorBox.textContent=''; try { await call('/teams/'+encodeURIComponent(id)+'/'+action,{method:'POST',body:'{}'}); await load(); } catch(e) { errorBox.textContent=e.message; } finally { el.disabled=false; } });
    return el;
  }
  function render(teamList) {
    rows.replaceChildren();
    if (!teamList.length) { const tr=document.createElement('tr'), td=document.createElement('td'); td.colSpan=5;td.className='empty';td.textContent='还没有团队副本。请添加第一个团队。';tr.append(td);rows.append(tr);return; }
    for (const team of teamList) {
      const tr=document.createElement('tr');
      const who=document.createElement('td'); who.textContent=team.name+' ('+team.id+')';
      const state=document.createElement('td'); const badge=document.createElement('span'); badge.className='status '+team.status; badge.textContent=labels[team.status]||team.status; state.append(badge);
      if (team.message) { const detail=document.createElement('div');detail.className='small';detail.textContent=team.message;state.append(detail); }
      const port=document.createElement('td');port.textContent=String(team.port);
      const entry=document.createElement('td'); const link=document.createElement('a');link.className='link';link.textContent='打开';link.href=team.launchUrl||team.url;link.target='_blank';link.rel='noopener noreferrer';entry.append(link);
      const actions=document.createElement('td');actions.className='actions';
      if (team.status==='running'||team.status==='starting'||team.status==='provisioning') actions.append(button('停止','stop',team.id,'danger'));
      else actions.append(button('启动','start',team.id));
      actions.append(button('重启','restart',team.id));
      actions.append(button('更新 DS Bot','update-bot',team.id));
      const remove=document.createElement('button');remove.type='button';remove.className='danger';remove.textContent='删除实例';
      remove.disabled=['updating','stopping','deleting'].includes(team.status);
      remove.addEventListener('click',async()=>{if(!confirm('停止并删除团队 '+team.name+'？实例数据将归档保留，通信身份会撤销；同名新团队不会继承旧收件箱。'))return;remove.disabled=true;try{await call('/teams/'+encodeURIComponent(team.id),{method:'DELETE'});await load();}catch(e){errorBox.textContent=e.message;remove.disabled=false;}});actions.append(remove);
      if (['updating','stopping','deleting'].includes(team.status)) for (const control of actions.querySelectorAll('button')) control.disabled=true;
      const auto=document.createElement('label');auto.style.display='inline-flex';auto.style.alignItems='center';auto.style.gap='5px';auto.style.padding='7px';auto.textContent='开机启动';
      const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=team.autoStart;checkbox.style.width='auto';
      checkbox.addEventListener('change',async()=>{try{await call('/teams/'+encodeURIComponent(team.id),{method:'PATCH',body:JSON.stringify({autoStart:checkbox.checked})});}catch(e){errorBox.textContent=e.message;checkbox.checked=!checkbox.checked;}});auto.append(checkbox);actions.append(auto);
      tr.append(who,state,port,entry,actions);rows.append(tr);
    }
  }
  async function load() { try { const result=await call('/teams'); render(result.teams||[]); errorBox.textContent=''; } catch(e) { errorBox.textContent=e.message; } }
  document.querySelector('#add-form').addEventListener('submit',async event=>{
    event.preventDefault(); errorBox.textContent='';
    const form=new FormData(event.currentTarget);
    const body={id:String(form.get('id')).trim(),name:String(form.get('name')).trim(),port:Number(form.get('port')),autoStart:true};
    try { await call('/teams',{method:'POST',body:JSON.stringify(body)}); event.currentTarget.reset(); event.currentTarget.elements.port.value='3101'; await load(); }
    catch(e) { errorBox.textContent=e.message; }
  });
  document.querySelector('#refresh').addEventListener('click',load);
  const auditRows=document.querySelector('#audit-events'),auditStatus=document.querySelector('#audit-status');
  let auditBefore=null,nextBefore=null;
  const auditLabels={'message.sent':'发送消息','messages.received':'读取收件箱','attachment.received':'接收附件','attachment.reviewed':'审查附件'};
  async function loadAudit(before=null){
    try{
      const filter=document.querySelector('#audit-team').value.trim();
      const result=await call('/audit?limit=50&team='+encodeURIComponent(filter)+(before?'&before='+before:''));
      auditBefore=before;nextBefore=result.nextBefore;auditRows.replaceChildren();
      auditStatus.textContent='审计链校验通过 · 本页 '+result.events.length+' 条记录';
      for(const event of result.events){
        const tr=document.createElement('tr');
        const when=document.createElement('td');when.textContent=new Date(event.timestamp).toLocaleString()+' / #'+event.seq;
        const kind=document.createElement('td');kind.textContent=auditLabels[event.type]||event.type;
        const teams=document.createElement('td');teams.textContent=event.from?event.from.id+' → '+event.to.id:(event.actor?.id||'');
        const content=document.createElement('td'),details=document.createElement('details'),summary=document.createElement('summary');
        summary.textContent=event.subject||event.messageId||('涉及 '+(event.messageIds?.length||0)+' 条消息');details.append(summary);
        const text=document.createElement('pre');text.textContent=event.text||JSON.stringify(event.messageIds||event.attachment||{},null,2);details.append(text);
        const files=document.createElement('div');files.className='audit-files';
        for(const file of event.attachments||[]){const link=document.createElement('a');link.href=api+'/audit/messages/'+event.messageId+'/attachments/'+file.id;link.textContent=file.name+' ('+file.size+' 字节)';files.append(link);const hash=document.createElement('div');hash.className='small';hash.textContent='SHA-256: '+file.sha256;files.append(hash);}
        details.append(files);content.append(details);tr.append(when,kind,teams,content);auditRows.append(tr);
      }
      document.querySelector('#audit-older').disabled=!nextBefore||result.events.length<50;
    }catch(e){auditStatus.textContent='审计读取失败：'+e.message;}
  }
  document.querySelector('#audit-refresh').addEventListener('click',()=>loadAudit());
  document.querySelector('#audit-older').addEventListener('click',()=>{if(nextBefore)loadAudit(nextBefore);});
  load();loadAudit();setInterval(()=>{load();if(auditBefore===null&&!auditRows.querySelector('details[open]'))loadAudit();},4000);
})();
</script>
</body>
</html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}
