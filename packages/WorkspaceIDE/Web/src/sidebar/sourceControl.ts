import { button, element, fileIcon } from '../dom.ts'
import { sourceControlSections } from '../ideModel.ts'
import type { GitEntry, Send } from '../projection.ts'

type Section = ReturnType<typeof sourceControlSections>[number]

// Survives a projection re-render, which rebuilds the whole panel; collapsing a long Untracked
// group should not spring back open every time the workspace pushes a snapshot.
//
// This is the one piece of view state the region owns rather than receives. A second or third of
// these is the signal to stop hand-rolling and reach for a component library with local state.
const collapsedSourceGroups = new Set<string>()

export function renderSourceControl(entries: GitEntry[], send: Send): HTMLDivElement {
  const container = element('div', 'ide-source')
  const sections = sourceControlSections(entries)
  if (!sections.length) {
    container.append(renderCleanWorkingTree())
    return container
  }
  for (const section of sections) container.append(renderSourceGroup(section, send))
  return container
}

function renderSourceGroup(section: Section, send: Send): HTMLElement {
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

function renderSourceRows(section: Section, send: Send): HTMLUListElement {
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
    control.append(badge, fileIcon(row.name), name, directory)
    item.append(control)
    list.append(item)
  }
  return list
}

function renderCleanWorkingTree(): HTMLDivElement {
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
