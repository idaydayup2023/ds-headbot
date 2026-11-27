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
    .version-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:18px}.version-card{min-width:0;padding:16px;margin:0}.cardline{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.cardline h2{flex:none}.cardline .version-values{margin-top:0;flex:1;min-width:0}.version-card .actions{justify-content:flex-start}.version-values{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:5px}.version-values span{white-space:nowrap}
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
    .health-icons{display:flex;align-items:center;gap:9px;margin-top:7px}.health-icon{display:inline-flex;width:25px;height:25px;align-items:center;justify-content:center;border-radius:50%;cursor:default}.health-icon svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.health-icon.ok{background:#e3f6ec;color:#17683d}.health-icon.fault{background:#fff0f0;color:#a82d2d}.health-icon.unknown{background:#eef2f7;color:#748094}.health-icon.health-dot{width:12px;height:12px;border:0}.health-dot.ok{background:#16a34a}.health-dot.fault{background:#dc2626}.health-dot.unknown{background:#98a2b3}
    .status.running{background:#e3f6ec;color:#17683d}.status.failed{background:#fff0f0;color:#a82d2d}.status.provisioning,.status.starting,.status.updating,.status.restarting{background:#fff5dd;color:#8a5a00}
    .small{font-size:12px;color:#758095;overflow-wrap:anywhere}.error{color:#a82d2d;white-space:pre-wrap;margin:10px 0}.empty{text-align:center;padding:28px;color:#758095}.edit-field,.edit-port{width:100%;max-width:none}.protected-tag{display:inline-block;margin-left:6px;border-radius:99px;background:#e8eef7;color:#1c3558;padding:2px 7px;font-size:11px;vertical-align:middle}
    .team-editor-cell{padding:14px 10px!important;font-weight:400}.team-editor{display:grid;gap:16px;width:100%;padding:18px;border:1px solid #dfe6f0;border-radius:12px;background:#f8fafc}.editor-primary{display:grid;grid-template-columns:minmax(260px,2fr) minmax(170px,1fr);gap:18px;align-items:end;max-width:720px}.editor-primary.protected{grid-template-columns:minmax(260px,1fr);max-width:460px}.editor-meta{font-size:12px;color:#758095}.feishu-edit{display:grid;gap:10px;width:100%}.feishu-edit h3{font-size:13px;margin:0;color:#526072}.feishu-fields{display:grid;grid-template-columns:minmax(190px,1fr) repeat(3,minmax(180px,1.1fr));gap:12px;align-items:end}.feishu-edit label{font-size:12px}.feishu-edit input,.feishu-edit select{font-size:13px;padding:9px}.feishu-edit .check{display:flex;align-items:center;gap:8px;min-height:38px}.feishu-edit .check input{width:auto;flex:none}.feishu-edit .small{font-weight:400}.feishu-state{min-width:0;margin:0;padding:7px 10px 9px;border:1px solid #cfd7e4;border-radius:9px}.feishu-state legend{padding:0 4px;font-size:12px;color:#526072}.feishu-state-options{display:flex;gap:12px;align-items:center;min-height:24px}.feishu-radio{display:inline-flex!important;grid-template-columns:none!important;align-items:center;gap:6px!important;white-space:nowrap}.feishu-radio input{width:auto;flex:none;margin:0}.feishu-secret-action{display:flex!important;justify-content:flex-start;align-items:center;gap:8px}.feishu-edit .check input{width:auto;flex:none}.feishu-edit .small{font-weight:400}.team-editor .editor-note{line-height:1.5}.editor-actions{display:flex;justify-content:flex-end;gap:8px}
    .notice{background:#eef5ff;border:1px solid #d7e6ff;border-radius:9px;padding:12px 14px;color:#38577d;font-size:13px;line-height:1.55;margin-bottom:18px}
    details{max-width:620px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:13px;max-height:360px;overflow:auto}.audit-filters{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.audit-filters input{max-width:260px}.audit-files{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
    @media(max-width:1000px){.feishu-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.version-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.model-form{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(max-width:760px){body{padding:18px 10px}header{display:block}.host{margin-top:8px}form{grid-template-columns:1fr 1fr}.model-form{grid-template-columns:1fr}.toolbar{align-items:flex-start}.version-cards{grid-template-columns:1fr}table,tbody,tr,td{display:block}.team-table colgroup,.model-table colgroup{display:none}thead{display:none}tr{border-top:1px solid #edf0f5;padding:8px 0}td{border:0;padding:5px 8px}td:first-child{font-weight:600}.actions{padding-top:9px!important}.version-card .actions{padding-top:0!important}.team-editor-cell{width:100%;padding:8px!important;font-weight:400}.team-editor{padding:14px}.editor-primary,.editor-primary.protected,.feishu-fields{grid-template-columns:1fr;max-width:none}.feishu-edit .check{min-height:0}.editor-actions{justify-content:flex-start}}
    @media(prefers-color-scheme:dark){:root{background:#10151d;color:#edf2fa}.card,section{background:#171f2a;border-color:#2a3545}p,label,.small,th{color:#aab5c5}input{background:#10151d;border-color:#3a4658;color:#edf2fa}.notice{background:#17283c;border-color:#284364;color:#c2d9f8}.status{background:#2a3545;color:#d2d9e4}.status.running{background:#183c2c;color:#a5e3be}.status.failed{background:#462525;color:#ffb5b5}.status.provisioning,.status.starting,.status.updating,.status.restarting{background:#463719;color:#ffdc8a}.team-editor{background:#111923;border-color:#2a3545}.feishu-status{background:#2a3545;color:#d2d9e4}.feishu-status.connected{background:#183c2c;color:#a5e3be}.feishu-status.retrying{background:#463719;color:#ffdc8a}.feishu-status.failed{background:#462525;color:#ffb5b5}.health-icon.ok{background:#183c2c;color:#a5e3be}.health-icon.fault{background:#462525;color:#ffb5b5}.health-icon.unknown{background:#2a3545;color:#aab5c5}.health-dot.ok{background:#22c55e}.health-dot.fault{background:#ef4444}.health-dot.unknown{background:#7b8797}.protected-tag{background:#28384c;color:#dceaff}button.secondary{background:#28384c;color:#dceaff}button.danger{background:#422626;color:#ffc1c1}button.update-ready{background:#b85b0d;box-shadow:0 0 0 3px #603718}td,th{border-color:#2a3545}}
  </style>
</head>
<body>
<main>
  <header><div><h1>DS Headbot 团队管理</h1></div><div class="host">入口：<strong id="public-entry">http://${publicHost}</strong></div></header>
  <div class="notice">管理接口要求当前 DSH 浏览器会话。首次访问时，请先用 DSH 启动日志打印的登录链接完成一次登录，再打开此管理页。</div>
  <div class="version-cards">
    <!-- UI-006 (user directive 2026-11-15): card face carries exactly one version line
         (安装版本：xxxx) plus the upgrade button; component names are the five canonical strings.
         The upgrade button renders ONLY when a newer version exists (no DOM node otherwise), is
         labelled 升级到 <target>, flips to 升级中 while busy, and disappears after success.
         One-step upgrade: the click executes directly — no front-end confirmation dialog any more.
         UI-008 (user directive 2026-11-15, strict face): beyond the version line and the buttons
         the card renders NOTHING — check errors, gate reasons and request failures never reach
         the card face (no block lines at all); those readings live only in the API/audit data
         plane (and the browser console). Backend gates (litellm patch gate / triple verification
         / dirty-worktree / plan) are unchanged — the API still returns the reason verbatim.
         BALANCE-001 pending-patch state (gate.details md5Declared) is likewise API-only now. -->
    <section class="card version-card" id="headbot-version-card">
      <div class="cardline"><h2>DS HeadBot</h2><p class="small version-values"><span id="headbot-version">安装版本：v${escapeHtml(config.version || 'unknown')}</span></p><div class="actions"><span id="upgrade-headbot-slot"></span></div></div>
    </section>
    <section class="card version-card" id="dsbot-version-card">
      <div class="cardline"><h2>DS Bot</h2><p class="small version-values"><span id="dsbot-version">安装版本：检查中…</span></p><div class="actions"><span id="update-all-slot"></span></div></div>
    </section>
    <section class="card version-card" id="dsh-version-card">
      <div class="cardline"><h2>DeepSeek Harness</h2><p class="small version-values"><span id="dsh-version">安装版本：检查中…</span></p><div class="actions"><span id="upgrade-dsh-slot"></span></div></div>
    </section>
    <section class="card version-card" id="litellm-version-card">
      <div class="cardline"><h2>LiteLLM</h2><p class="small version-values"><span id="litellm-version">安装版本：检查中…</span></p><div class="actions"><span id="upgrade-litellm-slot"></span><a class="link" id="litellm-open" target="_blank" rel="noopener noreferrer" href="http://192.168.1.5:8888/ui">打开</a></div></div>
    </section>
    <section class="card version-card" id="sparkdash-version-card">
      <div class="cardline"><h2>SparkDash</h2><p class="small version-values"><span id="sparkdash-version">安装版本：检查中…</span></p><div class="actions"><span id="upgrade-sparkdash-slot"></span><a class="link" id="sparkdash-open" target="_blank" rel="noopener noreferrer" href="http://192.168.1.5:5555">打开</a></div></div>
    </section>
  </div>
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
  const headbotVersionLine = document.querySelector('#headbot-version');
  const upgradeHeadbotSlot = document.querySelector('#upgrade-headbot-slot');
  const dshVersionLine = document.querySelector('#dsh-version');
  const upgradeDshSlot = document.querySelector('#upgrade-dsh-slot');
  const dsBotVersionLine = document.querySelector('#dsbot-version');
  const updateAllDsBotSlot = document.querySelector('#update-all-slot');
  const DS_BOT_UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
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
  // UI-006: no confirm dialogs any more. UI-008 (strict face): check errors, gate reasons and
  // request failures never render on the card face at all — they live only in the API/audit data
  // plane and the browser console; a failed check leaves the card sitting quietly on its version
  // line. window.console?.warn keeps the sandboxed test harness (no console) safe.
  // UI-006 ③ (user order 2026-11-15, verbatim): 无新版本→按钮不渲染——不是 hidden，DOM 无节点。
  // The button node is created only while there is something to act on (a newer version or a busy
  // run) and destroyed the moment there is not (up to date, or upgrade finished).
  function renderUpgradeButton(slot, options) {
    slot.replaceChildren();
    if (!options) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = options.id;
    btn.textContent = options.label;
    btn.classList.toggle('update-ready', Boolean(options.ready) && !options.disabled);
    if (options.disabled) btn.disabled = true;
    btn.addEventListener('click', () => { if (!btn.disabled && options.onClick) return options.onClick(btn); });
    slot.append(btn);
  }
  function currentOriginUrl(value) {
    const target = new URL(value, window.location.href);
    target.protocol = window.location.protocol;
    target.host = window.location.host;
    return target.href;
  }
  // UI-006 lifecycle, shared shape for all five cards: the button node only exists while a newer
  // version is available; while busy it reads 升级中; after success (updateAvailable=false) it is
  // removed from the DOM. Blocked attempts stay clickable — the backend gate answers with the
  // reason on the API; per UI-008 nothing is printed on the card face.
  let headbotInFlight=false;
  async function loadRelease(force=false) {
    try {
      const status=await call('/release'+(force?'?refresh=1':''));
      headbotVersionLine.textContent='安装版本：v'+(status.currentVersion||'无法读取');
      const active=['downloading','installing','restarting'].includes(status.state);
      const restartRequired=status.state==='restart-required';
      if(!headbotInFlight){
        if(active||restartRequired)renderUpgradeButton(upgradeHeadbotSlot,{id:'upgrade-headbot',label:'升级中',disabled:true});
        else if(status.updateAvailable)renderUpgradeButton(upgradeHeadbotSlot,{id:'upgrade-headbot',label:'升级到 v'+(status.latestVersion||'?'),ready:true,onClick:startHeadbotUpgrade});
        else renderUpgradeButton(upgradeHeadbotSlot,null);
      }
      // UI-008：checkError/无 latestVersion 一律静默——读数只进 API 面，卡面安静停着。
      if(status.checkError)window.console?.warn('HeadBot 版本检查失败：'+status.checkError);
      return status;
    }catch(e){
      headbotVersionLine.textContent='安装版本：无法读取';
      window.console?.warn('HeadBot 状态读取失败：'+e.message);
    }
  }
  let dsBotUpgradeAvailable=false,dsBotLatest='',dsBotBusy=false,dshInFlight=false,dsBotInFlight=false;
  async function loadRuntimeVersions(force=false) {
    try {
      const result=await call('/runtime-versions'+(force?'?refresh=1':''));
      const dsh=result.dsh||{};
      dshVersionLine.textContent='安装版本：'+(dsh.currentVersion?'v'+dsh.currentVersion:'无法读取');
      const dshBusy=['installing','restarting'].includes(dsh.state);
      dshUpgradePending=dshBusy;
      if(!dshInFlight){
        if(dshBusy)renderUpgradeButton(upgradeDshSlot,{id:'upgrade-dsh',label:'升级中',disabled:true});
        else if(dsh.updateAvailable)renderUpgradeButton(upgradeDshSlot,{id:'upgrade-dsh',label:'升级到 v'+(dsh.latestVersion||'?'),ready:true,onClick:startDshUpgrade});
        else renderUpgradeButton(upgradeDshSlot,null);
      }
      // UI-008：DSH 的 checkError/管理页不支持提示一律静默——读数只进 API 面。
      if(dsh.checkError)window.console?.warn('DSH 版本检查失败：'+dsh.checkError);
      if(!dsh.canUpdate&&dsh.updateError)window.console?.warn('DSH 升级不支持：'+dsh.updateError);
      clearTimeout(runtimeVersionPoll);
      runtimeVersionPoll=dshBusy?setTimeout(()=>loadRuntimeVersions(),2500):null;

      const dsBot=result.dsBot||{};
      const instances=dsBot.instances||[];
      const versions=[...new Set(instances.map(instance=>instance.currentVersion).filter(Boolean))];
      const allHaveSameVersion=instances.length>0&&versions.length===1&&instances.every(instance=>instance.currentVersion===versions[0]);
      dsBotVersionLine.textContent='安装版本：'+(allHaveSameVersion?'v'+versions[0]:versions.length?'版本不一致':(instances.length?'未安装':'无法读取'));
      dsBotBusy=instances.some(instance=>['updating','provisioning','starting','stopping','restarting','deleting'].includes(instance.status));
      dsBotUpgradeAvailable=Boolean(dsBot.updateAvailable);
      dsBotLatest=dsBot.latestVersion||'';
      if(!dsBotInFlight){
        if(dsBotBusy)renderUpgradeButton(updateAllDsBotSlot,{id:'update-all',label:'升级中',disabled:true});
        else if(dsBotUpgradeAvailable)renderUpgradeButton(updateAllDsBotSlot,{id:'update-all',label:'升级到 v'+(dsBotLatest||'?'),ready:true,onClick:startDsBotUpgrade});
        else renderUpgradeButton(updateAllDsBotSlot,null);
      }
      // UI-008：批量更新的进度/完成/检查失败话术一律不上卡面，只进 console/API 面。
      if(dsBot.checkError)window.console?.warn('DS Bot 版本检查失败：'+dsBot.checkError);
      return result;
    }catch(e){
      if(dshUpgradePending){
        // UI-007/UI-008：重启窗口期卡面零话术，busy 只由按钮「升级中」表达；静默续轮询。
        renderUpgradeButton(upgradeDshSlot,{id:'upgrade-dsh',label:'升级中',disabled:true});
        clearTimeout(runtimeVersionPoll);
        runtimeVersionPoll=setTimeout(()=>loadRuntimeVersions(),2500);
        return;
      }
      dshVersionLine.textContent='安装版本：无法读取';
      dsBotVersionLine.textContent='安装版本：无法读取';
      window.console?.warn('运行时版本读取失败：'+e.message);
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
    const brokerLabels={connected:'上行正常',local:'本机正常',offline:'实例离线',stale:'心跳超时',unknown:'待验证',pending:'尚无下行记录',pushed:'推送成功',received:'已收件',failed:'推送失败',skipped:'未主动推送'};
    const brokerSvg='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h17v11h-17z"/><path d="m4 7 8 6 8-6"/></svg>';
    const feishuSvg='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.8" cy="7.7" r="3.1"/><circle cx="17.1" cy="9.1" r="2.4"/><path d="M2.7 19c0-3.5 2.7-6.1 6.1-6.1s6.1 2.6 6.1 6.1"/><path d="M14.8 13.7c3.1 0 5.6 2.1 6.2 5.3"/></svg>';
    function appendHealthIcon(parent,kind,health,title){
      const icon=document.createElement('span');icon.className='health-icon '+health;icon.setAttribute('role','img');icon.setAttribute('aria-label',title);icon.title=title;
      if(kind==='instance'){icon.classList.add('health-dot');}else icon.innerHTML=kind==='broker'?brokerSvg:feishuSvg;
      parent.append(icon);
    }
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
      const state=document.createElement('td');
      const healthIcons=document.createElement('div');healthIcons.className='health-icons';
      const instanceHealth=team.status==='running'?'ok':team.status==='failed'?'fault':'unknown';
      const instanceTitle=team.status==='running'?'实例正在运行':team.status==='failed'?'实例故障'+(team.message?'：'+team.message:''):'实例状态：'+(labels[team.status]||team.status)+(team.message?'；'+team.message:'');
      appendHealthIcon(healthIcons,'instance',instanceHealth,instanceTitle);
      const up=team.broker?.uplink?.status||'unknown',down=team.broker?.downlink?.status||'unknown';
      const brokerFault=['offline','stale','failed','skipped'].includes(up)||['offline','failed','skipped'].includes(down);
      const downAt=Number(team.broker?.downlink?.at||0);
      const recentDown=downAt>0&&Date.now()-downAt<24*60*60*1000&&['pushed','received'].includes(down);
      const brokerKnown=['connected','local'].includes(up)||recentDown;
      const brokerHealth=brokerFault?'fault':brokerKnown?'ok':'unknown';
      const brokerTitle=(brokerFault?'团队通信异常':brokerKnown?'团队通信正常':'团队通信状态待确认')+'。上行：'+(brokerLabels[up]||'待验证')+'；下行：'+(brokerLabels[down]||'待验证')+'。';
      appendHealthIcon(healthIcons,'broker',brokerHealth,brokerTitle);
      const feishu=team.feishu||{};
      const feishuStatus=feishu.status||'unknown';
      const feishuHealth=!feishu.enabled?'unknown':feishuStatus==='connected'?'ok':['failed','offline','retrying'].includes(feishuStatus)?'fault':'unknown';
      const feishuLabel=!feishu.enabled?'飞书未启用':feishuStatus==='connected'?'飞书通信正常':feishuStatus==='failed'?'飞书连接故障':feishuStatus==='offline'?'飞书通信未连接':feishuStatus==='retrying'?'飞书正在重连':feishuStatus==='connecting'?'飞书正在连接':'飞书状态待确认';
      appendHealthIcon(healthIcons,'feishu',feishuHealth,feishuLabel);
      state.append(healthIcons);
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
  async function waitForTeam(id,status,options={}){
    const timeoutMs=options.timeoutMs??120000;
    const deadline=Date.now()+timeoutMs;
    let observedTransition=!options.requireTransition;
    while(Date.now()<deadline){
      let team;
      try{team=await getTeam(id);}
      catch(e){
        const retryable=options.retryReadErrors&&/Failed to fetch|Load failed|NetworkError|HTTP (408|429|500|502|503|504)/i.test(e.message||'');
        if(id!=='default'&&!retryable)throw e;
        await new Promise(resolve=>setTimeout(resolve,750));
        continue;
      }
      if(!team)throw new Error('找不到团队实例 '+id);
      if(team.status!==status)observedTransition=true;
      if(team.status===status&&observedTransition)return team;
      if(team.status==='failed')throw new Error(team.message||'团队实例操作失败');
      await new Promise(resolve=>setTimeout(resolve,750));
    }
    throw new Error('等待团队实例状态超时：'+status+'（'+Math.ceil(timeoutMs/60000)+' 分钟）');
  }
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
  // UI-006 one-step upgrade: press = execute. The only front-end guard is the in-flight busy state
  // (防重提); every safety check stays server-side and its reason is reported honestly.
  async function startHeadbotUpgrade(btn){
    if(headbotInFlight)return;
    headbotInFlight=true;
    btn.disabled=true;btn.textContent='升级中';btn.classList.toggle('update-ready',false);
    try{await call('/release/upgrade',{method:'POST',body:'{}'});headbotInFlight=false;await loadRelease();}
    catch(e){headbotInFlight=false;window.console?.warn('HeadBot 升级失败：'+e.message);await loadRelease(true);}
  }
  async function startDshUpgrade(btn){
    if(dshInFlight)return;
    dshInFlight=true;
    btn.disabled=true;btn.textContent='升级中';btn.classList.toggle('update-ready',false);
    dshUpgradePending=true;
    try{await call('/runtime-versions/dsh/upgrade',{method:'POST',body:'{}'});dshInFlight=false;await loadRuntimeVersions();}
    catch(e){dshInFlight=false;window.console?.warn('DSH 升级失败：'+e.message);await loadRuntimeVersions(true);}
  }
  async function startDsBotUpgrade(btn){
    if(dsBotInFlight)return;
    dsBotInFlight=true;
    btn.disabled=true;btn.textContent='升级中';btn.classList.toggle('update-ready',false);
    const failures=[];
    let ordered=[];
    let updated=0;
    try{
      const result=await call('/teams');
      ordered=[...(result.teams||[]).filter(team=>!team.protected),...(result.teams||[]).filter(team=>team.protected)];
      for(const team of ordered){
        try{
          await call('/teams/'+encodeURIComponent(team.id)+'/update-bot',{method:'POST',body:'{}'});
          await waitForTeam(team.id,'running',{timeoutMs:DS_BOT_UPDATE_TIMEOUT_MS,requireTransition:true,retryReadErrors:true});
          updated++;
        }catch(e){
          failures.push((team.name||team.id)+': '+e.message);
          window.console?.warn('DS Bot 更新失败（'+team.id+'）：'+e.message);
        }
      }
    }catch(e){
      failures.push('批量任务：'+e.message);
      window.console?.warn('DS Bot 批量更新失败：'+e.message);
    }finally{
      dsBotInFlight=false;
      await load();
      await loadRuntimeVersions(true);
      if(failures.length)errorBox.textContent='DS Bot 批量升级完成：'+updated+'/'+ordered.length+' 个实例成功；未完成：'+failures.join('；');
    }
  }
  const litellmVersionLine=document.querySelector('#litellm-version');
  const upgradeLitellmSlot=document.querySelector('#upgrade-litellm-slot');
  let litellmTarget=null,litellmBusyTimer=null,litellmUpgradeReady=false,litellmInFlight=false;
  async function loadLitellm(force=false){
    try{
      const status=await call('/litellm'+(force?'?refresh=1':''));
      litellmVersionLine.textContent='安装版本：'+(status.currentVersion||'无法读取');
      const busy=['installing','restarting'].includes(status.state);
      litellmTarget=status.updateAvailable?status.latestVersion:null;
      litellmUpgradeReady=Boolean(status.canUpgrade);
      if(!litellmInFlight){
        if(busy)renderUpgradeButton(upgradeLitellmSlot,{id:'upgrade-litellm',label:'升级中',disabled:true});
        else if(status.updateAvailable)renderUpgradeButton(upgradeLitellmSlot,{id:'upgrade-litellm',label:'升级到 '+(status.latestVersion||'?'),ready:litellmUpgradeReady,onClick:startLitellmUpgrade});
        else renderUpgradeButton(upgradeLitellmSlot,null);
      }
      // UI-008 strict face: check errors and patch-gate reasons never print on the card — they
      // stay in the API/audit readouts (status.checkError, status.gate.reasons, and the
      // BALANCE-001 gate.details md5Declared flag). The card sits quiet; the button, when
      // rendered, stays clickable and the backend answers with the verbatim reason on the API.
      if(status.checkError)window.console?.warn('LiteLLM 版本检查失败：'+status.checkError);
      if(status.updateAvailable&&status.gate&&!status.gate.passed)window.console?.warn('LiteLLM 补丁闸门未通过：'+(status.gate.reasons||[]).join('；'));
      clearTimeout(litellmBusyTimer);
      if(busy)litellmBusyTimer=setTimeout(()=>loadLitellm(),2500);
      return status;
    }catch(e){
      litellmVersionLine.textContent='安装版本：无法读取';
      window.console?.warn('LiteLLM 状态读取失败：'+e.message);
      return null;
    }
  }
  // One-step: press = POST the upgrade with the outage acknowledgement filled by the page itself
  // (the user's button press IS the authorisation; the backend gate/triple-check/rollback chain is
  // untouched and its 400/409 reason lands on the API readout — UI-008 keeps it off the card).
  async function startLitellmUpgrade(btn){
    if(litellmInFlight||!litellmTarget)return;
    litellmInFlight=true;
    btn.disabled=true;btn.textContent='升级中';btn.classList.toggle('update-ready',false);
    try{await call('/litellm/upgrade',{method:'POST',body:JSON.stringify({acknowledgeOutage:true,targetVersion:litellmTarget})});litellmInFlight=false;await loadLitellm();}
    catch(e){litellmInFlight=false;window.console?.warn('LiteLLM 升级失败：'+e.message);await loadLitellm(true);}
  }
  const sparkdashVersionLine=document.querySelector('#sparkdash-version');
  const upgradeSparkdashSlot=document.querySelector('#upgrade-sparkdash-slot');
  let sparkdashTarget=null,sparkdashBusyTimer=null,sparkdashUpgradeReady=false,sparkdashInFlight=false;
  const sparkdashShort=value=>value?value.slice(0,7):'—';
  async function loadSparkdash(force=false){
    try{
      const status=await call('/sparkdash'+(force?'?refresh=1':''));
      // UI-006: SparkDash has no release channel — the card shows the git tag version (语义映射
      // via describe/tags), with an honest short-sha fallback when HEAD carries no tag.
      sparkdashVersionLine.textContent='安装版本：'
        +(status.deployed?(status.localTagVersion||('未标记 commit '+sparkdashShort(status.local&&status.local.commit))):'未部署');
      const busy=['installing','restarting'].includes(status.state);
      sparkdashTarget=status.updateAvailable?status.upstreamHead:null;
      sparkdashUpgradeReady=Boolean(status.canUpgrade);
      if(!sparkdashInFlight){
        if(busy)renderUpgradeButton(upgradeSparkdashSlot,{id:'upgrade-sparkdash',label:'升级中',disabled:true});
        else if(status.updateAvailable)renderUpgradeButton(upgradeSparkdashSlot,{id:'upgrade-sparkdash',label:'升级到 '+(status.upstreamTagVersion||sparkdashShort(status.upstreamHead)),ready:sparkdashUpgradeReady,onClick:startSparkdashUpgrade});
        else renderUpgradeButton(upgradeSparkdashSlot,null);
      }
      // UI-008 strict face: upstream probe failures and gate reasons stay in the API readouts
      // (status.upstreamError, status.gate.reasons, notes) — nothing renders on the card.
      if(status.upstreamError)window.console?.warn('SparkDash 上游探测失败：'+status.upstreamError);
      if(status.updateAvailable&&status.gate&&!status.gate.passed)window.console?.warn('SparkDash 升级闸门未通过：'+(status.gate.reasons||[]).join('；'));
      clearTimeout(sparkdashBusyTimer);
      if(busy)sparkdashBusyTimer=setTimeout(()=>loadSparkdash(),2500);
      return status;
    }catch(e){
      sparkdashVersionLine.textContent='安装版本：无法读取';
      window.console?.warn('SparkDash 状态读取失败：'+e.message);
      return null;
    }
  }
  // One-step (mirrors litellm): the outage acknowledgement is filled by the page from the button
  // press; the commit-paste confirmation leg of UI-002 is retired per the 2026-11-15 user order.
  // targetCommit still must equal the live upstream HEAD — that check lives in the backend.
  async function startSparkdashUpgrade(btn){
    if(sparkdashInFlight||!sparkdashTarget)return;
    sparkdashInFlight=true;
    btn.disabled=true;btn.textContent='升级中';btn.classList.toggle('update-ready',false);
    try{await call('/sparkdash/upgrade',{method:'POST',body:JSON.stringify({acknowledgeOutage:true,targetCommit:sparkdashTarget})});sparkdashInFlight=false;await loadSparkdash();}
    catch(e){sparkdashInFlight=false;window.console?.warn('SparkDash 升级失败：'+e.message);await loadSparkdash(true);}
  }
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
    loadModels().then(()=>load());loadAudit();loadRelease();loadRuntimeVersions();loadLitellm();loadSparkdash();setInterval(()=>{load();if(auditBefore===null&&!auditRows.querySelector('details[open]'))loadAudit();},4000);setInterval(()=>{loadRelease();if(!dshUpgradePending)loadRuntimeVersions();loadLitellm();loadSparkdash();},60000);
})();
</script>
</body>
</html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}
