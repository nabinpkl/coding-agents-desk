import { installFileSurface } from './viewer.mjs'
import {
  fileIconShape,
  fileIconSpec,
  fileRenderIdentity,
  gitDecorationTone,
  normalizeProjection,
  orderedPathsAfterMove,
  regionFromLocation,
  sourceControlSections,
} from './ideModel.mjs'
import { applyWorkspaceZoom } from './workspaceZoom.mjs'

const root = document.getElementById('workspace-ide')
const region = regionFromLocation(window.location)
const post = (message) => window.webkit?.messageHandlers?.workspaceIDE?.postMessage(message)

/// Stroked outlines, not the filled brand marks the file rows use: these are chrome, so they read
/// as controls that take the row's colour rather than as another piece of content. Declared up
/// here because `mountSidebar` runs during module evaluation, below.
const sectionShapes = Object.freeze({
  explorer: 'M2.4 4.4c0-.7.6-1.3 1.3-1.3h2.6l1.5 1.6h4.5c.7 0 1.3.6 1.3 1.3v5.9c0 .7-.6 1.3-1.3 1.3H3.7c-.7 0-1.3-.6-1.3-1.3V4.4Z',
  sourceControl: 'M4.6 5.6v5M4.6 12.7a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8ZM4.6 5.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8ZM11.6 5.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8ZM11.6 5.6v1.1a2.6 2.6 0 0 1-2.6 2.6H6.5',
})

if (!region) throw new Error('Workspace IDE region is required')
document.body.dataset.region = region

let receive
if (region === 'sidebar') receive = mountSidebar(root, post)
else receive = mountEditor(root, post)

window.workspaceIDE = { receive }
post({ type: 'ready', region })

function mountSidebar(container, send) {
  const header = element('header', 'ide-sidebar-header')
  const workspaceSelect = element('select', 'workspace-select')
  workspaceSelect.setAttribute('aria-label', 'Select workspace')
  const addButton = button('+', 'Add workspace', () => send({ type: 'addWorkspace' }))
  header.append(workspaceSelect, addButton)

  const management = element('nav', 'ide-management')
  management.setAttribute('aria-label', 'Workspace management')
  const moveUpButton = button('↑', 'Move workspace earlier', () => reorderSelected(-1))
  const moveDownButton = button('↓', 'Move workspace later', () => reorderSelected(1))
  const assignButton = button('Display', 'Assign workspace to current Desktop', () => {
    if (workspaceSelect.value) send({ type: 'assignDesktop', id: workspaceSelect.value })
  })
  const autoAssignButton = button('Auto', 'Toggle automatic Desktop assignment', () => {
    const workspace = currentWorkspaces.find(({ id }) => id === workspaceSelect.value)
    if (workspace) send({
      type: 'setAutoAssignDesktop',
      id: workspace.id,
      enabled: !workspace.desktopAutoAssignEnabled,
    })
  })
  const removeButton = button('Remove', 'Remove workspace', () => {
    if (workspaceSelect.value) send({ type: 'removeWorkspace', id: workspaceSelect.value })
  })
  management.append(moveUpButton, moveDownButton, assignButton, autoAssignButton, removeButton)

  const activity = element('nav', 'ide-activity')
  activity.setAttribute('aria-label', 'Workspace sidebar sections')
  const explorerButton = sectionButton('explorer', 'Explorer', send)
  const sourceButton = sectionButton('sourceControl', 'Source Control', send)
  activity.append(explorerButton, sourceButton)

  const panel = element('section', 'ide-sidebar-panel')
  const alert = element('div', 'ide-alert')
  alert.setAttribute('role', 'status')
  container.replaceChildren(header, management, activity, alert, panel)

  let currentWorkspaces = []

  function reorderSelected(offset) {
    const index = currentWorkspaces.findIndex(({ id }) => id === workspaceSelect.value)
    const target = index + offset
    if (index < 0 || target < 0 || target >= currentWorkspaces.length) return
    const ids = currentWorkspaces.map(({ id }) => id)
    const selectedID = ids[index]
    ids[index] = ids[target]
    ids[target] = selectedID
    send({ type: 'reorderWorkspaces', ids })
  }

  workspaceSelect.addEventListener('change', () => {
    if (workspaceSelect.value) send({ type: 'selectWorkspace', id: workspaceSelect.value })
  })

  return (raw) => {
    const snapshot = normalizeProjection(raw, 'sidebar')
    if (!snapshot) return
    applyWorkspaceZoom(container, snapshot.zoomScale)
    currentWorkspaces = snapshot.workspaces
    const selected = snapshot.selectedWorkspaceID ?? ''
    workspaceSelect.replaceChildren(...snapshot.workspaces.map((workspace) => {
      const option = element('option')
      option.value = workspace.id
      option.textContent = workspace.name
      option.selected = workspace.id === selected
      return option
    }))
    workspaceSelect.disabled = snapshot.workspaces.length === 0
    addButton.hidden = !snapshot.capabilities.has('addWorkspace')
    const selectedIndex = snapshot.workspaces.findIndex(({ id }) => id === selected)
    const selectedWorkspace = snapshot.workspaces[selectedIndex]
    const canManage = ['removeWorkspace', 'reorderWorkspaces', 'assignDesktop', 'autoAssignDesktop']
      .some((capability) => snapshot.capabilities.has(capability))
    management.hidden = !canManage
    moveUpButton.hidden = !snapshot.capabilities.has('reorderWorkspaces')
    moveDownButton.hidden = !snapshot.capabilities.has('reorderWorkspaces')
    moveUpButton.disabled = selectedIndex <= 0
    moveDownButton.disabled = selectedIndex < 0 || selectedIndex >= snapshot.workspaces.length - 1
    assignButton.hidden = !snapshot.capabilities.has('assignDesktop')
    assignButton.disabled = !selectedWorkspace
    assignButton.textContent = selectedWorkspace?.desktopOrdinal
      ? `Desktop ${selectedWorkspace.desktopOrdinal}`
      : 'Assign Desktop'
    autoAssignButton.hidden = !snapshot.capabilities.has('autoAssignDesktop')
    autoAssignButton.disabled = !selectedWorkspace
    autoAssignButton.setAttribute('aria-pressed', String(Boolean(selectedWorkspace?.desktopAutoAssignEnabled)))
    autoAssignButton.classList.toggle('is-selected', Boolean(selectedWorkspace?.desktopAutoAssignEnabled))
    removeButton.hidden = !snapshot.capabilities.has('removeWorkspace')
    removeButton.disabled = !selectedWorkspace
    explorerButton.classList.toggle('is-selected', snapshot.section === 'explorer')
    sourceButton.classList.toggle('is-selected', snapshot.section === 'sourceControl')
    explorerButton.setAttribute('aria-pressed', String(snapshot.section === 'explorer'))
    sourceButton.setAttribute('aria-pressed', String(snapshot.section === 'sourceControl'))
    alert.textContent = snapshot.error ?? ''
    alert.hidden = !snapshot.error
    if (snapshot.section === 'sourceControl') {
      panel.replaceChildren(renderSourceControl(snapshot.gitEntries, send))
    } else {
      panel.replaceChildren(renderTree(snapshot.tree, send))
    }
  }
}

