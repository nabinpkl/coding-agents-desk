// The IDE entry. One document serves both regions — the sidebar and the editor run in separate
// WKWebViews and pick themselves by `?region=`, so this file only decides which one to mount and
// wires the two directions of the bridge: projections in from Swift, intents out.

import '../file-content.css'
import '../ide.css'
import { mountEditor } from './editor/mount.ts'
import { regionFromLocation } from './ideModel.ts'
import type { Intent, Receive } from './projection.ts'
import { mountSidebar } from './sidebar/mount.ts'

const root = document.getElementById('workspace-ide')
const region = regionFromLocation(window.location)

if (!root) throw new Error('Workspace IDE root element is missing')
if (!region) throw new Error('Workspace IDE region is required')
document.body.dataset.region = region

/// Each region is a named container so its own rows can respond to the pane's width rather than the
/// window's — the sidebar can be narrow inside a wide window. The last row is the growable one and
/// children pin themselves to it explicitly; auto-placement would slide them up whenever a sibling
/// above is `hidden`, since a hidden element stops being a grid item.
root.className = region === 'sidebar'
  ? '@container/sidebar grid grid-rows-[auto_auto_auto_minmax(0,1fr)] bg-ide-bg'
  : '@container/editor grid grid-rows-[36px_34px_auto_minmax(0,1fr)] bg-ide-panel'

declare global {
  interface Window {
    webkit?: { messageHandlers?: { workspaceIDE?: { postMessage(message: unknown): void } } }
    workspaceIDE?: { receive: Receive }
  }
}

const send = (intent: Intent) => window.webkit?.messageHandlers?.workspaceIDE?.postMessage(intent)

const receive: Receive = region === 'sidebar' ? mountSidebar(root, send) : mountEditor(root, send)

window.workspaceIDE = { receive }
send({ type: 'ready', region })
