(function (root) {
  function douban(doc, url) {
    const identity = root.AioCapture.identify(url);
    if (identity?.kind !== 'douban') throw new Error('请打开豆瓣书籍或影视详情页');
    const A = root.AioAdapters, info = A.text(doc.querySelector('#info'));
    const title = A.first(doc, ['h1 [property="v:itemreviewed"]', 'h1 span', 'h1']);
    const author = A.label(info, ['作者'], '[^\\n\\r]+');
    const director = A.first(doc, ['#info [rel="v:directedBy"]']) || A.label(info, ['导演'], '[^\\n\\r]+');
    const episodes = A.label(info, ['集数'], '\\d+');
    const pages = A.label(info, ['页数'], '\\d+');
    const duration = doc.querySelector('[property="v:runtime"]')?.getAttribute('content') || A.label(info, ['片长'], '\\d+');
    const metadata = {title, author: identity.mediaType === 'book' ? author : undefined, director: identity.mediaType === 'movie' ? director : undefined,
      type: identity.mediaType === 'book' ? 1 : episodes ? 2 : 1,
      totalProgress: Number(identity.mediaType === 'book' ? pages : episodes || duration) || undefined,
      coverImgUrl: A.image(doc.querySelector('#mainpic'), url)};
    return {kind: 'douban', draft: {url: identity.url, metadata}, warnings: title ? [] : ['页面没有标题，将尝试服务端补充；失败后可手动填写。'], adapterVersion: 'douban-1'};
  }
  root.AioAdapters.douban = douban;
  if (typeof module !== 'undefined') module.exports = douban;
})(globalThis);
