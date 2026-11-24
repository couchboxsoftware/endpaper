/* The only bridge between the page and the system. */
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const channels = [
  'app:info', 'changelog:seen', 'app:close-ack', 'app:close-ok', 'app:confirm', 'app:reveal', 'app:readAppFile', 'app:boot', 'app:full-screen', 'app:quit',
  'settings:get', 'settings:set', 'changelog:get',
  'file:open', 'file:read', 'file:save', 'file:export', 'file:exportMany', 'recent:list', 'recent:forget',
  'image:pick', 'fonts:list', 'fonts:read', 'fonts:add',
  'inkdesktop:find', 'inkdesktop:open', 'inkdesktop:get', 'file:open-default', 'file:show-folder',
  'icc:list', 'icc:read', 'icc:add',
  'brandkit:get', 'brandkit:set', 'textures:list', 'textures:read', 'textures:add', 'textures:update', 'textures:remove',
  'templates:list', 'templates:save', 'templates:read', 'templates:delete',
  'bin:list', 'bin:restore', 'bin:empty',
  'recovery:write', 'recovery:clear', 'recovery:list', 'recovery:read',
  'update:state', 'update:check', 'update:download', 'update:install', 'update:releases', 'update:prepared',
];
const api = {};
for (const ch of channels) {
  const [a, b] = ch.split(':');
  // 'app:close-ok' becomes ep.app.closeOk
  (api[a] = api[a] || {})[b.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = call(ch);
}
api.on = (ch, fn) => {
  if (!['app:close-request', 'app:open-file', 'app:fullscreen', 'update', 'update:prepare', 'update-dry'].includes(ch)) return;
  ipcRenderer.on(ch, (_e, ...a) => fn(...a));
};
contextBridge.exposeInMainWorld('ep', api);
