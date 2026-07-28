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
