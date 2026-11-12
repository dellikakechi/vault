import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { VaultApi } from '../shared/api'

const api: VaultApi = {
  smoke: process.env.VAULT_SMOKE === '1',
  info: () => ipcRenderer.invoke('app:info'),
  getLibrary: () => ipcRenderer.invoke('library:data'),
  chooseRoot: () => ipcRenderer.invoke('library:chooseRoot'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  pickFolders: () => ipcRenderer.invoke('dialog:pickFolders'),
  scan: (paths) => ipcRenderer.invoke('import:scan', paths),
  commitImport: (items) => ipcRenderer.invoke('import:commit', items),
  updateItem: (id, patch) => ipcRenderer.invoke('item:update', id, patch),
  deleteItems: (ids) => ipcRenderer.invoke('item:delete', ids),
  createImageSet: (ids) => ipcRenderer.invoke('set:create', ids),
  trashInfo: () => ipcRenderer.invoke('trash:info'),
  emptyTrash: () => ipcRenderer.invoke('trash:empty'),
  convertImage: (id, pageIndex, data, width, height) =>
    ipcRenderer.invoke('image:convert', id, pageIndex, data, width, height),
  setThumb: (id, data, meta) => ipcRenderer.invoke('thumb:set', id, data, meta),
  addTag: (name, color) => ipcRenderer.invoke('tag:add', name, color),
  renameTag: (id, name) => ipcRenderer.invoke('tag:rename', id, name),
  deleteTag: (id) => ipcRenderer.invoke('tag:delete', id),
  addCategory: (name, color, parentId) =>
    ipcRenderer.invoke('category:add', name, color, parentId),
  setCategoryParent: (id, parentId) =>
    ipcRenderer.invoke('category:setParent', id, parentId),
  renameCategory: (id, name) => ipcRenderer.invoke('category:rename', id, name),
  deleteCategory: (id) => ipcRenderer.invoke('category:delete', id),
  setTagCategory: (tagId, categoryId) =>
    ipcRenderer.invoke('tag:setCategory', tagId, categoryId),
  applyTags: (ids, add, remove) => ipcRenderer.invoke('tags:apply', ids, add, remove),
  setMembership: (ids, patch) => ipcRenderer.invoke('queue:setMembership', ids, patch),
  findDuplicates: (threshold) => ipcRenderer.invoke('dupes:find', threshold),
  aiSuggest: (ids, useModel) => ipcRenderer.invoke('ai:suggest', ids, useModel),
  aiAccept: (id, tags, rejected) => ipcRenderer.invoke('ai:accept', id, tags, rejected),
  aiAcceptMany: (entries) => ipcRenderer.invoke('ai:acceptMany', entries),
  aiReject: (ids) => ipcRenderer.invoke('ai:reject', ids),
  aiEvaluate: (maxItems) => ipcRenderer.invoke('ai:evaluate', maxItems),
  aiTest: () => ipcRenderer.invoke('ai:test'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  reveal: (id) => ipcRenderer.invoke('shell:reveal', id),
  openRoot: () => ipcRenderer.invoke('shell:openRoot'),
  setImmersive: (on) => ipcRenderer.invoke('window:setImmersive', on),
  writeTemp: (name, data) => ipcRenderer.invoke('debug:writeTemp', name, data),
  tempPath: () => ipcRenderer.invoke('debug:path'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onLibraryChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('library:changed', listener)
    return () => {
      ipcRenderer.removeListener('library:changed', listener)
    }
  }
}

contextBridge.exposeInMainWorld('vault', api)
