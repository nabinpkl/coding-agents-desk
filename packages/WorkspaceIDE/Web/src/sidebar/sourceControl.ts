import { button, element, fileIcon } from '../dom.ts'
import { sourceControlSections } from '../ideModel.ts'
import type { GitEntry, Send } from '../projection.ts'

type Section = ReturnType<typeof sourceControlSections>[number]

// Survives a projection re-render, which rebuilds the whole panel; collapsing a long Untracked
// group should not spring back open every time the workspace pushes a snapshot.
//
// This is the one piece of view state the region owns rather than receives. A second or third of
// these is the signal to stop hand-rolling and reach for components with local state.
const collapsedSourceGroups = new Set<string>()

/// Sticky and opaque: rows scroll underneath it, and a translucent header would smear them.
const groupHeader = 'sticky top-0 z-1 flex w-full items-center gap-[5px] min-h-[26px] pl-[5px]'
  + ' pr-[9px] text-left bg-ide-bg text-[11px] uppercase tracking-[0.04em]'
  + ' text-ide-muted hover:text-ide-fg data-[tone=conflicts]:text-git-conflicted'

const row = 'group flex w-full items-center gap-1.5 min-h-row rounded pl-[5px] pr-[9px] py-0.5'
  + ' text-left hover:bg-ide-hover'

/// Every state tints its badge except conflict, which fills: a conflict blocks work, so it is the
/// one that should stop the eye. Its label takes the page background rather than white, staying
/// legible against a dark magenta in light mode and a light pink in dark mode.
const badge = 'grid place-items-center shrink-0 min-w-[18px] h-[17px] px-1 rounded font-mono'
  + ' text-[10px] leading-none bg-git-modified/15 text-git-modified'
  + ' group-data-[tone=added]:bg-git-added/15 group-data-[tone=added]:text-git-added'
  + ' group-data-[tone=untracked]:bg-git-untracked/15 group-data-[tone=untracked]:text-git-untracked'
  + ' group-data-[tone=deleted]:bg-git-deleted/15 group-data-[tone=deleted]:text-git-deleted'
  + ' group-data-[tone=conflicted]:bg-git-conflicted group-data-[tone=conflicted]:text-ide-bg'

const name = 'shrink min-w-0 overflow-hidden text-ellipsis whitespace-nowrap'
  + ' group-data-[tone=deleted]:line-through'

/// The directory is context, so it yields first and the filename survives the squeeze. A zero
/// flex-basis is what enforces that order: the directory only ever occupies leftover space, so it
/// collapses to nothing before the name gives up a single character. Below the container width
/// where it could say anything useful it goes entirely; the full path stays on the row's tooltip.
const directory = 'flex-1 basis-0 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap'
  + ' text-[11px] text-ide-muted @max-[210px]/sidebar:hidden'

export function renderSourceControl(entries: GitEntry[], send: Send): HTMLDivElement {
  const container = element('div', 'flex flex-col gap-0.5')
  const sections = sourceControlSections(entries)
  if (!sections.length) {
    container.append(renderCleanWorkingTree())
    return container
  }
  for (const section of sections) container.append(renderSourceGroup(section, send))
  return container
}

function renderSourceGroup(section: Section, send: Send): HTMLElement {
  const group = element('section')
  const collapsed = collapsedSourceGroups.has(section.id)
  const header = button('', `${collapsed ? 'Expand' : 'Collapse'} ${section.title}`, () => {
    if (!collapsedSourceGroups.delete(section.id)) collapsedSourceGroups.add(section.id)
    group.replaceWith(renderSourceGroup(section, send))
  })
  header.className = groupHeader
  header.dataset.tone = section.id
  header.setAttribute('aria-expanded', String(!collapsed))
  const disclosure = element('span', 'w-3 text-center')
  disclosure.textContent = collapsed ? '▸' : '▾'
  const title = element('span', 'overflow-hidden text-ellipsis whitespace-nowrap')
  title.textContent = section.title
  const count = element('span', 'ml-auto min-w-[17px] px-[5px] py-px rounded-[9px] bg-ide-hover'
    + ' text-ide-muted font-mono text-[10px]/[1.5] tracking-normal text-center')
  count.textContent = String(section.rows.length)
  header.append(disclosure, title, count)
  group.append(header)
  if (!collapsed) group.append(renderSourceRows(section, send))
  return group
}

function renderSourceRows(section: Section, send: Send): HTMLUListElement {
  const list = element('ul', 'list-none m-0 p-0')
  list.setAttribute('aria-label', section.title)
  for (const entry of section.rows) {
    const item = element('li')
    const control = button('', `Open ${entry.path}`, () => send({ type: 'open', path: entry.path }))
    control.className = row
    control.dataset.tone = entry.tone
    control.title = entry.path
    const letters = element('span', badge)
    letters.textContent = entry.letters
    const label = element('span', name)
    label.textContent = entry.name
    const path = element('span', directory)
    path.textContent = entry.directory
    control.append(letters, fileIcon(entry.name), label, path)
    item.append(control)
    list.append(item)
  }
  return list
}

function renderCleanWorkingTree(): HTMLDivElement {
  const empty = element('div', 'grid justify-items-center gap-[3px] px-4 py-[34px]'
    + ' text-center text-ide-muted')
  const mark = element('span', 'grid place-items-center size-7 mb-[3px] rounded-full'
    + ' bg-git-added/15 text-git-added text-[15px]')
  mark.textContent = '✓'
  mark.setAttribute('aria-hidden', 'true')
  const title = element('p', 'm-0 text-ide-fg')
  title.textContent = 'Working tree clean'
  const note = element('p', 'm-0 text-xs')
  note.textContent = 'Nothing staged, changed, or untracked.'
  empty.append(mark, title, note)
  return empty
}
