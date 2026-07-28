import { button, element } from '../dom.ts'
import { fileRenderIdentity, normalizeProjection, orderedPathsAfterMove } from '../ideModel.ts'
import type { EditorProjection, Receive, Send } from '../projection.ts'
import { installFileSurface } from '../viewer.ts'
import { applyWorkspaceZoom } from '../workspaceZoom.ts'

export function mountEditor(container: HTMLElement, send: Send): Receive {
  const tabs = element('div', 'ide-tabs')
  tabs.setAttribute('role', 'tablist')
  const toolbar = element('div', 'ide-editor-toolbar')
  const sidebarToggle = button('☰', 'Toggle sidebar', () =>
    send({ type: 'setSidebarVisible', visible: !lastSidebarVisible }))
  const breadcrumb = element('nav', 'ide-breadcrumb')
  breadcrumb.setAttribute('aria-label', 'File breadcrumb')
  const modeToggle = button('Preview', 'Show file preview', () => {
    if (currentPath) send({ type: 'toggleMode', path: currentPath })
  })
  modeToggle.className = 'ide-mode-toggle'
  const zoomOut = button('−', 'Zoom out', () => send({ type: 'zoomOut' }))
  const zoomIn = button('+', 'Zoom in', () => send({ type: 'zoomIn' }))
  const terminalToggle = button('⌘', 'Toggle terminal', () =>
    send({ type: 'setTerminalVisible', visible: !lastTerminalVisible }))
  toolbar.append(sidebarToggle, breadcrumb, modeToggle, zoomOut, zoomIn, terminalToggle)
  const conflict = element('div', 'ide-conflict')
  conflict.setAttribute('role', 'alert')
  const fileContent = element('main', 'ide-file-content')
  const empty = element('div', 'ide-editor-empty')
  empty.textContent = 'Open a file from Explorer'
  fileContent.hidden = true
  container.replaceChildren(tabs, toolbar, conflict, fileContent, empty)

  const fileSurface = installFileSurface({
    container: fileContent,
    announceReady: false,
    messageSink(message: { type: string; text: string }) {
      if (message.type === 'dirty') send({ type: 'edit', path: currentPath, text: message.text })
    },
  })
  let currentIdentity: string | null = null
  let currentPath: string | null = null
  let draggedPath: string | null = null
  let lastSidebarVisible = true
  let lastTerminalVisible = true

  return (raw) => {
    const snapshot = normalizeProjection(raw, 'editor') as EditorProjection | null
    if (!snapshot) return
    const workspaceScale = applyWorkspaceZoom(container, snapshot.zoomScale)
    fileSurface.setWorkspaceScale(workspaceScale)
    currentPath = snapshot.activePath ?? null
    lastSidebarVisible = snapshot.sidebarVisible !== false
    lastTerminalVisible = snapshot.terminalVisible !== false
    sidebarToggle.setAttribute('aria-pressed', String(lastSidebarVisible))
    terminalToggle.setAttribute('aria-pressed', String(lastTerminalVisible))
    tabs.replaceChildren(...snapshot.tabs.map((tab) => {
      const wrapper = element('div', 'ide-tab')
      wrapper.classList.toggle('is-selected', tab.path === snapshot.activePath)
      wrapper.draggable = true
      wrapper.addEventListener('dragstart', () => { draggedPath = tab.path })
      wrapper.addEventListener('dragover', (event) => event.preventDefault())
      wrapper.addEventListener('drop', () => {
        if (!draggedPath) return
        send({
          type: 'reorderTabs',
          paths: orderedPathsAfterMove(snapshot.tabs.map(({ path }) => path), draggedPath, tab.path),
        })
        draggedPath = null
      })
      const select = button(tab.name, `Open ${tab.name}`, () =>
        send({ type: 'selectTab', path: tab.path }))
      select.className = 'ide-tab-label'
      select.setAttribute('role', 'tab')
      select.setAttribute('aria-selected', String(tab.path === snapshot.activePath))
      if (tab.dirty || tab.autosaving || tab.conflict) {
        const state = element('span', tab.conflict ? 'ide-tab-conflict' : 'ide-tab-dirty')
        state.textContent = tab.autosaving ? 'saving' : tab.conflict ? '!' : '●'
        select.append(state)
      }
      const close = button('×', `Close ${tab.name}`, () => send({ type: 'close', path: tab.path }))
      close.className = 'ide-tab-close'
      wrapper.append(select, close)
      return wrapper
    }))
    breadcrumb.replaceChildren(...snapshot.breadcrumb.map((part, index) => {
      const segment = element('span')
      segment.textContent = index ? ` / ${part}` : part
      return segment
    }))
    const activeTab = snapshot.tabs.find(({ path }) => path === snapshot.activePath)
    const editable = snapshot.file && !['docx', 'notebook'].includes(snapshot.file.kind)
    modeToggle.hidden = !editable
    modeToggle.textContent = snapshot.file?.mode === 'preview' ? 'Edit' : 'Preview'
    modeToggle.setAttribute(
      'aria-label',
      snapshot.file?.mode === 'preview' ? 'Edit file' : 'Show file preview',
    )
    conflict.replaceChildren()
    conflict.hidden = !activeTab?.conflict
    if (activeTab?.conflict) {
      const label = element('span')
      label.textContent = 'This file changed on the host.'
      conflict.append(
        label,
        button('Use Host', 'Replace local draft with host version', () =>
          send({ type: 'useHost', path: activeTab.path })),
        button('Keep Mine', 'Save local draft over latest host revision', () =>
          send({ type: 'keepMine', path: activeTab.path })),
      )
    }
    const identity = fileRenderIdentity(snapshot.file)
    if (snapshot.file && identity !== currentIdentity) {
      currentIdentity = identity
      fileSurface.render(snapshot.file)
    }
    const hasFile = Boolean(snapshot.file)
    fileContent.hidden = !hasFile
    empty.hidden = hasFile
    empty.textContent = snapshot.loading ? 'Opening file…' : snapshot.error ?? 'Open a file from Explorer'
  }
}
