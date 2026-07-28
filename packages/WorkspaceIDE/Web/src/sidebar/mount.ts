import { button, element } from '../dom.ts'
import { normalizeProjection } from '../ideModel.ts'
import type { Receive, Send, SidebarProjection } from '../projection.ts'
import { applyWorkspaceZoom } from '../workspaceZoom.ts'
import { activityBar } from './activityBar.ts'
import { renderSourceControl } from './sourceControl.ts'
import { renderTree } from './tree.ts'

const controlChrome = 'h-7 rounded-[7px] border border-ide-border bg-ide-panel'

export function mountSidebar(container: HTMLElement, send: Send): Receive {
  const header = element('header', 'flex items-center gap-1.5 min-h-[42px] px-2 py-[7px] border-b border-ide-border')
  const workspaceSelect = element('select', `min-w-0 flex-1 px-[7px] ${controlChrome}`)
  workspaceSelect.setAttribute('aria-label', 'Select workspace')
  const addButton = button('+', 'Add workspace', () => send({ type: 'addWorkspace' }))
  addButton.className = `basis-7 grow-0 shrink-0 text-lg ${controlChrome}`
  header.append(workspaceSelect, addButton)

  const activity = activityBar(send)

  const panel = element('section', 'row-start-4 overflow-auto pt-1 pb-[18px]')
  const alert = element('div', 'px-[9px] py-1.5 border-b border-ide-border text-ide-danger text-xs')
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
