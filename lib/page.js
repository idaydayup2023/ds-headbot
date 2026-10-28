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
    *{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding:32px 18px}main{max-width:1080px;margin:auto}
    header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px}
    h1{margin:0 0 8px;font-size:26px}p{margin:0;color:#667085;line-height:1.6}.host{font-size:13px;white-space:nowrap}
    section,.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;box-shadow:0 4px 18px #192c4810}
    .card{padding:20px;margin-bottom:18px}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
    .version-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:18px}.version-card{min-width:0;padding:16px;margin:0}.version-card .toolbar{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:12px;margin:0}.version-card .actions{justify-content:flex-start}.version-values{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:5px}.version-values span{white-space:nowrap}
    .model-form{display:grid;grid-template-columns:minmax(130px,.8fr) minmax(130px,.8fr) minmax(220px,1.5fr) minmax(180px,1.2fr) minmax(190px,1.2fr) auto;gap:10px;align-items:end;margin:14px 0}.model-table{table-layout:fixed}.model-table col:nth-child(1){width:17%}.model-table col:nth-child(2){width:22%}.model-table col:nth-child(3){width:34%}.model-table col:nth-child(4){width:12%}.model-table col:nth-child(5){width:15%}.model-url{overflow-wrap:anywhere}.model-row-actions{display:flex;gap:6px;flex-wrap:wrap}.model-api-key{white-space:nowrap}
    #clear-model-key-label{display:flex;grid-template-columns:none;align-items:center;gap:6px;margin-top:6px}#clear-model-key-label input{width:auto;padding:0}
    h2{font-size:17px;margin:0}form{display:grid;grid-template-columns:1.1fr 1.3fr .8fr auto;gap:10px;align-items:end}
    label{display:grid;gap:6px;font-size:13px;color:#526072}input{width:100%;min-width:0;padding:10px 11px;border:1px solid #cfd7e4;border-radius:8px;font:inherit;background:#fff;color:#182235}
    button,.link{border:0;border-radius:8px;padding:9px 12px;background:#1f5fbd;color:#fff;font:inherit;font-size:13px;cursor:pointer;text-decoration:none;white-space:nowrap}
    button.secondary{background:#e8eef7;color:#1c3558}button.danger{background:#fff0f0;color:#a82d2d}button:disabled{opacity:.5;cursor:wait}
    button.update-ready{background:#d56a12;color:#fff;box-shadow:0 0 0 3px #f5d7bd;font-weight:650}
    table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:12px 9px;border-top:1px solid #edf0f5;vertical-align:middle}th{color:#667085;font-size:12px;font-weight:600}
    .team-table{table-layout:fixed}.team-table col:nth-child(1){width:23%}.team-table col:nth-child(2){width:14%}.team-table col:nth-child(3){width:8%}.team-table col:nth-child(4){width:10%}.team-table col:nth-child(5){width:45%}
    .team-name-line{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}.team-name{overflow-wrap:anywhere}.team-id{margin-top:3px}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.status{display:inline-flex;border-radius:99px;padding:4px 9px;background:#edf0f5;color:#526072;font-size:12px}
    .feishu-status{display:inline-flex;max-width:100%;margin-top:7px;margin-right:6px;padding:3px 8px;border-radius:99px;background:#eef2f7;color:#526072;font-size:12px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.feishu-status.connected{background:#e3f6ec;color:#17683d}.feishu-status.retrying{background:#fff5dd;color:#8a5a00}.feishu-status.failed{background:#fff0f0;color:#a82d2d}
    .status.running{background:#e3f6ec;color:#17683d}.status.failed{background:#fff0f0;color:#a82d2d}.status.provisioning,.status.starting,.status.updating,.status.restarting{background:#fff5dd;color:#8a5a00}
    .small{font-size:12px;color:#758095;overflow-wrap:anywhere}.error{color:#a82d2d;white-space:pre-wrap;margin:10px 0}.empty{text-align:center;padding:28px;color:#758095}.edit-field,.edit-port{width:100%;max-width:none}.protected-tag{display:inline-block;margin-left:6px;border-radius:99px;background:#e8eef7;color:#1c3558;padding:2px 7px;font-size:11px;vertical-align:middle}
    .team-editor-cell{padding:14px 10px!important;font-weight:400}.team-editor{display:grid;gap:16px;width:100%;padding:18px;border:1px solid #dfe6f0;border-radius:12px;background:#f8fafc}.editor-primary{display:grid;grid-template-columns:minmax(260px,2fr) minmax(170px,1fr);gap:18px;align-items:end;max-width:720px}.editor-primary.protected{grid-template-columns:minmax(260px,1fr);max-width:460px}.editor-meta{font-size:12px;color:#758095}.feishu-edit{display:grid;gap:10px;width:100%}.feishu-edit h3{font-size:13px;margin:0;color:#526072}.feishu-fields{display:grid;grid-template-columns:minmax(190px,1fr) repeat(3,minmax(180px,1.1fr));gap:12px;align-items:end}.feishu-edit label{font-size:12px}.feishu-edit input,.feishu-edit select{font-size:13px;padding:9px}.feishu-edit .check{display:flex;align-items:center;gap:8px;min-height:38px}.feishu-edit .check input{width:auto;flex:none}.feishu-edit .small{font-weight:400}.feishu-state{min-width:0;margin:0;padding:7px 10px 9px;border:1px solid #cfd7e4;border-radius:9px}.feishu-state legend{padding:0 4px;font-size:12px;color:#526072}.feishu-state-options{display:flex;gap:12px;align-items:center;min-height:24px}.feishu-radio{display:inline-flex!important;grid-template-columns:none!important;align-items:center;gap:6px!important;white-space:nowrap}.feishu-radio input{width:auto;flex:none;margin:0}.feishu-secret-action{display:flex!important;justify-content:flex-start;align-items:center;gap:8px}.feishu-edit .check input{width:auto;flex:none}.feishu-edit .small{font-weight:400}.team-editor .editor-note{line-height:1.5}.editor-actions{display:flex;justify-content:flex-end;gap:8px}
    .notice{background:#eef5ff;border:1px solid #d7e6ff;border-radius:9px;padding:12px 14px;color:#38577d;font-size:13px;line-height:1.55;margin-bottom:18px}
    details{max-width:620px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;max-height:360px;overflow:auto}.audit-filters{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.audit-filters input{max-width:260px}.audit-files{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
    @media(max-width:1000px){.feishu-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.version-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.model-form{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(max-width:760px){body{padding:18px 10px}header{display:block}.host{margin-top:8px}form{grid-template-columns:1fr 1fr}.model-form{grid-template-columns:1fr}.toolbar{align-items:flex-start}.version-cards{grid-template-columns:1fr}table,tbody,tr,td{display:block}.team-table colgroup,.model-table colgroup{display:none}thead{display:none}tr{border-top:1px solid #edf0f5;padding:8px 0}td{border:0;padding:5px 8px}td:first-child{font-weight:600}.actions{padding-top:9px!important}.version-card .actions{padding-top:0!important}.team-editor-cell{width:100%;padding:8px!important;font-weight:400}.team-editor{padding:14px}.editor-primary,.editor-primary.protected,.feishu-fields{grid-template-columns:1fr;max-width:none}.feishu-edit .check{min-height:0}.editor-actions{justify-content:flex-start}}
    @media(prefers-color-scheme:dark){:root{background:#10151d;color:#edf2fa}.card,section{background:#171f2a;border-color:#2a3545}p,label,.small,th{color:#aab5c5}input{background:#10151d;border-color:#3a4658;color:#edf2fa}.notice{background:#17283c;border-color:#284364;color:#c2d9f8}.status{background:#2a3545;color:#d2d9e4}.status.running{background:#183c2c;color:#a5e3be}.status.failed{background:#462525;color:#ffb5b5}.status.provisioning,.status.starting,.status.updating,.status.restarting{background:#463719;color:#ffdc8a}.team-editor{background:#111923;border-color:#2a3545}.feishu-status{background:#2a3545;color:#d2d9e4}.feishu-status.connected{background:#183c2c;color:#a5e3be}.feishu-status.retrying{background:#463719;color:#ffdc8a}.feishu-status.failed{background:#462525;color:#ffb5b5}.protected-tag{background:#28384c;color:#dceaff}button.secondary{background:#28384c;color:#dceaff}button.danger{background:#422626;color:#ffc1c1}button.update-ready{background:#b85b0d;box-shadow:0 0 0 3px #603718}td,th{border-color:#2a3545}}
  </style>
</head>
<body>
<main>
  <header><div><h1>DS Headbot 团队管理</h1></div><div class="host">入口：<strong id="public-entry">http://${publicHost}</strong></div></header>
  <div class="notice">管理接口要求当前 DSH 浏览器会话。首次访问时，请先用 DSH 启动日志打印的登录链接完成一次登录，再打开此管理页。</div>
  <div class="version-cards">
    <section class="card version-card" id="headbot-version-card">
      <div class="toolbar"><div><h2>DS HeadBot</h2><p class="small version-values"><span id="current-version">当前版本：v${escapeHtml(config.version || 'unknown')}</span><span id="latest-version">最新版本：正在检查…</span></p></div><div class="actions"><a class="link" id="release-link" target="_blank" rel="noopener noreferrer" hidden>发布说明</a><button id="check-update" class="secondary" type="button">检查更新</button><button id="upgrade-headbot" type="button" disabled>检查中…</button></div></div>
      <p id="release-status" class="small" role="status"></p>
    </section>
    <section class="card version-card" id="dsbot-version-card">
      <div class="toolbar"><div><h2>DS Bot</h2><p class="small version-values"><span id="current-dsbot-version">当前版本：检查中…</span><span id="latest-dsbot-version">最新版本：检查中…</span></p></div><div class="actions"><button id="check-dsbot-version" class="secondary" type="button">检查更新</button><button id="update-all" type="button" disabled>检查中…</button></div></div>
      <p id="dsbot-version-status" class="small" role="status"></p>
    </section>
    <section class="card version-card" id="dsh-version-card">
      <div class="toolbar"><div><h2>DeepSeek Harness (DSH)</h2><p class="small version-values"><span id="current-dsh-version">当前版本：检查中…</span><span id="latest-dsh-version">最新版本：检查中…</span></p></div><div class="actions"><a class="link" id="dsh-release-link" target="_blank" rel="noopener noreferrer" hidden>发布说明</a><button id="check-dsh-version" class="secondary" type="button">检查更新</button><button id="upgrade-dsh" type="button" disabled>检查中…</button></div></div>
      <p id="dsh-version-status" class="small" role="status"></p>
    </section>
  </div>
  <section class="card" id="model-catalog-card">
    <div class="toolbar"><div><h2>模型目录</h2><p class="small">配置 OpenAI 兼容接口；实例切换模型后，实例内所有 Bot 会更新并重启生效。</p></div><button id="add-model" type="button">添加模型</button></div>
    <form id="model-form" class="model-form" hidden>
      <label>接口标识（DSH Provider ID）<input name="id" required pattern="[a-z0-9][a-z0-9-]{0,47}" maxlength="48" placeholder="openrouter-qwen"></label>
      <label>显示名称<input name="name" required maxlength="80" placeholder="OpenRouter Qwen"></label>
      <label>接口 URL<input name="baseURL" type="url" required placeholder="https://openrouter.ai/api/v1"></label>
      <label>模型 ID<input name="modelId" required maxlength="200" placeholder="provider/model-id"></label>
      <label>API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="没有密钥的本地服务可留空"><span id="clear-model-key-label" class="small" hidden><input name="clearApiKey" type="checkbox"> 清除已保存的 API Key</span></label>
      <div class="actions"><button id="save-model" type="submit">保存模型</button><button id="cancel-model" class="secondary" type="button">取消</button></div>
    </form>
    <p id="model-status" class="small" role="status"></p>
    <table class="model-table"><colgroup><col><col><col><col><col></colgroup><thead><tr><th>模型</th><th>模型 ID</th><th>接口 URL</th><th>API Key</th><th>管理</th></tr></thead><tbody id="model-list"><tr><td colspan="5" class="empty">正在读取模型列表…</td></tr></tbody></table>
  </section>
  <div id="error" class="error" role="status"></div>
  <section class="card">
    <div class="toolbar"><h2>团队实例</h2><div class="actions"><button id="refresh" class="secondary" type="button">刷新</button><button id="toggle-add-form" type="button" aria-expanded="false">创建团队</button></div></div>
    <form id="add-form" hidden>
      <label>团队标识<input name="id" required pattern="[a-z0-9][a-z0-9-]{0,47}" placeholder="research" maxlength="48"></label>
      <label>团队名称<input name="name" required maxlength="80" placeholder="研究团队"></label>
      <label>独立服务端口<input name="port" type="number" min="1024" max="65535" required value="3101"></label>
      <div class="actions"><button type="submit">创建并启动</button><button id="cancel-add" class="secondary" type="button">取消</button></div>
    </form>
    <table class="team-table"><colgroup><col><col><col><col><col></colgroup><thead><tr><th>团队</th><th>状态</th><th>端口</th><th>团队入口</th><th>管理</th></tr></thead><tbody id="teams"><tr><td colspan="5" class="empty">正在读取团队列表…</td></tr></tbody></table>
  </section>
  <section class="card">
    <div class="toolbar"><h2>团队通信审计</h2><a class="link" id="audit-export">导出完整审计档案</a></div>
    <p class="small">消息正文和附件副本长期留档。发送、读取与附件下载均记录在审计链中。</p>
    <div class="audit-filters"><input id="audit-team" placeholder="按团队标识筛选"><button id="audit-refresh" type="button" class="secondary">查询最新记录</button></div>
    <div id="audit-status" class="small" role="status"></div>
    <table><thead><tr><th>时间 / 序号</th><th>操作</th><th>团队</th><th>内容与资料</th></tr></thead><tbody id="audit-events"></tbody></table>
    <div class="audit-filters" aria-label="审计分页"><button id="audit-previous" type="button" class="secondary">上一页</button><span id="audit-page" class="small" aria-live="polite">第 1 页</span><button id="audit-next" type="button" class="secondary">下一页</button></div>
  </section>
  <p class="small">团队网址采用 <code>/${teamsPath}/{团队标识}/</code>；HTTP 80 会跳转到 HTTPS 443。团队数据保存在 DSH 用户目录的 Headbot 子目录，不会写入工作项目。</p>
</main>
<script>
(() => {
  const api = '/' + ${controllerPath} + '/api/ds-headbot/v1';
  document.querySelector('#public-entry').textContent = window.location.origin;
  const rows = document.querySelector('#teams');
  const errorBox = document.querySelector('#error');
  const currentVersion = document.querySelector('#current-version');
  const latestVersion = document.querySelector('#latest-version');
  const releaseStatus = document.querySelector('#release-status');
  const releaseLink = document.querySelector('#release-link');
  const checkUpdate = document.querySelector('#check-update');
  const upgradeHeadbot = document.querySelector('#upgrade-headbot');
  const currentDshVersion = document.querySelector('#current-dsh-version');
  const latestDshVersion = document.querySelector('#latest-dsh-version');
  const dshVersionStatus = document.querySelector('#dsh-version-status');
  const dshReleaseLink = document.querySelector('#dsh-release-link');
  const checkDshVersion = document.querySelector('#check-dsh-version');
  const upgradeDsh = document.querySelector('#upgrade-dsh');
  const latestDsBotVersion = document.querySelector('#latest-dsbot-version');
  const currentDsBotVersion = document.querySelector('#current-dsbot-version');
  const dsBotVersionStatus = document.querySelector('#dsbot-version-status');
  const checkDsBotVersion = document.querySelector('#check-dsbot-version');
  const updateAllDsBot = document.querySelector('#update-all');
  const modelRows = document.querySelector('#model-list');
  const modelForm = document.querySelector('#model-form');
  const modelStatus = document.querySelector('#model-status');
  let models=[];
  let editingModelId=null;
  let dshUpgradePending=false;
  let runtimeVersionPoll=null;
  document.querySelector('#audit-export').href = api + '/audit/export';
  const labels = {running:'运行中',starting:'启动中',provisioning:'安装 DS Bot',updating:'更新 DS Bot',restarting:'重启中',stopping:'停止中',deleting:'删除中',failed:'失败',stopped:'已停止'};
  let editDraft = null;
  async function call(path, options={}) {
    const response = await fetch(api + path, {credentials:'same-origin', ...options, headers:{'Content-Type':'application/json', ...(options.headers||{})}});
    if (response.status === 401) throw new Error('当前浏览器尚未登录主 DSH。请用主 DSH 启动日志中的 token 链接完成一次登录，然后刷新本页。');
    if (response.status === 403) throw new Error('请求被 DSH Host/Origin 安全检查拒绝；检查 publicHost、trusted-host 和代理是否保留 Host。');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  }
  function renderModels() {
    modelRows.replaceChildren();
    if(!models.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.className='empty';td.textContent='尚未配置模型。';tr.append(td);modelRows.append(tr);return;}
    for(const model of models){
      const tr=document.createElement('tr');
      const name=document.createElement('td');name.textContent=model.name+' · '+model.id;
      const ref=document.createElement('td');ref.textContent=model.modelId;
      const endpoint=document.createElement('td');endpoint.className='model-url';endpoint.textContent=model.baseURL;endpoint.title=model.baseURL;
      const key=document.createElement('td');key.className='model-api-key';key.textContent=model.hasApiKey?'已保存':'未设置';
      const actionsCell=document.createElement('td'),actions=document.createElement('div');actions.className='model-row-actions';
      const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='编辑';edit.addEventListener('click',()=>openModelForm(model));actions.append(edit);
      const remove=document.createElement('button');remove.type='button';remove.className='danger';remove.textContent='删除';remove.addEventListener('click',async()=>{
        if(!confirm('删除模型 '+model.name+'？仍被实例使用的模型不能删除。'))return;
        remove.disabled=true;modelStatus.textContent='正在删除模型…';
        try{await call('/models/'+encodeURIComponent(model.id),{method:'DELETE'});modelStatus.textContent='';await loadModels();await load();}
        catch(e){modelStatus.textContent=e.message;remove.disabled=false;}
      });actions.append(remove);actionsCell.append(actions);
      tr.append(name,ref,endpoint,key,actionsCell);modelRows.append(tr);
    }
  }
  async function loadModels() {
    try{const result=await call('/models');models=result.models||[];renderModels();}
    catch(e){models=[];renderModels();modelStatus.textContent='模型目录读取失败：'+e.message;}
  }
  function openModelForm(model=null) {
    editingModelId=model?.id||null;
    modelForm.reset();
    modelForm.elements.id.value=model?.id||'';
    modelForm.elements.id.disabled=Boolean(model);
    modelForm.elements.name.value=model?.name||'';
    modelForm.elements.baseURL.value=model?.baseURL||'';
    modelForm.elements.modelId.value=model?.modelId||'';
    modelForm.elements.apiKey.value='';
    modelForm.elements.apiKey.placeholder=model?.hasApiKey?'已安全保存；留空保持不变':'没有密钥的本地服务可留空';
    modelForm.elements.clearApiKey.checked=false;
    modelForm.elements.apiKey.oninput=()=>{if(modelForm.elements.apiKey.value)modelForm.elements.clearApiKey.checked=false;};
    document.querySelector('#clear-model-key-label').hidden=!model?.hasApiKey;
    document.querySelector('#save-model').textContent=model?'保存修改':'添加模型';
    modelStatus.textContent='';modelForm.hidden=false;
    modelForm.elements.name.focus();
  }
  document.querySelector('#add-model').addEventListener('click',()=>openModelForm());
  document.querySelector('#cancel-model').addEventListener('click',()=>{modelForm.reset();modelForm.hidden=true;editingModelId=null;});
  modelForm.addEventListener('submit',async event=>{
    event.preventDefault();modelStatus.textContent='';
    const form=new FormData(modelForm);
    const body={id:editingModelId||String(form.get('id')).trim(),name:String(form.get('name')).trim(),baseURL:String(form.get('baseURL')).trim(),modelId:String(form.get('modelId')).trim()};
    const key=String(form.get('apiKey')||'');if(key)body.apiKey=key;
    if(form.get('clearApiKey')==='on')body.clearApiKey=true;
    const save=document.querySelector('#save-model');save.disabled=true;
    try{
      await call(editingModelId?'/models/'+encodeURIComponent(editingModelId):'/models',{method:editingModelId?'PATCH':'POST',body:JSON.stringify(body)});
      modelForm.reset();modelForm.hidden=true;editingModelId=null;modelStatus.textContent='模型已保存。';
      await loadModels();await load();
    }catch(e){modelStatus.textContent=e.message;}
    finally{save.disabled=false;}
  });
  function currentOriginUrl(value) {
    const target = new URL(value, window.location.href);
    target.protocol = window.location.protocol;
    target.host = window.location.host;
    return target.href;
  }
  async function loadRelease(force=false) {
    try {
      const status=await call('/release'+(force?'?refresh=1':''));
      currentVersion.textContent='当前版本：v'+status.currentVersion;
      if(status.checkError||!status.latestVersion){
        latestVersion.textContent='最新版本检查失败';
        releaseStatus.textContent=status.checkError||'暂时无法读取 GitHub 发布信息';
        releaseLink.hidden=true;
        upgradeHeadbot.disabled=true;
        upgradeHeadbot.classList.remove('update-ready');
        upgradeHeadbot.textContent='暂不可升级';
        return status;
      }
      latestVersion.textContent='最新版本：v'+status.latestVersion;
      if(status.releaseUrl){releaseLink.href=status.releaseUrl;releaseLink.hidden=false;}else releaseLink.hidden=true;
      const active=['downloading','installing','restarting'].includes(status.state);
      const restartRequired=status.state==='restart-required';
      upgradeHeadbot.disabled=!status.updateAvailable||active||restartRequired;
      upgradeHeadbot.classList.toggle('update-ready',Boolean(status.updateAvailable&&!active&&!restartRequired));
      upgradeHeadbot.textContent=active?'正在升级…':restartRequired?'需重启 DSH':status.updateAvailable?'升级到 v'+status.latestVersion:'已是最新';
      if(active)releaseStatus.textContent=status.message||'升级后 DSH 将自动重启，页面可能短暂断开';
      else if(status.state==='completed')releaseStatus.textContent='';
      else if(status.state==='failed')releaseStatus.textContent='上次升级失败：'+(status.message||'请稍后重试');
      else if(status.state==='restart-required')releaseStatus.textContent=status.message||'安装完成，请重启 DSH';
      else releaseStatus.textContent=status.updateAvailable?'发现新版本，可直接从此页面升级':'';
      return status;
    }catch(e){
      latestVersion.textContent='最新版本检查失败';
      releaseStatus.textContent=e.message;
      upgradeHeadbot.disabled=true;
      upgradeHeadbot.classList.remove('update-ready');
      upgradeHeadbot.textContent='暂不可升级';
    }
  }
  async function loadRuntimeVersions(force=false) {
    try {
      const result=await call('/runtime-versions'+(force?'?refresh=1':''));
      const dsh=result.dsh||{};
      currentDshVersion.textContent='当前版本：'+(dsh.currentVersion?'v'+dsh.currentVersion:'无法读取');
      if(dsh.latestVersion)latestDshVersion.textContent='最新版本：v'+dsh.latestVersion;
      else latestDshVersion.textContent='最新版本检查失败';
      dshReleaseLink.hidden=!dsh.releaseUrl;
      if(dsh.releaseUrl)dshReleaseLink.href=dsh.releaseUrl;
      const dshBusy=['installing','restarting'].includes(dsh.state);
      dshUpgradePending=dshBusy;
      upgradeDsh.disabled=!dsh.updateAvailable||dshBusy||!dsh.canUpdate;
      upgradeDsh.classList.toggle('update-ready',Boolean(dsh.updateAvailable&&!dshBusy&&dsh.canUpdate));
      upgradeDsh.textContent=dshBusy?'正在升级…':dsh.updateAvailable?'升级到 v'+dsh.latestVersion:dsh.latestVersion?'已是最新':'暂不可升级';
      if(dsh.checkError)dshVersionStatus.textContent='版本检查失败：'+dsh.checkError;
      else if(!dsh.canUpdate)dshVersionStatus.textContent=dsh.updateError||'当前安装方式暂不支持管理页升级';
      else if(dsh.state==='completed')dshVersionStatus.textContent=dsh.message||('已升级到 v'+dsh.currentVersion);
      else if(dshBusy||dsh.state==='failed'||dsh.state==='deferred')dshVersionStatus.textContent=dsh.message||'';
      else dshVersionStatus.textContent=dsh.updateAvailable?'发现新版本。仅点击升级按钮时才会更新；升级会重启 DSH，升级脚本会先备份数据并在失败时回退。':'';
      clearTimeout(runtimeVersionPoll);
      runtimeVersionPoll=dshBusy?setTimeout(()=>loadRuntimeVersions(),2500):null;

      const dsBot=result.dsBot||{};
      const versions=[...new Set((dsBot.instances||[]).map(instance=>instance.currentVersion).filter(Boolean))];
      const allHaveSameVersion=(dsBot.instances||[]).length>0&&versions.length===1&&(dsBot.instances||[]).every(instance=>instance.currentVersion===versions[0]);
      currentDsBotVersion.textContent=allHaveSameVersion?'当前版本：v'+versions[0]:versions.length?'当前版本：版本不一致':(dsBot.instances||[]).length?'当前版本：未安装':'当前版本：无法读取';
      latestDsBotVersion.textContent=dsBot.latestVersion?'最新版本：v'+dsBot.latestVersion:'最新版本检查失败';
      const instances=dsBot.instances||[];
      const updating=instances.some(instance=>['updating','provisioning','starting','stopping','restarting','deleting'].includes(instance.status));
      updateAllDsBot.disabled=!dsBot.updateAvailable||updating;
      updateAllDsBot.classList.toggle('update-ready',Boolean(dsBot.updateAvailable&&!updating));
      updateAllDsBot.textContent=updating?'正在更新实例…':dsBot.latestVersion?'全部更新':'暂不可更新';
      if(dsBot.checkError)dsBotVersionStatus.textContent='版本检查失败：'+dsBot.checkError;
      else if(updating)dsBotVersionStatus.textContent='正在逐个更新并重启实例；主 DSH 实例最后更新。';
      else if(dsBot.updateAvailable)dsBotVersionStatus.textContent='发现更新。点击后会依次更新默认实例和所有团队实例。';
      else dsBotVersionStatus.textContent='';
      return result;
    }catch(e){
      if(dshUpgradePending){
        currentDshVersion.textContent='当前版本：升级中…';
        dshVersionStatus.textContent='DSH 正在重启，页面会自动重新连接并检查升级结果。';
        upgradeDsh.disabled=true;
        upgradeDsh.textContent='正在升级…';
        clearTimeout(runtimeVersionPoll);
        runtimeVersionPoll=setTimeout(()=>loadRuntimeVersions(),2500);
        return;
      }
      currentDshVersion.textContent='当前版本：无法读取';
      latestDshVersion.textContent='最新版本检查失败';
      dshVersionStatus.textContent=e.message;
      upgradeDsh.disabled=true;
      latestDsBotVersion.textContent='最新版本检查失败';
      currentDsBotVersion.textContent='当前版本：无法读取';
      dsBotVersionStatus.textContent=e.message;
      updateAllDsBot.disabled=true;
    }
  }
  function button(text, action, id, style='secondary') {
    const el = document.createElement('button'); el.type='button'; el.className=style; el.textContent=text;
    el.addEventListener('click', async () => { el.disabled=true; errorBox.textContent=''; try { await call('/teams/'+encodeURIComponent(id)+'/'+action,{method:'POST',body:'{}'}); await load(); } catch(e) { errorBox.textContent=e.message; } finally { el.disabled=false; } });
    return el;
  }
  function renderEditor(team) {
    const tr=document.createElement('tr');
    const cell=document.createElement('td');cell.colSpan=5;cell.className='team-editor-cell';
    const editor=document.createElement('div');editor.className='team-editor';
    const primary=document.createElement('div');primary.className='editor-primary'+(team.protected?' protected':'');
    const nameLabel=document.createElement('label');nameLabel.textContent='团队名称';
    const name=document.createElement('input');name.className='edit-field';name.setAttribute('aria-label','团队名称');name.maxLength=80;name.required=true;name.value=editDraft.name;name.addEventListener('input',()=>editDraft.name=name.value);nameLabel.append(name);
    const meta=document.createElement('div');meta.className='editor-meta';meta.textContent=team.id+(team.protected?' · 默认实例':'');
    primary.append(nameLabel);
    if(!team.protected){
      const portLabel=document.createElement('label');portLabel.textContent='独立服务端口';
      const port=document.createElement('input');port.className='edit-port';port.type='number';port.min=1024;port.max=65535;port.required=true;port.setAttribute('aria-label','独立服务端口');port.value=String(editDraft.port);port.addEventListener('input',()=>editDraft.port=port.value);portLabel.append(port);primary.append(portLabel);
    }
    editor.append(primary,meta);

    const modelLabel=document.createElement('label');modelLabel.textContent='实例模型（本实例全部 Bot）';
    const modelSelect=document.createElement('select');modelSelect.setAttribute('aria-label','实例模型，本实例全部 Bot');
    const noModel=document.createElement('option');noModel.value='';noModel.textContent=models.length?'不修改当前分配':'模型目录暂无模型';modelSelect.append(noModel);
    for(const model of models){const option=document.createElement('option');option.value=model.id;option.textContent=model.name+' · '+model.id+'/'+model.modelId;modelSelect.append(option);}
    if(editDraft.modelId&&!models.some(model=>model.id===editDraft.modelId)){const option=document.createElement('option');option.value=editDraft.modelId;option.textContent='当前模型不在目录中';modelSelect.append(option);}
    modelSelect.value=editDraft.modelId||'';modelSelect.disabled=models.length===0&&!editDraft.modelId;modelSelect.addEventListener('change',()=>editDraft.modelId=modelSelect.value);modelLabel.append(modelSelect);editor.append(modelLabel);

    const feishu=document.createElement('div');feishu.className='feishu-edit';
    const feishuTitle=document.createElement('h3');feishuTitle.textContent='飞书接入';feishu.append(feishuTitle);
    const fields=document.createElement('div');fields.className='feishu-fields';
    const stateGroup=document.createElement('fieldset');stateGroup.className='feishu-state';
    const stateLegend=document.createElement('legend');stateLegend.textContent='飞书接入状态';stateGroup.append(stateLegend);
    const stateOptions=document.createElement('div');stateOptions.className='feishu-state-options';
    let clearSecretInput;
    for(const [value,labelText] of [[true,'启用飞书'],[false,'关闭飞书']]){
      const choice=document.createElement('label');choice.className='feishu-radio';
      const radio=document.createElement('input');radio.type='radio';radio.name='feishu-enabled-'+team.id;radio.value=String(value);radio.checked=editDraft.feishuEnabled===value;
      radio.addEventListener('change',()=>{if(!radio.checked)return;editDraft.feishuEnabled=value;if(value&&clearSecretInput){editDraft.clearAppSecret=false;clearSecretInput.checked=false;}});
      choice.append(radio,document.createTextNode(labelText));stateOptions.append(choice);
    }
    stateGroup.append(stateOptions);fields.append(stateGroup);
    const appIdLabel=document.createElement('label');appIdLabel.textContent='飞书 App ID';
    const appId=document.createElement('input');appId.autocomplete='off';appId.placeholder='cli_…';appId.value=editDraft.appId;appId.addEventListener('input',()=>editDraft.appId=appId.value);appIdLabel.append(appId);fields.append(appIdLabel);
    const secretLabel=document.createElement('label');secretLabel.textContent='飞书 App Secret';
    const secret=document.createElement('input');secret.type='password';secret.autocomplete='new-password';secret.placeholder=editDraft.hasSecret?'已安全保存；留空保持不变':'输入 App Secret';secret.value=editDraft.appSecret;secret.addEventListener('input',()=>{editDraft.appSecret=secret.value;if(secret.value&&clearSecretInput){editDraft.clearAppSecret=false;clearSecretInput.checked=false;}});secretLabel.append(secret);fields.append(secretLabel);
    let clearSecretLabel;
    if(editDraft.hasSecret){clearSecretLabel=document.createElement('label');clearSecretLabel.className='check feishu-secret-action';clearSecretLabel.textContent='删除已保存的 App Secret';clearSecretInput=document.createElement('input');clearSecretInput.type='checkbox';clearSecretInput.checked=editDraft.clearAppSecret;clearSecretInput.addEventListener('change',()=>{editDraft.clearAppSecret=clearSecretInput.checked;if(clearSecretInput.checked){editDraft.feishuEnabled=false;const off=stateGroup.querySelector('input[type="radio"][value="false"]');if(off)off.checked=true;}});clearSecretLabel.append(clearSecretInput);}
    const botLabel=document.createElement('label');botLabel.textContent='接收消息的团队 Bot';
    const bot=document.createElement('select');bot.setAttribute('aria-label','接收消息的团队 Bot');
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=editDraft.botOptions.length?'选择一个 Bot':'团队内还没有可选 Bot';bot.append(placeholder);
    for(const item of editDraft.botOptions){const option=document.createElement('option');option.value=item.id;option.textContent=item.name+(item.role?' · '+item.role:'');bot.append(option);}
    if(editDraft.botId&&!editDraft.botOptions.some(item=>item.id===editDraft.botId)){const option=document.createElement('option');option.value=editDraft.botId;option.textContent='当前 Bot 不在列表中';bot.append(option);}
    bot.value=editDraft.botId;bot.addEventListener('change',()=>editDraft.botId=bot.value);botLabel.append(bot);fields.append(botLabel);
    feishu.append(fields);
    if(clearSecretLabel)feishu.append(clearSecretLabel);
    const note=document.createElement('div');note.className='small editor-note';note.textContent='飞书消息会作为用户指令发送给所选 Bot，并按其 DSH 权限执行。凭据仅当前 Mac 用户可读；同一 Mac 账户下的进程仍可能访问账户数据，仅为可信团队启用。';feishu.append(note);
    editor.append(feishu);

    const actions=document.createElement('div');actions.className='editor-actions';
    const busy=['updating','restarting','stopping','deleting'].includes(team.status);
    const save=document.createElement('button');save.type='button';save.textContent='保存';save.disabled=busy;
    save.addEventListener('click',async()=>{
      if(!editDraft||editDraft.id!==team.id)return;
      const draft={name:String(editDraft.name).trim()};
      if(!team.protected)draft.port=Number(editDraft.port);
      if(editDraft.modelId&&editDraft.modelId!==team.modelId)draft.modelId=editDraft.modelId;
      const portChanged=!team.protected&&draft.port!==team.port;
      const modelChanged=Boolean(draft.modelId);
      const feishuChanged=Boolean(editDraft.feishuEnabled)!==(team.feishu?.enabled===true)
        ||String(editDraft.appId).trim()!==(team.feishu?.appId||'')
        ||String(editDraft.botId).trim()!==(team.feishu?.botId||'')
        ||Boolean(editDraft.appSecret)
        ||Boolean(editDraft.clearAppSecret);
      if(feishuChanged)draft.feishu={enabled:Boolean(editDraft.feishuEnabled),appId:String(editDraft.appId).trim(),botId:String(editDraft.botId).trim(),appSecret:editDraft.appSecret,clearAppSecret:Boolean(editDraft.clearAppSecret&&!editDraft.appSecret)};
      const wasActive=!['stopped','failed'].includes(team.status);
      save.disabled=true;errorBox.textContent='';
      let stoppedForChange=false, saved=false;
      try{
        if(!team.protected&&(portChanged||feishuChanged)&&wasActive){await call('/teams/'+encodeURIComponent(team.id)+'/stop',{method:'POST',body:'{}'});await waitForTeam(team.id,'stopped');stoppedForChange=true;}
        await call('/teams/'+encodeURIComponent(team.id),{method:'PATCH',body:JSON.stringify(draft)});saved=true;
        editDraft.appSecret='';
        editDraft.clearAppSecret=false;
        if(stoppedForChange){await call('/teams/'+encodeURIComponent(team.id)+'/restart',{method:'POST',body:'{}'});await waitForTeam(team.id,'running');}
        if(team.protected&&modelChanged)await waitForTeam(team.id,'running');
        editDraft=null;await load();
      }catch(e){
        if(stoppedForChange&&portChanged&&!feishuChanged){
          try{
            const current=await getTeam(team.id);
            if(!['stopped','failed'].includes(current.status)){await call('/teams/'+encodeURIComponent(team.id)+'/stop',{method:'POST',body:'{}'});await waitForTeam(team.id,'stopped');}
            if(saved)await call('/teams/'+encodeURIComponent(team.id),{method:'PATCH',body:JSON.stringify({name:team.name,port:team.port})});
            await call('/teams/'+encodeURIComponent(team.id)+'/restart',{method:'POST',body:'{}'});await waitForTeam(team.id,'running');
          }catch(rollback){errorBox.textContent=e.message+'；恢复原端口也失败：'+rollback.message;}
        }
        if(!errorBox.textContent)errorBox.textContent=e.message;
        save.disabled=false;
        await load();
      }
    });actions.append(save);
    const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary';cancel.textContent='取消';cancel.disabled=busy;cancel.addEventListener('click',()=>{editDraft=null;load();});actions.append(cancel);
    editor.append(actions);cell.append(editor);tr.append(cell);return tr;
  }
  function render(teamList) {
    rows.replaceChildren();
    if (!teamList.length) { const tr=document.createElement('tr'), td=document.createElement('td'); td.colSpan=5;td.className='empty';td.textContent='还没有团队实例。请创建第一个团队。';tr.append(td);rows.append(tr);return; }
    const feishuLabels={unknown:'检测中',connecting:'连接中',connected:'已连接',retrying:'重连中',offline:'未连接',stopped:'已停止',failed:'连接失败'};
    const agentLabels={unknown:'待检测',restoring:'恢复中',online:'在线',offline:'离线',stopped:'实例已停止',failed:'会话恢复失败'};
    for (const team of teamList) {
      if(editDraft?.id===team.id){rows.append(renderEditor(team));continue;}
      const tr=document.createElement('tr');
      const who=document.createElement('td');
      const nameLine=document.createElement('div');nameLine.className='team-name-line';
      const name=document.createElement('strong');name.className='team-name';name.textContent=team.name;nameLine.append(name);
      if(team.protected){const tag=document.createElement('span');tag.className='protected-tag';tag.textContent='默认实例';nameLine.append(tag);}
      who.append(nameLine);
      if(!team.protected){const id=document.createElement('div');id.className='small team-id';id.textContent=team.id;who.append(id);}
      if(team.modelId){const model=document.createElement('div');model.className='small team-id';model.textContent='模型 · '+(team.modelName||team.modelId);who.append(model);}
      if(team.feishu?.enabled){
        const status=feishuLabels[team.feishu.status]||'待检测';
        const detail=document.createElement('span');detail.className='feishu-status'+(team.feishu.status==='connected'?' connected':team.feishu.status==='retrying'?' retrying':team.feishu.status==='failed'?' failed':'');detail.textContent='飞书 · '+status;
        detail.title='根据飞书长连接的实时状态显示。';who.append(detail);
        if(team.feishu.agentStatus){const agent=document.createElement('span');agent.className='feishu-status'+(team.feishu.agentStatus==='online'?' connected':team.feishu.agentStatus==='restoring'?' retrying':team.feishu.agentStatus==='failed'?' failed':'');agent.textContent='Agent · '+(agentLabels[team.feishu.agentStatus]||'待检测');agent.title='显示所选 DSH Agent 会话是否已恢复并在线。';who.append(agent);}
      }
      const state=document.createElement('td'); const badge=document.createElement('span'); badge.className='status '+team.status; badge.textContent=labels[team.status]||team.status; state.append(badge);
      if (team.message) { const detail=document.createElement('div');detail.className='small';detail.textContent=team.message;state.append(detail); }
      const port=document.createElement('td');port.textContent=String(team.port);
      const entry=document.createElement('td'); const link=document.createElement('a');link.className='link';link.textContent='打开';link.href=currentOriginUrl(team.launchUrl||team.url);link.target='_blank';link.rel='noopener noreferrer';entry.append(link);
      const actionsCell=document.createElement('td');
      const actions=document.createElement('div');actions.className='actions';actionsCell.append(actions);
      const busy=['updating','restarting','stopping','deleting'].includes(team.status);
      const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='编辑';edit.disabled=busy;
      edit.addEventListener('click',async()=>{
        edit.disabled=true;errorBox.textContent='';
        try{
          const result=await call('/teams/'+encodeURIComponent(team.id)+'/bots');
          editDraft={id:team.id,name:team.name,port:team.port,modelId:team.modelId||'',feishuEnabled:team.feishu?.enabled===true,appId:team.feishu?.appId||'',botId:team.feishu?.botId||'',appSecret:'',clearAppSecret:false,hasSecret:team.feishu?.hasSecret===true,botOptions:result.bots||[]};
          await load(true);
        }catch(e){errorBox.textContent=e.message;edit.disabled=false;}
      });actions.append(edit);
      if(!team.protected){
        if (team.status==='running'||team.status==='starting'||team.status==='provisioning'||team.status==='updating') actions.append(button('停止','stop',team.id,'danger'));
        else actions.append(button('启动','start',team.id));
      }
      actions.append(button('重启','restart',team.id));
      if(!team.protected){
        const remove=document.createElement('button');remove.type='button';remove.className='danger';remove.textContent='删除实例';
        remove.disabled=busy;
        remove.addEventListener('click',async()=>{if(!confirm('停止并删除团队 '+team.name+'？实例数据将归档保留，通信身份会撤销；同名新团队不会继承旧收件箱。'))return;remove.disabled=true;try{await call('/teams/'+encodeURIComponent(team.id),{method:'DELETE'});await load();}catch(e){errorBox.textContent=e.message;remove.disabled=false;}});actions.append(remove);
        const auto=document.createElement('label');auto.style.display='inline-flex';auto.style.alignItems='center';auto.style.gap='5px';auto.style.padding='7px';auto.textContent='开机启动';
        const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=team.autoStart;checkbox.style.width='auto';checkbox.disabled=busy;
        checkbox.addEventListener('change',async()=>{try{await call('/teams/'+encodeURIComponent(team.id),{method:'PATCH',body:JSON.stringify({autoStart:checkbox.checked})});}catch(e){errorBox.textContent=e.message;checkbox.checked=!checkbox.checked;}});auto.append(checkbox);actions.append(auto);
      }
      if(busy)for(const control of actions.querySelectorAll('button'))control.disabled=true;
      tr.append(who,state,port,entry,actionsCell);rows.append(tr);
    }
  }
  async function getTeam(id){const result=await call('/teams');return (result.teams||[]).find(team=>team.id===id);}
  async function waitForTeam(id,status){const deadline=Date.now()+120000;while(Date.now()<deadline){let team;try{team=await getTeam(id);}catch(e){if(id!=='default')throw e;await new Promise(resolve=>setTimeout(resolve,750));continue;}if(!team)throw new Error('找不到团队实例 '+id);if(team.status===status)return team;if(team.status==='failed')throw new Error(team.message||'团队实例操作失败');await new Promise(resolve=>setTimeout(resolve,750));}throw new Error('等待团队实例状态超时：'+status);}
  async function load(forceRender=false) { try { const result=await call('/teams'); if(!editDraft||forceRender){render(result.teams||[]);errorBox.textContent='';} } catch(e) { errorBox.textContent=e.message; } }
  document.querySelector('#add-form').addEventListener('submit',async event=>{
    event.preventDefault(); errorBox.textContent='';
    const formElement=event.currentTarget;
    const form=new FormData(formElement);
    const body={id:String(form.get('id')).trim(),name:String(form.get('name')).trim(),port:Number(form.get('port')),autoStart:true};
    try { await call('/teams',{method:'POST',body:JSON.stringify(body)}); formElement.reset(); formElement.elements.port.value='3101';formElement.hidden=true;document.querySelector('#toggle-add-form').setAttribute('aria-expanded','false');await load(); }
    catch(e) { errorBox.textContent=e.message; }
  });
  const addForm=document.querySelector('#add-form'),toggleAddForm=document.querySelector('#toggle-add-form');
  toggleAddForm.addEventListener('click',()=>{addForm.hidden=!addForm.hidden;toggleAddForm.setAttribute('aria-expanded',String(!addForm.hidden));if(addForm.hidden){addForm.reset();addForm.elements.port.value='3101';}else addForm.elements.id.focus();});
  document.querySelector('#cancel-add').addEventListener('click',()=>{addForm.reset();addForm.elements.port.value='3101';addForm.hidden=true;toggleAddForm.setAttribute('aria-expanded','false');});
  document.querySelector('#refresh').addEventListener('click',()=>load());
  checkUpdate.addEventListener('click',()=>loadRelease(true));
  upgradeHeadbot.addEventListener('click',async()=>{
    const latest=latestVersion.textContent.replace(/^最新版本：/,'');
    if(!confirm('将 DS Headbot 升级到 '+latest+'。DSH 会自动重启，团队数据保留。继续吗？'))return;
    upgradeHeadbot.disabled=true;
    upgradeHeadbot.textContent='正在升级…';
    releaseStatus.textContent='正在下载并安装更新；DSH 重启后本页会恢复';
    try{await call('/release/upgrade',{method:'POST',body:'{}'});await loadRelease();}
    catch(e){releaseStatus.textContent=e.message;await loadRelease(true);}
  });
  checkDshVersion.addEventListener('click',()=>loadRuntimeVersions(true));
  checkDsBotVersion.addEventListener('click',()=>loadRuntimeVersions(true));
  upgradeDsh.addEventListener('click',async()=>{
    const latest=latestDshVersion.textContent.replace(/^最新版本：/,'');
    if(!confirm('将 DeepSeek Harness 升级到 '+latest+'。DSH 和团队实例会重启；现有数据会先备份，失败时自动回退。继续吗？'))return;
    upgradeDsh.disabled=true;
    upgradeDsh.textContent='正在升级…';
    dshUpgradePending=true;
    dshVersionStatus.textContent='正在准备升级并备份数据；DSH 重启后页面会自动恢复';
    try{await call('/runtime-versions/dsh/upgrade',{method:'POST',body:'{}'});await loadRuntimeVersions();}
    catch(e){dshVersionStatus.textContent=e.message;await loadRuntimeVersions(true);}
  });
  document.querySelector('#update-all').addEventListener('click',async event=>{
    const control=event.currentTarget;control.disabled=true;dsBotVersionStatus.textContent='正在逐个更新所有实例的 DS Bot…';
    try{
      const result=await call('/teams');
      const ordered=[...(result.teams||[]).filter(team=>!team.protected),...(result.teams||[]).filter(team=>team.protected)];
      for(const team of ordered){
        dsBotVersionStatus.textContent='正在更新 '+team.name+' 的 DS Bot…';
        await call('/teams/'+encodeURIComponent(team.id)+'/update-bot',{method:'POST',body:'{}'});
        await waitForTeam(team.id,'running');
      }
      dsBotVersionStatus.textContent='所有实例的 DS Bot 已更新并重新启动。';
    }catch(e){dsBotVersionStatus.textContent='批量更新中断：'+e.message;}
    finally{control.disabled=false;await load();await loadRuntimeVersions(true);}
  });
  const auditRows=document.querySelector('#audit-events'),auditStatus=document.querySelector('#audit-status');
  const auditPageSize=10;
  let auditBefore=null,nextBefore=null,auditPageNumber=1;
  const auditHistory=[];
  function updateAuditPager(){
    document.querySelector('#audit-page').textContent='第 '+auditPageNumber+' 页';
    document.querySelector('#audit-previous').disabled=auditHistory.length===0;
    document.querySelector('#audit-next').disabled=!nextBefore;
  }
  const auditLabels={'message.sent':'发送消息','messages.received':'读取收件箱','attachment.received':'接收附件','attachment.reviewed':'审查附件'};
  async function loadAudit(before=null,pageNumber=auditPageNumber){
    try{
      const filter=document.querySelector('#audit-team').value.trim();
      const result=await call('/audit?limit='+(auditPageSize+1)+'&team='+encodeURIComponent(filter)+(before?'&before='+before:''));
      const pageEvents=(result.events||[]).slice(0,auditPageSize);
      auditBefore=before;nextBefore=result.events?.length>auditPageSize?pageEvents.at(-1)?.seq:null;auditPageNumber=pageNumber;auditRows.replaceChildren();
      auditStatus.textContent='审计链校验通过 · 本页 '+pageEvents.length+' 条记录';
      for(const event of pageEvents){
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
      updateAuditPager();
      return true;
    }catch(e){auditStatus.textContent='审计读取失败：'+e.message;return false;}
  }
  document.querySelector('#audit-refresh').addEventListener('click',()=>{auditHistory.length=0;auditPageNumber=1;loadAudit();});
  document.querySelector('#audit-team').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();auditHistory.length=0;auditPageNumber=1;loadAudit();}});
  document.querySelector('#audit-next').addEventListener('click',async()=>{if(nextBefore){const previousBefore=auditBefore,cursor=nextBefore;if(await loadAudit(cursor,auditPageNumber+1)){auditHistory.push(previousBefore);updateAuditPager();}}});
  document.querySelector('#audit-previous').addEventListener('click',async()=>{if(auditHistory.length){const before=auditHistory.at(-1);if(await loadAudit(before,Math.max(1,auditPageNumber-1))){auditHistory.pop();updateAuditPager();}}});
    loadModels().then(()=>load());loadAudit();loadRelease();loadRuntimeVersions();setInterval(()=>{load();if(auditBefore===null&&!auditRows.querySelector('details[open]'))loadAudit();},4000);setInterval(()=>{loadRelease();if(!dshUpgradePending)loadRuntimeVersions();},60000);
})();
</script>
</body>
</html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}
