import { button, element } from '../dom.ts'
import { fileRenderIdentity, normalizeProjection, orderedPathsAfterMove } from '../ideModel.ts'
import type { EditorProjection, Receive, Send } from '../projection.ts'
import { installFileSurface } from '../viewer.ts'
import { applyWorkspaceZoom } from '../workspaceZoom.ts'

const toolbarButton = 'w-[30px] h-7 rounded-[5px] text-ide-accent text-lg hover:bg-ide-hover'
const conflictButton = 'px-[7px] py-1 rounded-[5px] border border-current'
const tabChrome = 'flex shrink-0 grow-0 items-stretch min-w-[100px] max-w-[210px] border-r border-ide-border @max-[420px]/editor:min-w-[82px] @max-[420px]/editor:max-w-[145px]'
/// The accent bar reads as "this one", drawn inside the tab so it does not shift the row.
const tabSelected = 'bg-ide-panel shadow-[inset_0_2px_var(--color-ide-accent)]'

export function mountEditor(container: HTMLElement, send: Send): Receive {
  const tabs = element('div', 'flex min-w-0 overflow-x-auto overflow-y-hidden border-b border-ide-border bg-ide-bg [scrollbar-width:thin]')
  tabs.setAttribute('role', 'tablist')
  const toolbar = element('div', 'flex items-center min-w-0 pl-2.5 pr-[5px] border-b border-ide-border bg-ide-panel')
  const sidebarToggle = button('☰', 'Toggle sidebar', () =>
    send({ type: 'setSidebarVisible', visible: !lastSidebarVisible }))
  const breadcrumb = element('nav', 'flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-ide-muted text-xs @max-[420px]/editor:text-[11px]')
  breadcrumb.setAttribute('aria-label', 'File breadcrumb')
  const modeToggle = button('Preview', 'Show file preview', () => {
    if (currentPath) send({ type: 'toggleMode', path: currentPath })
  })
  modeToggle.className = `${toolbarButton} w-auto px-2 text-xs`
  const zoomOut = button('−', 'Zoom out', () => send({ type: 'zoomOut' }))
  const zoomIn = button('+', 'Zoom in', () => send({ type: 'zoomIn' }))
  const terminalToggle = button('⌘', 'Toggle terminal', () =>
    send({ type: 'setTerminalVisible', visible: !lastTerminalVisible }))
  for (const control of [sidebarToggle, zoomOut, zoomIn, terminalToggle]) {
    control.className = toolbarButton
  }
  toolbar.append(sidebarToggle, breadcrumb, modeToggle, zoomOut, zoomIn, terminalToggle)
  const conflict = element('div', 'flex items-center gap-2 px-2.5 py-1.5 border-b border-ide-border bg-[color-mix(in_srgb,var(--color-ide-danger)_12%,var(--color-ide-panel))] text-ide-danger text-xs @max-[420px]/editor:flex-wrap')
  conflict.setAttribute('role', 'alert')
  // Both of these want the growable row and only ever one is on screen, so both name it. Leaving
  // it to auto-placement would slide them up whenever the conflict bar above is hidden, since a
  // hidden element stops being a grid item.
  const fileContent = element('main', 'ide-file-content row-start-4 min-h-0 overflow-hidden relative')
  const empty = element('div', 'row-start-4 grid place-items-center min-h-0 p-6 text-center text-ide-muted')
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
      const selected = tab.path === snapshot.activePath
      const wrapper = element('div', `${tabChrome} ${selected ? tabSelected : ''}`)
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
      select.className = 'flex flex-1 min-w-0 items-center gap-1.5 pl-2.5 pr-[5px] overflow-hidden whitespace-nowrap text-ellipsis hover:bg-ide-hover'
      select.setAttribute('role', 'tab')
      select.setAttribute('aria-selected', String(tab.path === snapshot.activePath))
      if (tab.dirty || tab.autosaving || tab.conflict) {
        const state = element('span', tab.conflict
          ? 'text-ide-danger font-bold'
          : 'text-ide-accent text-[9px]')
        state.textContent = tab.autosaving ? 'saving' : tab.conflict ? '!' : '●'
        select.append(state)
      }
      const close = button('×', `Close ${tab.name}`, () => send({ type: 'close', path: tab.path }))
      close.className = 'basis-7 grow-0 shrink-0 text-[17px] text-ide-muted hover:bg-ide-hover'
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
      const label = element('span', 'flex-1 @max-[420px]/editor:basis-full')
      label.textContent = 'This file changed on the host.'
      const useHost = button('Use Host', 'Replace local draft with host version', () =>
        send({ type: 'useHost', path: activeTab.path }))
      const keepMine = button('Keep Mine', 'Save local draft over latest host revision', () =>
        send({ type: 'keepMine', path: activeTab.path }))
      useHost.className = conflictButton
      keepMine.className = conflictButton
      conflict.append(label, useHost, keepMine)
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
