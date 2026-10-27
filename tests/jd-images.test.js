const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const images = require('../capture/jd-images');

test('JD gallery reads lazy thumbnails and imageList without recommendations or executing scripts', () => {
  const html = `<div id="spec-list"><ul>
    <li><img src="//img10.360buyimg.com/n5/s54x54_jfs/t1/cover.jpg"></li>
    <li><img data-url="//img11.360buyimg.com/n1/jfs/t1/second.jpg"></li>
    </ul></div><img src="https://img10.360buyimg.com/n1/jfs/recommendation.jpg">
    <script>throw new Error('never execute'); var pageConfig = {imageList: ['jfs/t1/cover.jpg', 'jfs/t1/third.jpg', 'https://evil.invalid/image.jpg']};</script>`;
  const dom = new JSDOM(html);
  const expected = ['https://img10.360buyimg.com/n1/jfs/t1/cover.jpg', 'https://img11.360buyimg.com/n1/jfs/t1/second.jpg', 'https://img10.360buyimg.com/n1/jfs/t1/third.jpg'];
  assert.deepEqual(images.fromHtml(html), expected);
  assert.deepEqual(images.fromDocument(dom.window.document), expected);
  dom.window.close();
});

test('JD source validation preserves string SKU and rejects foreign image hosts', () => {
  assert.equal(images.productUrl('9007199254740993123'), 'https://item.jd.com/9007199254740993123.html');
  for (const sku of ['', '../admin', '123?url=evil', 123]) assert.throws(() => images.productUrl(sku));
  for (const url of ['https://360buyimg.com.evil.test/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,abc', 'https://user:pass@img10.360buyimg.com/a.jpg']) assert.equal(images.normalize(url), null);
  assert.deepEqual(images.fromHtml('<html>请登录</html>'), []);
});

test('current JD carousel includes every product cover and removes AVIF delivery suffixes', () => {
  const dom = new JSDOM(`<div class="preview-wrap"><div class="image-carousel vertical thumbnails">
    <img src="https://img10.360buyimg.com/pcpubliccms/s228x228_jfs/t1/a.jpg.avif">
    <img src="https://img10.360buyimg.com/pcpubliccms/s228x228_jfs/t1/b.jpg.avif">
    </div><div id="spec-n1"><img src="https://img10.360buyimg.com/pcpubliccms/s800x800_jfs/t1/a.jpg.avif"><img src="https://img10.360buyimg.com/compare-pk.png"></div></div>
    <div class="recommendations"><img src="https://img10.360buyimg.com/n1/jfs/recommendation.jpg"></div>
    <meta property="og:image" content="https://img10.360buyimg.com/n1/jfs/t1/a.jpg.avif">`);
  assert.deepEqual(images.fromDocument(dom.window.document), ['https://img10.360buyimg.com/n1/jfs/t1/a.jpg', 'https://img10.360buyimg.com/n1/jfs/t1/b.jpg']);
  dom.window.close();
});
