/* DOM-only extension editor. Never inserts captured text as HTML. */
'use strict';
const $ = id => document.getElementById(id);
const C = AioCapture;
let state, config, busy = false, pendingUploads = 0, options = {};
const productImages = new Map();
const DOUBAN_FIELDS = ['title','author','director','type','totalProgress','currentProgress','status','remark','rating','fileId'];
let sourcePendingUrl, sourceChangePromise, savedReadError = '';
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
// Keep only navigation identifiers in the URL; all business fields come from the server.
function updateLocation(pending = false) {
  const params = new URLSearchParams({scope: state.scope});
  if (pending) params.set('pending', '1');
  else if (state.kind === 'purchase' && state.result) {
    for (const asset of state.result.assets) params.append('asset', `${asset.kind}:${asset.id}`);
  } else if (state.kind === 'douban') params.set('source', state.draft.url);
  else { history.replaceState(null, '', location.pathname); return; }
  history.replaceState(null, '', location.pathname + '#' + params);
}
function stateFromLocation() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('pending')) throw new Error('上次提交结果尚未确认，请先到 AIO Life 核实；不会自动重新提交。');
  if (params.has('asset')) {
    const assets = params.getAll('asset').map(value => {
      const match = /^(device|wardrobe):(\d{1,30})$/.exec(value);
      if (!match) throw new Error('物品链接无效');
      return {kind: match[1], id: match[2]};
    });
    if (assets.length > 500) throw new Error('物品数量超出限制');
    return {kind: 'purchase', scope: params.get('scope'), draft: {items: []}, assetChoices: [], warnings: [], result: {assets}};
  }
  if (params.has('source')) {
    const identity = C.identify(params.get('source'));
    if (identity?.kind !== 'douban') throw new Error('来源链接无效');
    return {kind: 'douban', scope: params.get('scope'), draft: {url: identity.url, metadata: {}}, warnings: []};
  }
  return null;
}
function editingSaved() { return state.kind === 'purchase' && Boolean(state.result) && Array.isArray(state.assetEdits); }
function change() { if (editingSaved()) { updateSaveState(); return; } if (state.kind === 'purchase' && state.result) return; state.result = null; $('result').hidden = true; updateSaveState(); }
function setBusy(value, label) { busy = value; $('preview').disabled = value; $('commit').disabled = value || !state.preview; $('capture-form').setAttribute('aria-busy', String(value)); $('editor').inert = value || Boolean(state.kind === 'purchase' && (state.result || state.uncertain)); if (label) message(label); updateSaveState(); }
function updateSaveState() {
  if (!state) return;
  let valid = Boolean(state.preview) && sourcePendingUrl === undefined;
  try { valid = valid && state.previewFingerprint === C.stableJSON(previewRequest()); } catch { valid = false; }
  const saved = state.kind === 'purchase' && Boolean(state.result);
  const hasExisting = Boolean(state.existingAssets?.length);
  $('remaining-assets').hidden = !saved || !state.draft.items.some(item => Array.from({length: Number(item.quantity) || 0}, (_, i) => i + 1).some(unit => !existingAsset(item, unit)));
  $('remaining-assets').disabled = busy || pendingUploads > 0;
  $('edit-saved').hidden = !saved && !hasExisting;
  $('edit-saved').disabled = busy || pendingUploads > 0;
  $('edit-saved').textContent = !saved && hasExisting ? '查看已保存物品' : editingSaved() ? '重新读取物品' : '重试读取物品';
  if (editingSaved()) {
    $('editor').inert = busy;
    $('commit').disabled = busy || pendingUploads > 0 || !state.assetEdits.some(edit => Object.keys(assetChanges(edit)).length);
    $('commit').textContent = '保存修改';
    $('preview').disabled = true;
    $('save-hint').textContent = '修改已创建的物品；来源订单及物品归属保持不变。';
    return;
  }
  $('editor').inert = busy || saved || Boolean(state.uncertain);
  $('commit').disabled = busy || pendingUploads > 0 || saved || (state.kind === 'douban' && !valid);
  $('preview').disabled = busy || pendingUploads > 0 || saved || Boolean(state.uncertain);
  $('commit').textContent = saved ? '已保存' : state.uncertain ? '核实后按原请求重试' : '确认保存';
  $('save-hint').textContent = state.kind === 'purchase' ? saved ? '物品已保存，读取当前信息后即可继续修改。' : state.uncertain ? '上次提交结果不确定，请先到设备／衣柜核实。只在确认需要重试时使用原请求，超过 24 小时不要重试。' : '' : valid ? '' : '修改后请重新预览。';
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
  const messages = {created: '已新增', updated: '已更新', existing: '已存在，未重复创建', mixed: '已保存，已有物品未重复创建'};
  const node = $('result'); node.hidden = !value.operation;
  if (!value.operation) return;
  node.replaceChildren(el('strong', {}, messages[value.operation] || '保存成功'));
  if (value.warnings?.length) node.append(el('ul', {class: 'small'}, value.warnings.map(warning => el('li', {}, warning))));
  if (state.kind === 'douban') node.append(el('p', {}, `${value.mediaType === 'book' ? '阅读' : '观影'}记录：${value.id}`));
  else {
    node.append(el('p', {}, `新增 ${value.createdCount ?? (value.operation === 'created' ? value.assets?.length || 0 : 0)} 件，已有 ${value.existingCount ?? (value.operation === 'existing' ? value.assets?.length || 0 : 0)} 件`), el('ul', {}, (value.assets || []).map(asset => el('li', {}, `${asset.kind === 'device' ? '设备' : '衣物'} · ${asset.id}`))));

  }
}
function imageControl(target, imageUrl, bizType, existing = false, purchase) {
  const summary = el('p', {class: 'small', role: 'status'}), box = el('div', {class: 'image-control'});
  const allowed = value => { try { const url = new URL(value); return url.protocol === 'https:' && ['doubanio.com', '360buyimg.com', 'alicdn.com', 'taobaocdn.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host)); } catch { return false; } };
  const image = el('img', {alt: '封面预览', referrerPolicy: 'no-referrer', hidden: true});
  let selectedUrl = purchase?.choice.coverUrl ?? imageUrl, working = false;
  const gallery = el('div', {class: 'cover-gallery', role: 'group', 'aria-label': '封面候选'});
  function refresh() {
    summary.textContent = target.fileId ? '封面已上传' : target.fileId === '' ? '将不使用图片' : existing ? '保留原图片' : '可选图片';
    image.hidden = Boolean(purchase) || target.fileId === '' || !allowed(selectedUrl);
    if (!image.hidden) image.src = selectedUrl;
    for (const button of gallery.querySelectorAll('button')) button.setAttribute('aria-pressed', String(Boolean(target.fileId) && button.dataset.url === selectedUrl));
  }
  image.addEventListener('error', () => image.hidden = true);
  const download = el('button', {type: 'button', disabled: !allowed(imageUrl)}, purchase ? '使用订单图片' : '使用来源图片');
  const local = el('input', {type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': '上传本地图片'});
  async function run(label, task) {
    if (working || busy || (state.kind === 'purchase' && ((state.result && !editingSaved()) || state.uncertain))) return;
    working = true; pendingUploads++; updateSaveState();
    box.setAttribute('aria-busy', 'true');
    for (const control of box.querySelectorAll('button, input')) control.disabled = true;
    summary.textContent = label;
    try { await task(); }
    catch (error) { summary.textContent = error.message; }
    finally {
      working = false; pendingUploads--; updateSaveState(); box.setAttribute('aria-busy', 'false');
      for (const control of box.querySelectorAll('button, input')) control.disabled = false;
      download.disabled = !allowed(imageUrl);
    }
  }
  async function upload(data) {
    if (data.url) {
      const origin = new URL(data.url).origin + '/*';
      if (!await chrome.permissions.request({origins: [origin]})) throw new Error('未允许读取该图片域名，可重试或上传本地图片');
    }
    const result = await call({type: 'CAPTURE_UPLOAD', ...data, bizType, scope: state.scope});
    if (!result?.id) throw new Error('图片接口未返回文件 ID');
    // The user may remove the item or change its target while the upload is in flight.
    if (!box.isConnected || (purchase && purchase.choice.choice !== (bizType === 'device' ? 'device' : 'wardrobe'))) return;
    target.fileId = String(result.id); selectedUrl = data.url;
    if (purchase) purchase.choice.coverUrl = data.url || '';
    change(); refresh();
  }
  download.addEventListener('click', () => run('正在上传订单／来源图片…', () => upload({url: imageUrl})));
  local.addEventListener('change', () => {
    const file = local.files[0]; if (!file) return;
    if (file.size > 10 * 1024 * 1024) { summary.textContent = '图片须小于 10 MB'; local.value = ''; return; }
    run('正在上传图片…', async () => {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取本地图片')); reader.readAsDataURL(file);
      });
      await upload({dataUrl});
    }).finally(() => { local.value = ''; });
  });
  const buttons = el('div', {class: 'image-buttons'}, ...(purchase ? [] : [download]));
  let productStatus;
  function showGallery(images = []) {
    const candidates = [];
    if (allowed(imageUrl)) candidates.push({url: imageUrl, label: '订单图'});
    images.forEach((url, index) => { if (allowed(url) && !candidates.some(item => item.url === url)) candidates.push({url, label: `商品图 ${index + 1}`}); });
    if (target.fileId && allowed(selectedUrl) && !candidates.some(item => item.url === selectedUrl)) candidates.push({url: selectedUrl, label: '已选封面'});
    gallery.replaceChildren(...candidates.map(({url, label}) => {
      const thumb = el('img', {src: url, alt: '', referrerPolicy: 'no-referrer'});
      const button = el('button', {type: 'button', disabled: working, 'aria-label': `使用${label}`, 'data-url': url, onclick: () => run('正在上传封面…', () => upload({url}))}, thumb, el('span', {}, label));
      thumb.addEventListener('error', () => { thumb.hidden = true; button.querySelector('span').textContent = `${label}加载失败`; });
      return button;
    }));
    refresh();
    if (working) summary.textContent = '正在上传封面…';
  }
  if (purchase) showGallery();
  if (purchase && state.draft.platform === 'jd' && /^\d{1,30}$/.test(purchase.item.sku || '')) {
    const sku = purchase.item.sku;
    productStatus = el('p', {class: 'small', role: 'status'});
    const product = el('button', {type: 'button', hidden: true}, '允许读取商品图片');
    const placeholder = el('span', {class: 'cover-placeholder'}, '正在读取商品图片…');
    let loading = false;
    async function loadImages(requestPermission = false) {
      if (loading) return;
      loading = true; product.disabled = true;
      productStatus.textContent = ''; gallery.setAttribute('aria-busy', 'true');
      gallery.append(placeholder);
      try {
        const permission = {origins: ['https://item.jd.com/*']};
        const granted = requestPermission ? await chrome.permissions.request(permission) : await chrome.permissions.contains(permission);
        if (!box.isConnected) return;
        if (!granted) {
          product.textContent = '允许读取商品图片'; product.hidden = false;
          productStatus.textContent = '允许读取京东商品页后，商品图片会与订单图一起展示。';
          return;
        }
        product.hidden = true;
        let request = productImages.get(sku);
        if (!request) {
          request = call({type: 'CAPTURE_JD_IMAGES', sku}).then(result => {
            const images = [...new Set((result?.images || []).filter(allowed))];
            if (!images.length) throw new Error('未读取到商品主图，请打开商品页后重试');
            return images;
          }).catch(error => { productImages.delete(sku); throw error; });
          productImages.set(sku, request);
        }
        const images = await request;
        if (box.isConnected) showGallery(images);
      } catch (error) {
        if (!box.isConnected) return;
        productStatus.textContent = error.message;
        product.textContent = '重试读取商品图片'; product.hidden = false;
      } finally {
        loading = false; product.disabled = false; placeholder.remove(); gallery.setAttribute('aria-busy', 'false');
      }
    }
    product.addEventListener('click', () => loadImages(true));
    buttons.append(product, el('a', {href: `https://item.jd.com/${sku}.html`, target: '_blank', rel: 'noopener noreferrer', class: 'product-link'}, '打开商品页'));
    // Start after the newly rendered control is attached; concurrent units share one request.
    Promise.resolve().then(() => { if (box.isConnected) return loadImages(); });
  }
  buttons.append(el('label', {class: 'file-label'}, '上传本地图片', local), el('button', {type: 'button', onclick: () => {
    target.fileId = ''; if (purchase) delete purchase.choice.coverUrl; change(); refresh();
  }}, '无图保存'));
  if (!purchase) box.append(image);
  box.append(el('div', {}, summary, ...(purchase ? [gallery, productStatus, buttons] : [buttons])));
  refresh(); return box;
}
function normalizeDate(value) { return value ? value.replace('T', ' ').replace(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/, '$1:00') : undefined; }
function previewRequest() {
  if (state.kind === 'douban') return {url: state.draft.url, metadata: {title: state.fields.title, author: state.fields.author, director: state.fields.director, type: state.fields.type, totalProgress: state.fields.totalProgress, coverImgUrl: state.coverImgUrl}};
  const occurrences = new Map();
  for (const item of state.draft.items) {
    if (!item.sku) continue;
    const base = `sku:${item.sku}|spec:${item.spec || ''}`;
    const occurrence = (occurrences.get(base) || 0) + 1; occurrences.set(base, occurrence);
    if (/^(local|line):/.test(item.sourceItemId || '')) item.sourceItemId = `${base}|row:${occurrence}`;
  }
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
  const source = fields(el('label', {class: 'field wide'}, el('span', {}, '豆瓣链接'), sourceInput));
  if (existing) source.append(field(state, 'action', `已收录 · ${existing.id}`, {values: [['update', '更新已有记录（保留未修改字段）'], ['create', '保留已有记录，不覆盖']]}));
  const meta = fields(
    field(f, 'title', '标题', {required: true, wide: true}),
    field(f, isBook ? 'author' : 'director', isBook ? '作者' : '导演'),
    field(f, 'type', '类型', {values: isBook ? [[1, '书籍']] : [[1, '电影'], [2, '电视剧'], [3, '纪录片'], [4, '综艺'], [5, '动漫']]}),
    field(f, 'status', '阅读／观影状态', {values: statuses}),
    field(f, 'totalProgress', isBook ? '总页数' : '总进度（电影分钟／电视剧集数）', {type: 'number', min: 0, step: 1}),
    field(f, 'currentProgress', isBook ? '当前页数' : '当前进度', {type: 'number', min: 0, step: 1})
  );
  if (!isBook) meta.append(field(f, 'rating', '我的评分', {values: [['', '未评分'], ['1', '1 星'], ['2', '2 星'], ['3', '3 星'], ['4', '4 星'], ['5', '5 星']]}));
  meta.append(field(f, 'remark', '备注', {type: 'textarea', wide: true}), imageControl(f, state.coverImgUrl, isBook ? 'read' : 'movie', Boolean(existing?.fields?.fileId)));
  return [panel('来源与收录状态', source), panel(isBook ? '阅读信息' : '观影信息', meta)];
}
function existingAsset(item, unit) {
  return state.existingAssets?.find(asset => asset.sourceItemId === item.sourceItemId && asset.unitIndex === unit);
}
async function lookupPurchaseAssets() {
  setBusy(true, '正在查询已保存物品…');
  try {
    const response = await api('/capture/purchase/preview', previewRequest());
    state.preview = response;
    state.existingAssets = response.existingAssets || [];
    if (state.existingAssets.length) {
      state.result = {operation: 'existing', assets: state.existingAssets, existingCount: state.existingAssets.length, createdCount: 0};
      updateLocation();
    }
    render(); message('');
  } catch (error) { message('查询已保存物品失败：' + error.message + '。请核对订单信息后保存，服务器会再次查重。', true); }
  finally { setBusy(false); }
}
function assetsFor(item, index) {
  const parent = el('div');
  const count = Number.isInteger(Number(item.quantity)) ? Math.min(100, Math.max(0, Number(item.quantity))) : 0;
  state.assetChoices[index] ||= [];
  for (let unit = 1; unit <= count; unit++) {
    const wrapper = el('div', {class: 'asset'});
    const existing = existingAsset(item, unit);
    if (existing) { parent.append(el('p', {class: 'small'}, `第 ${unit} 件已录入${existing.kind === 'device' ? '设备' : '衣柜'} · ${existing.id}`)); continue; }
    const choice = state.assetChoices[index][unit - 1] ||= {choice: 'none', fields: {name: item.title}};
    const detail = el('div');
    function renderDetails() {
      detail.replaceChildren();
      if (choice.choice === 'none') return;
      const kind = choice.choice;
      const f = choice.fields ||= {name: item.title};
      const grid = fields(field(f, 'name', '物品名称', {required: true, wide: true}));
      if (kind === 'device') grid.append(field(f, 'type', '设备类型', {values: [['', '未分类'], ...optionPairs('deviceTypes')]}), field(f, 'status', '设备状态', {values: [['', '未设置'], ...optionPairs('deviceStatuses')]}), field(f, 'remark', '设备备注', {type: 'textarea', wide: true}));
      else grid.append(field(f, 'categoryId', '衣物分类', {values: [['', '未分类'], ...optionPairs('wardrobeCategories')]}), field(f, 'brand', '品牌'), field(f, 'color', '颜色'), field(f, 'size', '尺码'), field(f, 'remark', '衣物备注', {type: 'textarea', wide: true}));
      grid.append(imageControl(f, item.imageUrl, kind === 'device' ? 'device' : 'wardrobe_item', false, {item, choice}));
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
    field(o, 'orderNo', '订单 ID', {required: true, disabled: Boolean(state.existingAssets?.length)}),
    field(o, 'shopName', '店铺', {}),
    field(o, 'paidAmount', '订单实付金额（元）', {required: true, placeholder: '待确认；最多 2 位小数'}),
    field(o, 'paidAt', '付款时间', {type: 'datetime-local', step: 1}),
    field(o, 'orderedAt', '下单时间', {type: 'datetime-local', step: 1})
  );
  const result = [panel('购买信息', el('p', {class: 'small'}, `${o.platform === 'jd' ? '京东' : '淘宝'}${o.orderNo ? ' · 来源订单 ' + o.orderNo : ''}`), basics, el('p', {class: 'small'}, '购买日期优先使用付款时间，否则使用下单时间。'))];
  o.items.forEach((item, index) => {
    const itemPanel = el('section', {class: 'panel'});
    itemPanel.append(el('div', {class: 'item-heading'}, el('h2', {}, `商品 ${index + 1}`), el('button', {type: 'button', class: 'quiet', onclick: () => { o.items.splice(index, 1); state.assetChoices.splice(index, 1); change(); render(); }}, '移除此行')));
    const assets = el('div');
    const grid = fields(
      field(item, 'sku', '商品 ID', {disabled: Boolean(state.existingAssets?.length)}),
      field(item, 'title', '商品名称', {required: true, wide: true}),
      field(item, 'spec', '规格', {}),
      field(item, 'quantity', '购买数量', {type: 'number', min: 1, max: 100, step: 1, required: true, onchange: () => assets.replaceChildren(assetsFor(item, index))}),
      field(item, 'paidAmount', '本行实付（含运费、优惠）', {required: true})
    );
    assets.append(assetsFor(item, index)); itemPanel.append(grid, assets); result.push(itemPanel);
  });
  result.push(el('div', {class: 'image-buttons'}, el('button', {type: 'button', onclick: () => { o.items.push({sourceItemId: `local:${crypto.randomUUID()}`, title: '', quantity: 1, paidAmount: ''}); change(); render(); }}, '添加商品行'), el('button', {type: 'button', onclick: () => {
    try { const allocations = C.allocate(o.paidAmount, o.items.map(item => item.paidAmount || '0')); o.items.forEach((item, index) => item.paidAmount = allocations[index]); change(); render(); message('已按现有行金额比例分摊（无金额时均分）。请核对商品实付后保存。'); } catch (error) { message(error.message, true); }
  }}, '分摊订单实付到各商品行')));
  return result;
}
const EDIT_FIELDS = {
  device: ['name', 'type', 'status', 'remark', 'fileId'],
  wardrobe: ['name', 'categoryId', 'brand', 'color', 'size', 'remark', 'fileId'],
};
function editableAssetFields(kind, value) {
  return Object.fromEntries(EDIT_FIELDS[kind].map(key => [key, value[key] == null ? '' : String(value[key])]));
}
function assetChanges(edit) {
  return Object.fromEntries(EDIT_FIELDS[edit.kind].filter(key => edit.fields[key] !== edit.base[key]).map(key => [key, edit.fields[key]]));
}
function assetMessage(type, asset, extra = {}) {
  return call({type, kind: asset.kind, id: asset.id, scope: state.scope, ...extra});
}
async function beginAssetEdits() {
  if (busy || pendingUploads) return;
  if (!state.result && state.existingAssets?.length) state.result = {operation: 'existing', assets: state.existingAssets};
  if (!state.result) return;
  if (editingSaved() && state.assetEdits.some(edit => Object.keys(assetChanges(edit)).length) && !confirm('重新读取会放弃尚未保存的修改，继续吗？')) return;
  savedReadError = '';
  setBusy(true, '正在读取已保存物品…'); render();
  try {
    const next = await Promise.all(state.result.assets.map(async asset => {
      const current = await assetMessage('CAPTURE_ASSET_GET', asset);
      if (!current?.id) throw new Error('物品已删除或无权访问');
      const index = state.draft.items.findIndex(item => item.sourceItemId === asset.sourceItemId);
      const original = state.assetEdits?.find(edit => edit.id === asset.id && edit.kind === asset.kind) || state.assetChoices[index]?.[asset.unitIndex - 1];
      const fields = editableAssetFields(asset.kind, current);
      return {...asset, choice: asset.kind, fields, base: structuredClone(fields), coverUrl: original?.fields?.fileId === fields.fileId ? original.coverUrl : ''};
    }));
    state.assetEdits = next; render(); message('可以修改物品信息和封面，完成后点击“保存修改”。');
  } catch (error) { savedReadError = '读取物品失败：' + error.message; render(); message(savedReadError, true); }
  finally { setBusy(false); }
}
function savedAssetsEditor() {
  return state.assetEdits.map((edit, index) => {
    const f = edit.fields;
    const values = (key, optionName, emptyLabel) => {
      const pairs = optionPairs(optionName);
      if (f[key] && !pairs.some(([id]) => id === f[key])) pairs.push([f[key], `当前值（${f[key]}）`]);
      // The wardrobe update contract cannot clear an existing category with null.
      return key === 'categoryId' && f[key] ? pairs : [['', emptyLabel], ...pairs];
    };
    const grid = fields(field(f, 'name', '物品名称', {required: true, wide: true}));
    if (edit.kind === 'device') grid.append(field(f, 'type', '设备类型', {values: values('type', 'deviceTypes', '未分类')}), field(f, 'status', '设备状态', {values: values('status', 'deviceStatuses', '未设置')}), field(f, 'remark', '设备备注', {type: 'textarea', wide: true}));
    else grid.append(field(f, 'categoryId', '衣物分类', {values: values('categoryId', 'wardrobeCategories', '未分类')}), field(f, 'brand', '品牌'), field(f, 'color', '颜色'), field(f, 'size', '尺码'), field(f, 'remark', '衣物备注', {type: 'textarea', wide: true}));
    const item = state.draft.items.find(item => item.sourceItemId === edit.sourceItemId) || {};
    grid.append(imageControl(f, item.imageUrl, edit.kind === 'device' ? 'device' : 'wardrobe_item', Boolean(edit.base.fileId), {item, choice: edit}));
    return panel(`第 ${index + 1} 件 · ${edit.kind === 'device' ? '设备' : '衣物'}`, el('p', {class: 'small'}, `已保存物品 · ${edit.id}`), grid);
  });
}
async function saveAssetEdits() {
  const edits = state.assetEdits.filter(edit => Object.keys(assetChanges(edit)).length);
  if (!edits.length) return;
  if (edits.some(edit => !edit.fields.name.trim())) { message('请填写物品名称', true); return; }
  setBusy(true, '正在保存物品修改…');
  let completed = 0;
  try {
    for (const edit of edits) {
      const current = await assetMessage('CAPTURE_ASSET_UPDATE', edit, {changes: assetChanges(edit), base: edit.base});
      const next = editableAssetFields(edit.kind, current);
      // Keep successful updates in memory so a partial retry only sends failed edits.
      edit.fields = next; edit.base = structuredClone(next);
      completed++;
    }
    render(); message(`已更新 ${completed} 件物品。`);
  } catch (error) {
    render(); message(`${completed ? `已更新 ${completed} 件；` : ''}${error.message}。未确认的修改已保留，可核实后重试。`, true);
  } finally { setBusy(false); }
}
function render() {
  const saved = state.kind === 'purchase' && Boolean(state.result);
  $('editor').replaceChildren(...(editingSaved() ? savedAssetsEditor() : saved ? [panel('已保存物品', el('p', {class: 'small', role: 'status'}, savedReadError || '正在读取物品信息，完成后可直接修改…'))] : state.kind === 'douban' ? doubanEditor() : purchaseEditor()));
  warningList([...new Set([...(state.warnings || []), ...(state.preview?.warnings || [])])]);
  if (state.result) showResult(state.result); updateSaveState();
}
async function switchDoubanSource() {
  if (sourceChangePromise) return sourceChangePromise;
  if (sourcePendingUrl === undefined) return;
  const identity = C.identify(sourcePendingUrl);
  if (!identity || identity.kind !== 'douban') throw new Error('请填写豆瓣书籍或影视详情页链接');
  if (identity.key === C.identify(state.draft.url)?.key) { sourcePendingUrl = undefined; render(); return; }
  sourceChangePromise = (async () => {
    setBusy(true, '正在切换条目…');
    state = {kind: 'douban', scope: state.scope, warnings: [], draft: {url: identity.url, metadata: {}}, fields: {title: '', type: 1, status: 'not_started', currentProgress: 0, remark: ''}};
    sourcePendingUrl = undefined;
    updateLocation(); $('result').hidden = true; render(); message('已切换条目，请重新预览查重。');
  })();
  try { await sourceChangePromise; } finally { sourceChangePromise = undefined; setBusy(false); }
}
async function preview() {
  if (sourceChangePromise) { await sourceChangePromise; }
  if (sourcePendingUrl !== undefined) { try { await switchDoubanSource(); } catch (error) { message(error.message, true); return; } }
  if (busy || pendingUploads || (state.kind === 'purchase' && ((state.result && !editingSaved()) || state.uncertain))) return; setBusy(true, state.kind === 'douban' ? '正在解析并查重…' : '正在检查商品信息…');
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
    render(); message(state.kind === 'purchase' ? '商品信息已检查' : response.existing ? '已收录，可更新记录' : '');
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
  if (!order.orderNo?.trim()) throw new Error('请填写订单 ID');
  const assets = [];
  order.items.forEach((item, index) => {
    for (let unit = 1; unit <= item.quantity; unit++) {
      const existing = existingAsset(item, unit);
      if (existing) { assets.push({sourceItemId: item.sourceItemId, unitIndex: unit, kind: existing.kind, existingId: existing.id}); continue; }
      const choice = state.assetChoices[index]?.[unit - 1]; if (!choice || choice.choice === 'none') continue;
      if (!item.sku?.trim()) throw new Error('请填写选中商品的商品 ID');
      const kind = choice.choice;
      if (!['device', 'wardrobe'].includes(kind)) throw new Error('请选择设备或衣柜');
      const fields = {...choice.fields};
      for (const key of ['categoryId', 'type', 'status']) if (fields[key] === '') delete fields[key];
      assets.push({sourceItemId: item.sourceItemId, unitIndex: unit, kind, fields});
    }
  });
  if (!assets.some(asset => !asset.existingId)) throw new Error('请至少选择一件尚未录入的商品创建设备或加入衣柜');
  return {order, amountConfirmed: true, assets};
}
async function commit(event) {
  event.preventDefault(); if (busy || pendingUploads) return;
  if (editingSaved()) return saveAssetEdits();
  if (state.kind === 'purchase' && state.result) return;
  let dispatched = false;
  try {
    if (state.kind === 'douban' && (sourcePendingUrl !== undefined || !state.preview || state.previewFingerprint !== C.stableJSON(previewRequest()))) throw new Error('信息已修改，请重新预览与查重');
    const payload = commitPayload();
    if (state.uncertain && state.submission?.fingerprint !== C.stableJSON(payload)) throw new Error('上次结果不确定，不能修改内容后换请求标识重试；请先核实设备／衣柜');
    state.submission = C.submission(state.submission, payload);
    state.submission.startedAt ||= Date.now();
    if (Date.now() - state.submission.startedAt >= 24 * 60 * 60 * 1000) throw new Error('本次请求已超过 24 小时，请先核实是否已创建物品，不要直接重试。确认后可回到来源页面重新采集');
    // A refreshed in-flight page must not silently become a new creation form.
    state.uncertain = true;
    updateLocation(true);
    setBusy(true, '正在保存，请勿重复操作…');
    dispatched = true;
    const result = await api(`/capture/${state.kind}/commit`, {...payload, idempotencyKey: state.submission.key});
    if (state.kind === 'douban' ? !result?.id : !Array.isArray(result?.assets) || !result.assets.length || result.assets.some(asset => !asset.id)) { const error = new Error('服务未返回完整记录 ID，保存结果不确定，请先到 AIO Life 核实'); error.uncertain = true; throw error; }
    state.uncertain = false;
    state.result = result;
    if (state.kind === 'purchase') {
      const combined = new Map((state.existingAssets || []).map(asset => [`${asset.kind}:${asset.id}`, asset]));
      for (const asset of result.assets) combined.set(`${asset.kind}:${asset.id}`, asset);
      state.existingAssets = [...combined.values()];
      const createdCount = result.createdCount ?? (result.operation === 'created' ? result.assets.length : 0);
      state.result = {...result, assets: state.existingAssets, createdCount, existingCount: state.existingAssets.length - createdCount,
        operation: createdCount && state.existingAssets.length > createdCount ? 'mixed' : result.operation};
    }
    updateLocation();
    if (state.kind === 'douban') { state.baseFields = pickDouban(state.fields); state.previewFingerprint = null; }
    render(); message('');
  } catch (error) {
    if (dispatched && (error.uncertain || /超时|timeout|Failed to fetch|NetworkError|结果不确定|无法确认.*提交|结果待确认|正在处理|处理中/i.test(error.message))) { state.uncertain = true; message(error.message + '。保存结果不确定，请先核实已有记录；不会自动重试。', true); }
    else { if (dispatched) { state.uncertain = false; updateLocation(); } message(error.message, true); }
  }
  finally { setBusy(false); }
  if (state.kind === 'purchase' && state.result && !editingSaved()) await beginAssetEdits();
}
async function init() {
  try {
    config = await call({type: 'CAPTURE_CONFIG_GET'});
    C.assertHandoffProtocol(config);
    state = stateFromLocation();
    if (!state) {
      const id = new URL(location.href).searchParams.get('transfer');
      if (!id) throw new Error('请回到来源页面重新采集；如之前提交过，请先到 AIO Life 核实结果');
      state = await call({type: 'CAPTURE_TAKE', id});
    }
    if (state.scope !== config.scope) throw new Error('连接账号或服务已变化，请回到来源页面重新采集');
    updateLocation();
    if (state.kind === 'douban') {
      state.fields ||= {...state.draft.metadata, status: 'not_started', currentProgress: 0, remark: ''}; state.fields.type ||= 1;
      state.coverImgUrl ||= state.draft.metadata.coverImgUrl; delete state.fields.coverImgUrl;
    } else {
      state.assetChoices ||= [];
      if (state.result) state.existingAssets = state.result.assets;
      const seen = new Set();
      state.draft.items.forEach((item, index) => { if (!item.sourceItemId || seen.has(item.sourceItemId)) item.sourceItemId = `local:${index}:${crypto.randomUUID()}`; seen.add(item.sourceItemId); });
      state.warnings = (state.warnings || []).filter(warning => !/明细标识|账单|支出/.test(warning));
    }
    $('page-title').textContent = state.kind === 'douban' ? '豆瓣书影音 · 入库预览' : state.result ? '设备／衣柜 · 编辑物品' : `${state.draft.platform === 'jd' ? '京东' : '淘宝'}商品 · 录入设备／衣柜`;
    $('source-description').textContent = '';
    $('preview').hidden = state.kind === 'purchase';
    $('preview').textContent = '预览与查重';
    $('edit-saved').addEventListener('click', beginAssetEdits);
    $('remaining-assets').addEventListener('click', () => { if (editingSaved() && state.assetEdits.some(edit => Object.keys(assetChanges(edit)).length) && !confirm('切换会放弃尚未保存的修改，继续吗？')) return; state.result = null; delete state.assetEdits; $('result').hidden = true; render(); message('已保存物品不会重复录入，请选择其余商品。'); });
    $('preview').addEventListener('click', preview); $('capture-form').addEventListener('submit', commit);
    render();
    if (!config.configured) { message('请先在工具栏插件的连接设置中配置 Token，然后重新采集。', true); return; }
    if (state.kind === 'purchase') {
      setBusy(true, '正在读取分类…');
      try { options = await api('/capture/options'); render(); } catch (error) { message('分类选项加载失败：' + error.message + '。请重新打开采集页面后重试。', true); }
      finally { setBusy(false); }
    }
    if (state.kind === 'purchase' && !state.result) await lookupPurchaseAssets();
    if (state.result) {
      showResult(state.result);
      if (state.kind === 'purchase') await beginAssetEdits();
    }
    else if (state.uncertain) message('上次保存结果不确定，请先到 AIO Life 核实记录；不会自动重试。', true);
    else if (!state.preview && state.kind === 'douban') await preview();
  } catch (error) { message(error.message, true); $('page-title').textContent = '无法打开录入页面'; $('capture-form').hidden = true; }
}
init();