function renderTree(nodes, send, nested = false) {
  const tree = element('ul', 'ide-tree')
  tree.setAttribute('role', nested ? 'group' : 'tree')
  for (const node of nodes) {
    const item = element('li', 'ide-tree-item')
    item.setAttribute('role', 'treeitem')
    if (node.isDirectory) item.setAttribute('aria-expanded', String(Boolean(node.expanded)))
    const row = button('', node.isDirectory ? `${node.expanded ? 'Collapse' : 'Expand'} ${node.name}` : `Open ${node.name}`, () => {
      if (node.isDirectory) send({ type: 'setDirectoryExpanded', path: node.path, expanded: !node.expanded })
      else send({ type: 'open', path: node.path })
    })
    row.className = 'ide-tree-row'
    const disclosure = element('span', 'ide-disclosure')
    disclosure.textContent = node.isDirectory ? (node.expanded ? '▾' : '▸') : ''
    const icon = fileIcon(node.name, node.isDirectory, Boolean(node.expanded))
    const label = element('span', 'ide-tree-label')
    label.textContent = node.name
    row.append(disclosure, icon, label)
    const tone = gitDecorationTone(node.gitStatus)
    if (tone) {
      row.dataset.git = tone
      // Ignored rows carry no badge: dimming already says "not part of the repo", and a column
      // of amber marks beside every build artefact drowns the handful of real changes.
      if (tone !== 'ignored') {
        const status = element('span', 'ide-git-decoration')
        status.textContent = node.gitStatus.trim()
        row.append(status)
      }
    }
    item.append(row)
    if (node.isDirectory && node.expanded) item.append(renderTree(node.children ?? [], send, true))
    tree.append(item)
  }
  return tree
}

// Survives a projection re-render, which rebuilds the whole panel; collapsing a long Untracked
// group should not spring back open every time the workspace pushes a snapshot.
const collapsedSourceGroups = new Set()

function renderSourceControl(entries, send) {
  const container = element('div', 'ide-source')
  const sections = sourceControlSections(entries)
  if (!sections.length) {
    container.append(renderCleanWorkingTree())
    return container
  }
  for (const section of sections) container.append(renderSourceGroup(section, send))
  return container
}

function renderSourceGroup(section, send) {
  const group = element('section', 'ide-source-group')
  const collapsed = collapsedSourceGroups.has(section.id)
  const header = button('', `${collapsed ? 'Expand' : 'Collapse'} ${section.title}`, () => {
    if (!collapsedSourceGroups.delete(section.id)) collapsedSourceGroups.add(section.id)
    group.replaceWith(renderSourceGroup(section, send))
  })
  header.className = 'ide-source-group-header'
  header.dataset.tone = section.id
  header.setAttribute('aria-expanded', String(!collapsed))
  const disclosure = element('span', 'ide-disclosure')
  disclosure.textContent = collapsed ? '▸' : '▾'
  const title = element('span', 'ide-source-group-title')
  title.textContent = section.title
  const count = element('span', 'ide-source-count')
  count.textContent = String(section.rows.length)
  header.append(disclosure, title, count)
  group.append(header)
  if (!collapsed) group.append(renderSourceRows(section, send))
  return group
}

