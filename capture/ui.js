/* DOM-only extension editor. Never inserts captured text as HTML. */
'use strict';
const $ = id => document.getElementById(id);
const C = AioCapture;
let state, storageKey, config, busy = false, pendingUploads = 0, options = {}, persistQueue = Promise.resolve();
const DOUBAN_FIELDS = ['title','author','director','type','totalProgress','currentProgress','status','remark','rating','fileId'];
let sourcePendingUrl, sourceChangePromise;
function pickDouban(value) { return Object.fromEntries(DOUBAN_FIELDS.filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])])); }
function dirtyDouban() { return Object.fromEntries(DOUBAN_FIELDS.filter(key => state.fields[key] !== undefined && C.stableJSON(state.fields[key]) !== C.stableJSON(state.baseFields?.[key])).map(key => [key, structuredClone(state.fields[key])])); }
const statuses = [['not_started', '未开始'], ['in_progress', '进行中'], ['completed', '已完成'], ['on_hold', '搁置']];
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value != null && value !== false) { if (key in node && key !== 'list') node[key] = value; else node.setAttribute(key, value === true ? '' : value); }
  }
  for (const child of children.flat()) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function message(value, error = false) { $('messages').textContent = value; $('messages').dataset.error = String(error); }
async function call(payload) { let result; try { result = await chrome.runtime.sendMessage(payload); } catch (error) { error.uncertain = payload.type === 'CAPTURE_API' && payload.path?.endsWith('/commit'); throw error; } if (!result?.success) { const error = new Error(result?.error || '扩展后台未响应，请重新加载插件'); error.uncertain = Boolean(result?.uncertain); throw error; } return result.data; }
async function api(path, body) { return call({type: 'CAPTURE_API', path, method: body ? 'POST' : 'GET', body, scope: state.scope}); }
function persist() {
  const snapshot = structuredClone(state);
  persistQueue = persistQueue.catch(() => {}).then(() => chrome.storage.local.set({[storageKey]: snapshot}));
  return persistQueue;
}
function change() { if (state.kind === 'purchase' && state.result) return; state.result = null; $('result').hidden = true; persist().catch(error => message('草稿保存失败：' + error.message, true)); updateSaveState(); }
function setBusy(value, label) { busy = value; $('preview').disabled = value; $('commit').disabled = value || !state.preview; $('discard').disabled = value; $('capture-form').setAttribute('aria-busy', String(value)); $('editor').inert = value || Boolean(state.kind === 'purchase' && (state.result || state.uncertain)); if (label) message(label); updateSaveState(); }
function updateSaveState() {
  if (!state) return;
  let valid = Boolean(state.preview) && sourcePendingUrl === undefined;
  try { valid = valid && state.previewFingerprint === C.stableJSON(previewRequest()); } catch { valid = false; }
  const saved = state.kind === 'purchase' && Boolean(state.result);
  $('editor').inert = busy || saved || Boolean(state.uncertain);
  $('commit').disabled = busy || pendingUploads > 0 || saved || !valid;
  $('preview').disabled = busy || pendingUploads > 0 || saved || Boolean(state.uncertain);
  $('commit').textContent = saved ? '已保存' : state.uncertain ? '核实后按原请求重试' : '确认保存';
  $('save-hint').textContent = state.kind === 'purchase' ? saved ? '本草稿已保存，已禁用重复提交。重新采集前请先核对设备／衣柜，避免重复。' : state.uncertain ? '上次提交结果不确定，请先到设备／衣柜核实。只在确认需要重试时使用原请求，超过 24 小时不要重试。' : '选择要创建设备或衣物的商品，检查后确认保存。商品信息只用于填充现有设备／衣柜。' : valid ? '请核对修改内容；提交使用短期请求保护，超时后先核实结果。' : '填写信息后点击“预览与查重”，再确认保存。';
}
function optionPairs(name) { return (options[name] || []).map(row => [String(row.id), row.name]); }
function field(target, key, label, {type = 'text', values, required = false, wide = false, disabled = false, min, max, step, onchange, placeholder} = {}) {
  const input = values ? el('select', {disabled, required}, values.map(([value, title]) => el('option', {value}, title))) : el(type === 'textarea' ? 'textarea' : 'input', {type: type === 'textarea' ? undefined : type, required, disabled, min, max, step, placeholder});
  input.value = target[key] == null ? '' : String(target[key]); input.dataset.field = key;
  input.addEventListener(values ? 'change' : 'input', () => { target[key] = values && typeof values[0]?.[0] === 'number' ? Number(input.value) : type === 'number' ? (input.value === '' ? undefined : Number(input.value)) : input.value; change(); if (onchange) onchange(input.value); });
  return el('label', {class: `field${wide ? ' wide' : ''}`}, el('span', {}, label), input);
}
function panel(title, ...children) { return el('section', {class: 'panel'}, el('h2', {}, title), ...children); }
function fields(...children) { return el('div', {class: 'fields'}, ...children); }
function warningList(values) { $('warnings').hidden = !values.length; $('warnings').replaceChildren(el('ul', {}, values.map(value => el('li', {}, value)))); }
function showResult(value) {
  const messages = {created: '已新增', updated: '已更新', existing: '已存在，未重复创建'};
  const node = $('result'); node.hidden = false;
  node.replaceChildren(el('strong', {}, messages[value.operation] || '保存成功'));
  if (value.warnings?.length) node.append(el('ul', {class: 'small'}, value.warnings.map(warning => el('li', {}, warning))));
  if (state.kind === 'douban') node.append(el('p', {}, `${value.mediaType === 'book' ? '阅读' : '观影'}记录：${value.id}`));
  else {
    node.append(el('p', {}, `已创建 ${value.assets?.length || 0} 件物品`), el('ul', {}, (value.assets || []).map(asset => el('li', {}, `${asset.kind === 'device' ? '设备' : '衣物'} · ${asset.id}`))));
    node.append(el('p', {class: 'small'}, '请到设备／衣柜查看。本草稿已锁定；如需再次采集，请先核实已有物品，再清除本地草稿重新操作。'));
  }
}
function imageControl(target, imageUrl, bizType, existing = false) {
  const summary = el('p', {class: 'small'}), box = el('div', {class: 'image-control'});
  const refresh = () => { summary.textContent = target.fileId ? '图片已上传，保存时关联' : target.fileId === '' ? '将不使用图片' : existing ? '保留原图片；可选择替换' : '图片尚未保存。可下载来源图片、上传本地图片，或无图保存。'; };
  const allowed = value => { try { const url = new URL(value); return url.protocol === 'https:' && ['doubanio.com', '360buyimg.com', 'alicdn.com', 'taobaocdn.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host)); } catch { return false; } };
  if (allowed(imageUrl)) { const image = el('img', {src: imageUrl, alt: '来源图片预览', referrerPolicy: 'no-referrer'}); image.addEventListener('error', () => image.hidden = true); box.append(image); }
  const download = el('button', {type: 'button', disabled: !allowed(imageUrl)}, '使用来源图片');
  const local = el('input', {type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': '上传本地图片'});
  async function upload(data) {
    pendingUploads++; updateSaveState();
    download.disabled = true; local.disabled = true; summary.textContent = '正在上传图片…';
    try { const result = await call({type: 'CAPTURE_UPLOAD', ...data, bizType, scope: state.scope}); if (!result?.id) throw new Error('图片接口未返回文件 ID'); target.fileId = String(result.id); change(); refresh(); }
    catch (error) { summary.textContent = `${error.message}。可重试、上传本地图片，或点击“无图保存”。`; }
    finally { pendingUploads--; updateSaveState(); download.disabled = !allowed(imageUrl); local.disabled = false; }
  }
  download.addEventListener('click', async () => {
    try { const origin = new URL(imageUrl).origin + '/*'; if (!await chrome.permissions.request({origins: [origin]})) throw new Error('未允许读取该图片域名'); await upload({url: imageUrl}); } catch (error) { summary.textContent = error.message; }
  });
  local.addEventListener('change', () => {
    const file = local.files[0]; if (!file) return;
    if (file.size > 10 * 1024 * 1024) { summary.textContent = '图片须小于 10 MB'; return; }
    const reader = new FileReader(); reader.onload = () => upload({dataUrl: reader.result}); reader.onerror = () => { summary.textContent = '无法读取本地图片'; }; reader.readAsDataURL(file);
  });
  box.append(el('div', {}, summary, el('div', {class: 'image-buttons'}, download, el('label', {class: 'file-label'}, '上传本地图片', local), el('button', {type: 'button', onclick: () => { target.fileId = ''; change(); refresh(); }}, '无图保存'))));
  refresh(); return box;
}
function normalizeDate(value) { return value ? value.replace('T', ' ').replace(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/, '$1:00') : undefined; }
function previewRequest() {
  if (state.kind === 'douban') return {url: state.draft.url, metadata: {title: state.fields.title, author: state.fields.author, director: state.fields.director, type: state.fields.type, totalProgress: state.fields.totalProgress, coverImgUrl: state.coverImgUrl}};
  const order = structuredClone(state.draft);
  for (const key of ['paidAmount', 'freight', 'discount']) { order[key] = C.money(order[key], true); }
  for (const key of ['paidAt', 'orderedAt']) order[key] = normalizeDate(order[key]);
  order.items = order.items.map(item => ({...item, quantity: item.quantity == null ? undefined : Number(item.quantity), paidAmount: C.money(item.paidAmount, true)}));
  return order;
}
function doubanEditor() {
  const f = state.fields, isBook = C.identify(state.draft.url)?.mediaType === 'book';
  const existing = state.preview?.existing;
  const sourceInput = el('input', {type: 'url', required: true, value: sourcePendingUrl ?? state.draft.url, 'data-field': 'url'});
  sourceInput.addEventListener('input', () => { sourcePendingUrl = sourceInput.value; updateSaveState(); });
  sourceInput.addEventListener('change', () => { switchDoubanSource().catch(error => message(error.message, true)); });
  const source = fields(el('label', {class: 'field wide'}, el('span', {}, '豆瓣详情页链接（更换条目会打开独立草稿）'), sourceInput));
  if (existing) source.append(field(state, 'action', `已收录 · ${existing.id}`, {values: [['update', '更新已有记录（保留未修改字段）'], ['create', '保留已有记录，不覆盖']]}));
  const meta = fields(
    field(f, 'title', '标题', {required: true, wide: true}),
    field(f, isBook ? 'author' : 'director', isBook ? '作者' : '导演'),
    field(f, 'type', '类型', {values: isBook ? [[1, '书籍']] : [[1, '电影'], [2, '电视剧'], [3, '纪录片'], [4, '综艺'], [5, '动漫']]}),
    field(f, 'status', '阅读／观影状态', {values: statuses}),
    field(f, 'totalProgress', isBook ? '总页数' : '总进度（电影分钟／电视剧集数）', {type: 'number', min: 0, step: 1}),
    field(f, 'currentProgress', isBook ? '当前页数' : '当前进度', {type: 'number', min: 0, step: 1})
  );
  if (!isBook) meta.append(field(f, 'rating', '我的评分（不使用豆瓣公共评分）', {values: [['', '未评分'], ['1', '1 星'], ['2', '2 星'], ['3', '3 星'], ['4', '4 星'], ['5', '5 星']]}));
  meta.append(field(f, 'remark', '备注', {type: 'textarea', wide: true}), imageControl(f, state.coverImgUrl, isBook ? 'read' : 'movie', Boolean(existing?.fields?.fileId)));
  return [panel('来源与收录状态', source), panel(isBook ? '阅读信息' : '观影信息', meta)];
}
function assetsFor(item, index) {
  const parent = el('div');
  const count = Number.isInteger(Number(item.quantity)) ? Math.min(100, Math.max(0, Number(item.quantity))) : 0;
  state.assetChoices[index] ||= [];
  for (let unit = 1; unit <= count; unit++) {
    const wrapper = el('div', {class: 'asset'});
    const choice = state.assetChoices[index][unit - 1] ||= {choice: 'none', fields: {name: item.title}};
    const detail = el('div');
    function renderDetails() {
      detail.replaceChildren();
      if (choice.choice === 'none') return;
      const kind = choice.choice;
      const f = choice.fields ||= {name: item.title};
      const grid = fields(field(f, 'name', '物品名称', {required: true, wide: true}));
      if (kind === 'device') grid.append(field(f, 'type', '设备类型', {values: [['', '未分类'], ...optionPairs('deviceTypes')]}), field(f, 'status', '设备状态', {values: [['', '未设置'], ...optionPairs('deviceStatuses')]}), field(f, 'remark', '设备备注', {type: 'textarea', wide: true}));
      else grid.append(field(f, 'categoryId', '衣物分类', {values: [['', '未分类'], ...optionPairs('wardrobeCategories')]}), field(f, 'brand', '品牌'), field(f, 'color', '颜色'), field(f, 'size', '尺码'), field(f, 'memo', '衣物备注', {type: 'textarea', wide: true}));
      grid.append(imageControl(f, item.imageUrl, kind === 'device' ? 'device' : 'wardrobe_item'));
      detail.append(grid);
    }
    wrapper.append(field(choice, 'choice', `第 ${unit} 件 · 保存为`, {values: [['none', '暂不录入'], ['device', '创建设备'], ['wardrobe', '加入衣柜']], onchange: () => { delete choice.id; renderDetails(); }}), detail);
    renderDetails(); parent.append(wrapper);
  }
  return parent;
}
function purchaseEditor() {
  const o = state.draft;
  const basics = fields(
    field(o, 'shopName', '店铺', {}),
    field(o, 'paidAmount', '订单实付金额（元）', {required: true, placeholder: '待确认；最多 2 位小数'}),
    field(o, 'paidAt', '付款时间（优先作为购买日期）', {type: 'datetime-local', step: 1}),
    field(o, 'orderedAt', '下单时间', {type: 'datetime-local', step: 1})
  );
  const result = [panel('购买信息', el('p', {class: 'small'}, `${o.platform === 'jd' ? '京东' : '淘宝'}${o.orderNo ? ' · 来源订单 ' + o.orderNo : ''}`), basics, el('p', {class: 'small'}, '购买日期优先采用付款日期，缺失时采用下单日期；请确认适用。商品与购买信息将用于创建设备／衣物。'))];
  o.items.forEach((item, index) => {
    const itemPanel = el('section', {class: 'panel'});
    itemPanel.append(el('div', {class: 'item-heading'}, el('h2', {}, `商品 ${index + 1}`), el('button', {type: 'button', class: 'quiet', onclick: () => { o.items.splice(index, 1); state.assetChoices.splice(index, 1); change(); render(); }}, '移除此行')));
    const assets = el('div');
    const grid = fields(
      field(item, 'title', '商品名称', {required: true, wide: true}),
      field(item, 'spec', '规格', {}),
      field(item, 'quantity', '购买数量', {type: 'number', min: 1, max: 100, step: 1, required: true, onchange: () => assets.replaceChildren(assetsFor(item, index))}),
      field(item, 'paidAmount', '本行全部商品实付（含运费／优惠分摊）', {required: true})
    );
    assets.append(assetsFor(item, index)); itemPanel.append(grid, assets); result.push(itemPanel);
  });
  result.push(el('div', {class: 'image-buttons'}, el('button', {type: 'button', onclick: () => { o.items.push({sourceItemId: `local:${crypto.randomUUID()}`, title: '', quantity: 1, paidAmount: ''}); change(); render(); }}, '添加商品行'), el('button', {type: 'button', onclick: () => {
    try { const allocations = C.allocate(o.paidAmount, o.items.map(item => item.paidAmount || '0')); o.items.forEach((item, index) => item.paidAmount = allocations[index]); state.amountConfirmed = false; change(); render(); message('已按现有行金额比例分摊（无金额时均分）。请核对商品实付，再勾选金额确认。'); } catch (error) { message(error.message, true); }
  }}, '分摊订单实付到各商品行')));
  const confirmation = el('input', {type: 'checkbox', checked: Boolean(state.amountConfirmed), required: true, onchange: event => { state.amountConfirmed = event.target.checked; change(); }});
  result.push(el('label', {class: 'check'}, confirmation, '我已核对购买日期、实付金额、数量及分摊结果，并确认所选物品需要新建到设备／衣柜。'));
  return result;
}
function render() {
  $('editor').replaceChildren(...(state.kind === 'douban' ? doubanEditor() : purchaseEditor()));
  warningList([...(state.warnings || []), ...(state.preview?.warnings || [])]);
  if (state.result) showResult(state.result); updateSaveState();
}
async function switchDoubanSource() {
  if (sourceChangePromise) return sourceChangePromise;
  if (sourcePendingUrl === undefined) return;
  const identity = C.identify(sourcePendingUrl);
  if (!identity || identity.kind !== 'douban') throw new Error('请填写豆瓣书籍或影视详情页链接');
  if (identity.key === C.identify(state.draft.url)?.key) { sourcePendingUrl = undefined; render(); return; }
  sourceChangePromise = (async () => {
    setBusy(true, '正在切换条目草稿…');
    await persistQueue;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${state.scope}:${identity.key}`));
    const nextId = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    const nextKey = `capture:${nextId}`;
    const saved = (await chrome.storage.local.get(nextKey))[nextKey];
    const nextState = saved || {kind: 'douban', scope: state.scope, sourceKey: identity.key, warnings: [], draft: {url: identity.url, metadata: {}}, fields: {title: '', type: 1, status: 'not_started', currentProgress: 0, remark: ''}};
    state = nextState; storageKey = nextKey; sourcePendingUrl = undefined;
    history.replaceState(null, '', `?id=${nextId}`);
    await persist(); $('result').hidden = true; render(); message('已切换到独立条目草稿，请重新预览查重。');
  })();
  try { await sourceChangePromise; } finally { sourceChangePromise = undefined; setBusy(false); }
}
async function preview() {
  if (sourceChangePromise) { await sourceChangePromise; }
  if (sourcePendingUrl !== undefined) { try { await switchDoubanSource(); } catch (error) { message(error.message, true); return; } }
  if (busy || pendingUploads || (state.kind === 'purchase' && (state.result || state.uncertain))) return; setBusy(true, state.kind === 'douban' ? '正在解析并查重…' : '正在检查商品信息…');
  try {
    const localChanges = state.kind === 'douban' && state.baseFields ? dirtyDouban() : {};
    const request = previewRequest();
    const response = await api(`/capture/${state.kind}/preview`, request);
    state.preview = response;
    if (state.kind === 'douban') {
      const baseline = pickDouban(response.existing?.fields || {...state.fields, ...response.draft});
      state.baseFields = structuredClone(baseline);
      state.fields = {...baseline, ...localChanges};
      state.coverImgUrl = response.draft.coverImgUrl || state.coverImgUrl;
      if (!state.didPreview) state.action = response.existing ? 'update' : 'create';
      state.didPreview = true;
    }
    state.previewFingerprint = C.stableJSON(previewRequest());
    await persist(); render(); message(state.kind === 'purchase' ? '商品信息检查完成，请选择要创建的设备／衣物并确认保存。' : response.existing ? '已找到已有记录，请检查现有状态后保存。' : '查重完成，尚未创建记录。请确认后保存。');
  } catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
function commitPayload() {
  if (state.kind === 'douban') {
    const existing = state.preview.existing;
    const fields = existing && state.action === 'update' ? dirtyDouban() : pickDouban(state.fields);
    if (!state.fields.title?.trim()) throw new Error('请填写标题');
    if (state.fields.currentProgress != null && state.fields.totalProgress != null && Number(state.fields.currentProgress) > Number(state.fields.totalProgress)) throw new Error('当前进度不能大于总进度');
    if (fields.rating !== undefined) fields.rating = fields.rating === '' || fields.rating === null ? null : Number(fields.rating);
    return {url: state.draft.url, action: state.action || 'create', ...(existing ? {existingId: String(existing.id), version: existing.version} : {}), fields};
  }
  const order = previewRequest(); C.validateOrder(order);
  if (!state.amountConfirmed) throw new Error('请勾选金额和订单信息确认');
  const assets = [];
  order.items.forEach((item, index) => {
    for (let unit = 1; unit <= item.quantity; unit++) {
      const choice = state.assetChoices[index]?.[unit - 1]; if (!choice || choice.choice === 'none') continue;
      const kind = choice.choice;
      if (!['device', 'wardrobe'].includes(kind)) throw new Error('请选择设备或衣柜');
      const fields = {...choice.fields};
      for (const key of ['categoryId', 'type', 'status']) if (fields[key] === '') delete fields[key];
      assets.push({sourceItemId: item.sourceItemId, unitIndex: unit, kind, fields});
    }
  });
  if (!assets.length) throw new Error('请至少选择一件商品创建设备或加入衣柜');
  return {order, amountConfirmed: true, assets};
}
async function commit(event) {
  event.preventDefault(); if (busy || pendingUploads || (state.kind === 'purchase' && state.result)) return;
  let dispatched = false;
  try {
    if (sourcePendingUrl !== undefined || !state.preview || state.previewFingerprint !== C.stableJSON(previewRequest())) throw new Error(state.kind === 'purchase' ? '商品信息已修改，请重新检查' : '信息已修改，请重新预览与查重');
    const payload = commitPayload();
    if (state.uncertain && state.submission?.fingerprint !== C.stableJSON(payload)) throw new Error('上次结果不确定，不能修改内容后换请求标识重试；请先核实设备／衣柜');
    state.submission = C.submission(state.submission, payload);
    state.submission.startedAt ||= Date.now();
    if (Date.now() - state.submission.startedAt >= 24 * 60 * 60 * 1000) throw new Error('本次请求已超过 24 小时，请先核实是否已创建物品，不要直接重试。确认后可清除草稿重新采集');
    // Persist the key before dispatch, so re-opening after timeout reuses it.
    state.uncertain = true;
    setBusy(true, '正在保存，请勿重复操作…'); await persist();
    dispatched = true;
    const result = await api(`/capture/${state.kind}/commit`, {...payload, idempotencyKey: state.submission.key});
    if (state.kind === 'douban' ? !result?.id : !Array.isArray(result?.assets) || !result.assets.length || result.assets.some(asset => !asset.id)) { const error = new Error('服务未返回完整记录 ID，保存结果不确定，请先到 AIO Life 核实'); error.uncertain = true; throw error; }
    state.uncertain = false;
    state.result = result;
    if (state.kind === 'douban') { state.baseFields = pickDouban(state.fields); state.previewFingerprint = null; }
    await persist(); showResult(result); message('保存成功，记录已写入 AIO Life。');
  } catch (error) {
    if (dispatched && (error.uncertain || /超时|timeout|Failed to fetch|NetworkError|结果不确定|无法确认.*提交|结果待确认|正在处理|处理中/i.test(error.message))) { state.uncertain = true; await persist(); message(error.message + '。保存结果不确定，请先核实已有记录；不会自动重试。', true); }
    else { if (dispatched) { state.uncertain = false; await persist(); } message(error.message, true); }
  }
  finally { setBusy(false); }
}
async function init() {
  try {
    const id = new URL(location.href).searchParams.get('id');
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('草稿链接无效，请从需要采集的页面点击插件');
    storageKey = `capture:${id}`;
    state = (await chrome.storage.local.get(storageKey))[storageKey];
    if (!state) throw new Error('草稿已清除，请回到源页面重新采集');
    config = await call({type: 'CAPTURE_CONFIG_GET'});
    if (state.scope !== config.scope) throw new Error('连接账号或服务已变化，请回到源页面重新采集；旧草稿不会发送给新账号');
    if (state.kind === 'douban') {
      state.fields ||= {...state.draft.metadata, status: 'not_started', currentProgress: 0, remark: ''}; state.fields.type ||= 1;
      state.coverImgUrl ||= state.draft.metadata.coverImgUrl; delete state.fields.coverImgUrl;
    } else {
      state.assetChoices ||= [];
      if (state.captureVersion !== 2) {
        delete state.expense;
        state.preview = null; state.previewFingerprint = null;
        state.assetChoices = state.assetChoices.map(row => row.map(choice => ({...choice, choice: choice.choice?.endsWith(':create') ? choice.choice.split(':')[0] : ['device', 'wardrobe'].includes(choice.choice) ? choice.choice : 'none'})));
        state.captureVersion = 2;
      }
      const seen = new Set();
      state.draft.items.forEach((item, index) => { if (!item.sourceItemId || seen.has(item.sourceItemId)) item.sourceItemId = `local:${index}:${crypto.randomUUID()}`; seen.add(item.sourceItemId); });
      state.warnings = (state.warnings || []).filter(warning => !/明细标识|账单|支出/.test(warning));
    }
    $('page-title').textContent = state.kind === 'douban' ? '豆瓣书影音 · 入库预览' : `${state.draft.platform === 'jd' ? '京东' : '淘宝'}商品 · 录入设备／衣柜`;
    $('source-description').textContent = state.kind === 'douban' ? '先核对采集内容，再查重与保存。' : '核对商品信息，选择需要创建的设备或衣物，再确认保存。';
    $('preview').textContent = state.kind === 'douban' ? '预览与查重' : '检查商品信息';
    $('preview').addEventListener('click', preview); $('capture-form').addEventListener('submit', commit);
    $('discard').addEventListener('click', async () => { if (confirm(state.kind === 'purchase' ? '清除草稿后重新采集会产生新请求，不能依靠订单号防止重复。请先到设备／衣柜核实是否已保存，再清除。已保存物品不会删除。' : '清除当前本地草稿？已保存的 AIO Life 记录不会删除。')) { await persistQueue; await chrome.storage.local.remove(storageKey); location.reload(); } });
    render();
    if (!config.configured) { message('请先在工具栏插件的连接设置中配置 Token，然后重新采集。', true); return; }
    if (state.kind === 'purchase') {
      try { options = await api('/capture/options'); render(); } catch (error) { message('分类选项加载失败：' + error.message + '。可以先填写草稿；刷新页面后重试。', true); }
    }
    if (state.result) showResult(state.result);
    else if (state.uncertain) message('上次保存结果不确定，请先到 AIO Life 核实记录；不会自动重试。', true);
    else if (!state.preview && state.kind === 'douban') await preview();
  } catch (error) { message(error.message, true); $('page-title').textContent = '无法打开采集草稿'; $('capture-form').hidden = true; }
}
init();
