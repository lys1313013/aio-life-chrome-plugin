(function (root) {
  'use strict';
  function movieIdentity(value) {
    try { const url = new URL(value); const match = url.pathname.match(/^\/subject\/(\d+)\/?$/); return url.origin === 'https://movie.douban.com' && !url.username && !url.password && match ? {id: match[1], url: `https://movie.douban.com/subject/${match[1]}/`} : null; } catch { return null; }
  }
  function visible(node, win) {
    if (!node?.isConnected) return false;
    for (let item = node; item?.nodeType === 1; item = item.parentElement) {
      const style = win.getComputedStyle(item);
      if (item.hidden || item.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function createProfile(doc, url) {
    const identity = movieIdentity(url);
    if (!identity) throw new Error('仅支持豆瓣影视详情页');
    const matchingForm = form => {
      if (!form?.matches('form.j.a_interest_form.movie-sns')) return false;
      try { const action = new URL(form.getAttribute('action'), identity.url); return action.origin === 'https://movie.douban.com' && action.pathname.replace(/\/$/, '') === `/j/subject/${identity.id}/interest`; } catch { return false; }
    };
    return {
      identity,
      matchingForm,
      formForTarget: target => { const form = target?.closest?.('form'); return matchingForm(form) ? form : null; },
      formVisible: form => visible(form, doc.defaultView),
      selectedStatus: form => ({wish: 'not_started', collect: 'completed'}[(form.querySelector('input[name="interest"]:checked') || form.querySelector('input[type="hidden"][name="interest"]'))?.value] || null),
      isSaveClick: target => target?.matches?.('input[type="submit"][name="save"][value="保存"]'),
      isRemoveClick: target => {
        const form = target?.closest?.('#interest_sect_level form.miniform');
        return Boolean(form && form.getAttribute('action') === 'remove' && target.matches('input[type="submit"].minisubmit.j.a_confirm_link[value="删除"]'));
      },
      isRemoveForm: form => Boolean(form?.matches?.('#interest_sect_level form.miniform') && form.getAttribute('action') === 'remove'),
      readUnmarked: () => {
        const region = doc.querySelector('#interest_sect_level');
        return Boolean(doc.querySelector('#db-global-nav .top-nav-info > ul > li.nav-user-account > a.bn-more') && doc.querySelector('#top-nav-doumail-link') && region && !region.querySelector(':scope > div.j.a_stars > span.mr10') && region.querySelector(`:scope > a.collect_btn.colbutt.ll[name="pbtn-${identity.id}-wish"]`) && region.querySelector(`:scope > a.collect_btn.colbutt.ll[name="pbtn-${identity.id}-collect"]`));
      },
      isCancel: target => Boolean(target?.closest?.('.interest-form-hd .gact.rr')),
      readSaved: () => {
        const region = doc.querySelector('#interest_sect_level');
        if (!region?.querySelector(`a.collect_btn[name="pbtn-${identity.id}"]`)) return null;
        const node = region.querySelector(':scope > div.j.a_stars > span.mr10');
        if (!node) return null;
        const text = (node.innerText || node.textContent || '').trim();
        const match = text.match(/^我(想看|看过)这部电影(?:\s|$)/);
        return match ? {node, status: match[1] === '想看' ? 'not_started' : 'completed'} : null;
      }
    };
  }
  class SavedInterestDetector {
    constructor({document: doc, url, onConfirmed, onIntent = () => {}, onUnconfirmed = () => {}, requireTrusted = true, timeoutMs = 30000}) {
      this.doc = doc; this.profile = createProfile(doc, url); this.onConfirmed = onConfirmed; this.onIntent = onIntent; this.onUnconfirmed = onUnconfirmed; this.requireTrusted = requireTrusted; this.timeoutMs = timeoutMs; this.pending = null;
      this.click = event => {
        if (this.requireTrusted && !event.isTrusted) return;
        if (this.profile.isCancel(event.target)) { this.cancel(); return; }
        if (this.profile.isRemoveClick(event.target)) { this.beginRemoval(event.target.closest('form')); return; }
        const form = this.profile.formForTarget(event.target);
        if (form && this.profile.isSaveClick(event.target)) this.begin(form);
      };
      // requestSubmit() can produce a trusted submit event without a user gesture.
      this.submit = () => {}; // Only the preceding trusted click or Enter arms an attempt.
      this.keydown = event => {
        if (this.requireTrusted && !event.isTrusted) return;
        if (event.key === 'Escape') { this.cancel(); return; }
        if (event.key !== 'Enter' || event.isComposing || event.target?.matches?.('textarea,[contenteditable]')) return;
        const form = event.target?.closest?.('form');
        if (this.profile.isRemoveClick(event.target)) this.beginRemoval(form);
        else if (this.profile.matchingForm(form)) this.begin(form);
      };
      this.observer = new doc.defaultView.MutationObserver(() => this.check());
      doc.addEventListener('click', this.click, true); doc.addEventListener('submit', this.submit, true); doc.addEventListener('keydown', this.keydown, true);
      this.observer.observe(doc.documentElement, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']});
    }
    begin(form) {
      const status = this.profile.selectedStatus(form);
      if (!status) { this.onUnconfirmed('未识别当前豆瓣标记表单，未自动同步；可使用插件手动入库。'); return; }
      if (!this.profile.formVisible(form)) return;
      // Click and submit events from the same native save are one attempt.
      if (this.pending?.form === form && this.pending.status === status) return;
      this.cancel();
      const before = this.profile.readSaved();
      this.pending = {form, status, before, eventId: this.doc.defaultView.crypto.randomUUID()};
      this.timer = this.doc.defaultView.setTimeout(() => { if (this.pending) { this.cancel(); this.onUnconfirmed('未检测到豆瓣标记保存成功，未同步到 AIO Life。'); } }, this.timeoutMs);
    }
    beginRemoval(form) {
      if (!this.profile.readSaved() || this.pending?.status === 'removed') return;
      this.cancel();
      this.pending = {form, status: 'removed', before: this.profile.readSaved(), eventId: this.doc.defaultView.crypto.randomUUID()};
      this.onIntent({url: this.profile.identity.url, eventId: this.pending.eventId});
      this.timer = this.doc.defaultView.setTimeout(() => this.cancel(), this.timeoutMs);
    }
    resumeRemoval(eventId, expiresAt) {
      if (!eventId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
      this.cancel();
      this.pending = {status: 'removed', eventId, resumed: true};
      this.timer = this.doc.defaultView.setTimeout(() => this.cancel(), Math.min(expiresAt - Date.now(), 120000));
      this.check();
    }
    check() {
      const pending = this.pending;
      if (!pending) return;
      if (pending.status === 'removed') {
        if (!this.profile.readUnmarked()) return;
        this.cancel(); this.onConfirmed({url: this.profile.identity.url, status: 'removed', eventId: pending.eventId}); return;
      }
      if (this.profile.formVisible(pending.form)) return;
      const after = this.profile.readSaved();
      if (!after || after.status !== pending.status) return;
      if (pending.before && after.node === pending.before.node && after.status === pending.before.status) return;
      this.cancel();
      this.onConfirmed({url: this.profile.identity.url, status: after.status, eventId: pending.eventId});
    }
    cancel() { this.pending = null; if (this.timer) this.doc.defaultView.clearTimeout(this.timer); this.timer = null; }
    stop() { this.cancel(); this.observer.disconnect(); this.doc.removeEventListener('click', this.click, true); this.doc.removeEventListener('submit', this.submit, true); this.doc.removeEventListener('keydown', this.keydown, true); }
  }
  root.AioDoubanNative = {movieIdentity, createProfile, SavedInterestDetector};
  if (typeof module !== 'undefined') module.exports = root.AioDoubanNative;
})(globalThis);
