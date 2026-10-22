// This function executes only after an explicit toolbar click; return structured fields only.
function extractAioCapture() {
  const identity = AioCapture.identify(location.href);
  if (!identity) throw new Error('支持豆瓣书籍／影视详情页，以及京东、淘宝订单详情页');
  const result = AioAdapters[identity.kind === 'douban' ? 'douban' : identity.platform](document, location.href);
  return {...result, sourceKey: identity.kind === 'douban' ? identity.key : `${identity.platform}:${result.draft.orderNo || result.draft.sourceUrl}`, sourceTitle: document.title};
}
