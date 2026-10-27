/* Read only the product gallery, never recommendation images or executable page code. */
(function (root) {
  'use strict';
  function productUrl(sku) {
    if (typeof sku !== 'string' || !/^\d{1,30}$/.test(sku)) throw new Error('未识别京东商品编号，请重新采集订单');
    return `https://item.jd.com/${sku}.html`;
  }
  function normalize(value) {
    if (typeof value !== 'string') return null;
    value = value.replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
    if (/^jfs\//.test(value)) value = `https://img10.360buyimg.com/n1/${value}`;
    try {
      const url = new URL(value, 'https://item.jd.com');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/(^|\.)360buyimg\.com$/.test(url.hostname)) return null;
      url.protocol = 'https:';
      // Use the gallery image rather than the 50px thumbnail.
      url.pathname = url.pathname.replace(/^\/(?:n[0-9]+|s\d+x\d+_jfs)\//, '/n1/').replace(/\/s\d+x\d+_jfs\//, '/jfs/');
      url.pathname = url.pathname.replace(/^\/[^/]+\/jfs\//, '/n1/jfs/');
      // JD's current gallery adds an AVIF delivery suffix to the original JPEG/PNG.
      // Request the original format supported by the file API, not a renamed AVIF blob.
      url.pathname = url.pathname.replace(/(\.(?:jpe?g|png|webp|gif))(?:![^/]*)?\.avif$/i, '$1');
      url.search = ''; url.hash = '';
      return url.href;
    } catch { return null; }
  }
  function unique(values) {
    const seen = new Set();
    return values.map(normalize).filter(value => {
      if (!value) return false;
      const key = new URL(value).pathname;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 30);
  }
  function scriptImages(text) {
    const images = [];
    for (const match of text.matchAll(/\bimageList["']?\s*:\s*\[([^\]]{0,100000})\]/g)) {
      for (const value of match[1].matchAll(/["']([^"'\r\n]+)["']/g)) images.push(value[1]);
    }
    return images;
  }
  function fromDocument(doc) {
    const images = [];
    for (const node of doc.querySelectorAll('#spec-list img, .spec-list img, .preview-list img, .preview-wrap .image-carousel.thumbnails img, #spec-img, meta[property="og:image"]')) {
      for (const name of ['data-origin', 'data-url', 'data-lazy-img', 'data-src', 'src', 'content']) {
        const value = node.getAttribute(name); if (value) images.push(value);
      }
    }
    for (const script of doc.querySelectorAll('script:not([src])')) images.push(...scriptImages(script.textContent));
    return unique(images);
  }
  function fromHtml(html) {
    const images = [];
    // A service worker has no DOMParser. Limit parsing to known gallery containers.
    const sections = html.match(/<(ul|div)\b[^>]*(?:id|class)=["'][^"']*\bspec-list\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi) || [];
    sections.push(...(html.match(/<img\b[^>]*\bid=["']spec-img["'][^>]*>/gi) || []));
    for (const section of sections) for (const tag of section.matchAll(/<img\b[^>]*>/gi)) {
      for (const attr of tag[0].matchAll(/\b(?:data-origin|data-url|data-lazy-img|data-src|src)\s*=\s*["']([^"']+)["']/gi)) images.push(attr[1]);
    }
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) images.push(...scriptImages(script[1]));
    return unique(images);
  }
  root.AioJdImages = {productUrl, normalize, unique, fromDocument, fromHtml};
  if (typeof module !== 'undefined') module.exports = root.AioJdImages;
})(globalThis);
