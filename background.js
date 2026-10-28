/* Service-worker entry: load shared services before feature handlers. */
importScripts('shared/config.js', 'shared/api.js');
chrome.storage.local.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
importScripts('capture/background.js', 'douban-auto/background.js', 'bilibili/background.js');
