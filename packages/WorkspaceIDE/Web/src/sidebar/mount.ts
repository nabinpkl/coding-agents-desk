import { button, element } from '../dom.ts'
import { normalizeProjection } from '../ideModel.ts'
import type { Receive, Send, SidebarProjection } from '../projection.ts'
import { applyWorkspaceZoom } from '../workspaceZoom.ts'
import { activityBar } from './activityBar.ts'
import { renderSourceControl } from './sourceControl.ts'
import { renderTree } from './tree.ts'

export function mountSidebar(container: HTMLElement, send: Send): Receive {
  const header = element('header', 'ide-sidebar-header')
  const workspaceSelect = element('select', 'workspace-select')
  workspaceSelect.setAttribute('aria-label', 'Select workspace')
  const addButton = button('+', 'Add workspace', () => send({ type: 'addWorkspace' }))
  header.append(workspaceSelect, addButton)

  const activity = activityBar(send)

  const panel = element('section', 'ide-sidebar-panel')
  const alert = element('div', 'ide-alert')
  alert.setAttribute('role', 'status')
  container.replaceChildren(header, activity.root, alert, panel)

  workspaceSelect.addEventListener('change', () => {
    if (workspaceSelect.value) send({ type: 'selectWorkspace', id: workspaceSelect.value })
  })

  return (raw) => {
    const snapshot = normalizeProjection(raw, 'sidebar') as SidebarProjection | null
    if (!snapshot) return
    applyWorkspaceZoom(container, snapshot.zoomScale)
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
    activity.select(snapshot.section)
    alert.textContent = snapshot.error ?? ''
    alert.hidden = !snapshot.error
    panel.replaceChildren(
      snapshot.section === 'sourceControl'
        ? renderSourceControl(snapshot.gitEntries, send)
        : renderTree(snapshot.tree, send),
    )
  }
}
