export type Kind = 'user' | 'bot' | 'self' | 'group' | 'channel'
export type Viewer = { file: string } // a picture drawn over the pane (tgview.py)
export type CachedChat = { id: string; title: string; kind?: Kind; time: string; ts?: number; last: string; unread: number; muted: boolean }
export type CachedFolder = { updated: number; unread: number; chats: CachedChat[] }
export type Cache = { updated?: number; order?: string[]; folders: Record<string, CachedFolder> }
export type Reaction = { e: string; n: number; me: boolean }
// from: the sender, in a group; reply: the message it answers; fwd: forwarded (the author's name, or true); ts: unix time
export type Message = { mid: number; date: string; time: string; ts?: number; out: boolean; text: string; from?: string; media?: 'photo' | 'image' | 'video' | 'voice' | 'round' | 'file'
  reactions?: Reaction[]; reply?: { mid: number; text: string }; fwd?: string | true; edited?: true }
export type History = { peer: string; title: string; kind?: Kind; unread?: number; messages: Message[] }
export type Tab = 'private' | 'channels'
export type Mode = { kind: 'reply' | 'edit'; mid: number; text: string } // the input answers a message / rewrites my own one
export type Forward = { mid: number; q: string; to: string | null } // choosing the chat to forward message `mid` to
export type Found = { q: string; hits: Message[] | null } // search inside the open chat (hits newest first; null — not asked yet)
export type Hit = { peer: string; title: string; mid: number; date: string; time: string; out: boolean; text: string }
export type ListSearch = { q: string; hits: Hit[] | null } // search above the chat list: chat names now, message texts from Telegram
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
      viewer: Viewer | null
      lift: number
      theme: number
      listTop: number
      login: Login | null
      note: string
      draft: number
      askZone: boolean
      sel: number | null
      mode: Mode | null
      toolbar: '' | 'react' | 'delete'
      fwd: Forward | null
      found: Found | null
      jump: number | null
      listQ: ListSearch | null
      sumMenu: string | null
      trs: Record<string, string>
    }
  }
}
