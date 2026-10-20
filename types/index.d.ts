export type Kind = 'user' | 'bot' | 'self' | 'group' | 'channel'
export type CachedChat = { id: string; title: string; kind?: Kind; time: string; last: string; unread: number; muted: boolean }
export type CachedFolder = { updated: number; unread: number; chats: CachedChat[] }
export type Cache = { updated?: number; order?: string[]; folders: Record<string, CachedFolder> }
export type Message = { mid: number; date: string; time: string; out: boolean; text: string; from?: string; media?: 'photo' | 'image' | 'video' | 'file' } // from: the sender, in a group
export type History = { peer: string; title: string; kind?: Kind; unread?: number; messages: Message[] }
export type Viewer = { file: string; columns: number; rows: number; cells: string } // a picture as Raster cells
export type Tab = 'private' | 'channels'
export type Login = { state: 'qr' | 'password' | 'loading' | 'down' | 'ok'; qr?: string[] }

declare module 'claude-code' {
  interface PluginState {
    'tg-pane': {
      tab: Tab
      cache: Cache | null
      selected: string | null
      channel: string | null
      folder: string | null
      chat: History | null
      lift: number
      theme: number
      viewer: Viewer | null
      sharp: boolean
      listTop: number
      login: Login | null
      note: string
      draft: number
      askZone: boolean
    }
  }
}
