import { contextBridge, ipcRenderer } from 'electron'

export type UpdateStatus =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'download-progress'
  | 'update-downloaded'
  | 'error'

export interface UpdateEvent {
  status: UpdateStatus
  version?: string
  percent?: number
  message?: string
}

const api = {
  platform: process.platform,
  storage: {
    getSync: (key: string): string | null => ipcRenderer.sendSync('storage:get', key) as string | null,
    set: (key: string, value: string): void => ipcRenderer.send('storage:set', key, value),
    remove: (key: string): void => ipcRenderer.send('storage:remove', key)
  },
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  checkForUpdates: (): Promise<{ disabled?: boolean; ok?: boolean; version?: string; error?: string }> =>
    ipcRenderer.invoke('update:check'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  fetchUpdateLicense: (version?: string): Promise<{ text?: string; error?: string }> =>
    ipcRenderer.invoke('update:license', version),
  onUpdateEvent: (cb: (payload: UpdateEvent) => void): (() => void) => {
    const listener = (_: unknown, payload: UpdateEvent): void => cb(payload)
    ipcRenderer.on('update:event', listener)
    return () => ipcRenderer.removeListener('update:event', listener)
  },
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  onWindowState: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('window:state', listener)
    return () => ipcRenderer.removeListener('window:state', listener)
  }
}

contextBridge.exposeInMainWorld('reliquary', api)

export type ReliquaryApi = typeof api