function renderSourceRows(section, send) {
  const list = element('ul', 'ide-source-list')
  list.setAttribute('aria-label', section.title)
  for (const row of section.rows) {
    const item = element('li')
    const control = button('', `Open ${row.path}`, () => send({ type: 'open', path: row.path }))
    control.className = 'ide-source-row'
    control.dataset.tone = row.tone
    control.title = row.path
    const badge = element('span', 'ide-source-badge')
    badge.textContent = row.letters
    const name = element('span', 'ide-source-name')
    name.textContent = row.name
    const directory = element('span', 'ide-source-dir')
    directory.textContent = row.directory
    control.append(badge, fileIcon(row.name, false), name, directory)
    item.append(control)
    list.append(item)
  }
  return list
}

function renderCleanWorkingTree() {
  const empty = element('div', 'ide-source-clean')
  const mark = element('span', 'ide-source-clean-mark')
  mark.textContent = '✓'
  mark.setAttribute('aria-hidden', 'true')
  const title = element('p', 'ide-source-clean-title')
  title.textContent = 'Working tree clean'
  const note = element('p', 'ide-source-clean-note')
  note.textContent = 'Nothing staged, changed, or untracked.'
  empty.append(mark, title, note)
  return empty
}

function mountEditor(container, send) {
  const tabs = element('div', 'ide-tabs')
  tabs.setAttribute('role', 'tablist')
  const toolbar = element('div', 'ide-editor-toolbar')
  const sidebarToggle = button('☰', 'Toggle sidebar', () => send({ type: 'setSidebarVisible', visible: !lastSidebarVisible }))
  const breadcrumb = element('nav', 'ide-breadcrumb')
  breadcrumb.setAttribute('aria-label', 'File breadcrumb')
  const modeToggle = button('Preview', 'Show file preview', () => {
    if (currentPath) send({ type: 'toggleMode', path: currentPath })
  })
  modeToggle.className = 'ide-mode-toggle'
  const zoomOut = button('−', 'Zoom out', () => send({ type: 'zoomOut' }))
  const zoomIn = button('+', 'Zoom in', () => send({ type: 'zoomIn' }))
  const terminalToggle = button('⌘', 'Toggle terminal', () => send({ type: 'setTerminalVisible', visible: !lastTerminalVisible }))
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
    messageSink(message) {
      if (message.type === 'dirty') send({ type: 'edit', path: currentPath, text: message.text })
    },
  })
  let currentIdentity = null
  let currentPath = null
  let draggedPath = null
  let lastSidebarVisible = true
  let lastTerminalVisible = true

  return (raw) => {
    const snapshot = normalizeProjection(raw, 'editor')
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
        send({ type: 'reorderTabs', paths: orderedPathsAfterMove(snapshot.tabs.map(({ path }) => path), draggedPath, tab.path) })
        draggedPath = null
      })
      const select = button(tab.name, `Open ${tab.name}`, () => send({ type: 'selectTab', path: tab.path }))
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
        button('Use Host', 'Replace local draft with host version', () => send({ type: 'useHost', path: activeTab.path })),
        button('Keep Mine', 'Save local draft over latest host revision', () => send({ type: 'keepMine', path: activeTab.path })),
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

function element(tag, className) {
  const value = document.createElement(tag)
  if (className) value.className = className
  return value
}

function button(title, label, action) {
  const value = element('button')
  value.type = 'button'
  value.textContent = title
  value.setAttribute('aria-label', label)
  value.addEventListener('click', action)
  return value
}

function sectionButton(section, label, send) {
  const control = button('', `Show ${label}`, () => send({ type: 'selectSidebarSection', section }))
  control.className = 'ide-activity-button'
  // The name is gone from the pixels but not from the surface: `aria-label` carries it to
  // VoiceOver and `title` brings it back on hover for anyone still learning the two glyphs.
  control.title = label
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', sectionShapes[section])
  svg.append(path)
  control.append(svg)
  return control
}

/// The generic outline drawn for a file whose type we carry no icon for. Deliberately uncoloured:
/// a grey page reads as "just a file", where a borrowed logo would assert a language it isn't.
const unknownFileShape = Object.freeze({
  viewBox: '0 0 16 16',
  body: '<path d="M3 1.5h6.2l3.8 3.8v9.2H3v-13Zm6 1.4v2.6h2.6L9 2.9Z"/>',
})

function fileIcon(name, isDirectory, isExpanded = false) {
  const { icon } = fileIconSpec(name, isDirectory, isExpanded)
  const shape = fileIconShape(icon) ?? unknownFileShape
  const container = element('span', 'ide-file-icon')
  container.setAttribute('aria-hidden', 'true')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', shape.viewBox)
  svg.setAttribute('focusable', 'false')
  // Build-time constant from src/generated/fileIcons.mjs, never a filename or any other runtime
  // value, so this carries no injection surface.
  svg.innerHTML = shape.body
  container.append(svg)
  return container
}
