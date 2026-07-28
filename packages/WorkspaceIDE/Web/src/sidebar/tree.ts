import { button, chevron, element, fileIcon } from '../dom.ts'
import { gitDecorationTone } from '../ideModel.ts'
import type { Send, TreeNode } from '../projection.ts'

const row = 'group flex w-full items-center gap-[5px] min-h-row rounded pl-[5px] pr-[7px] py-0.5'
  + ' text-left hover:bg-ide-hover data-[git=ignored]:opacity-45'

/// The chevron dims with the rest of the row until you hover it, which is the only affordance
/// saying a directory row does something different from a file row.
const chevronHover = 'text-ide-muted group-hover:text-ide-fg'

const decoration = 'ml-auto font-mono text-[11px] leading-none text-git-modified'
  + ' group-data-[git=added]:text-git-added group-data-[git=untracked]:text-git-untracked'
  + ' group-data-[git=deleted]:text-git-deleted group-data-[git=conflicted]:text-git-conflicted'

export function renderTree(nodes: TreeNode[], send: Send, nested = false): HTMLUListElement {
  const tree = element('ul', `list-none m-0 p-0 ${nested ? 'pl-[13px]' : ''}`)
  tree.setAttribute('role', nested ? 'group' : 'tree')
  for (const node of nodes) {
    const item = element('li')
    item.setAttribute('role', 'treeitem')
    if (node.isDirectory) item.setAttribute('aria-expanded', String(Boolean(node.expanded)))
    const control = button(
      '',
      node.isDirectory
        ? `${node.expanded ? 'Collapse' : 'Expand'} ${node.name}`
        : `Open ${node.name}`,
      () => {
        if (node.isDirectory) {
          send({ type: 'setDirectoryExpanded', path: node.path, expanded: !node.expanded })
        } else {
          send({ type: 'open', path: node.path })
        }
      },
    )
    control.className = row
    // A directory's chevron IS its mark, so it takes the icon column outright: a folder glyph
    // beside it said the same thing twice, and dropping it lets the chevron grow to a size you
    // can actually aim at while filenames stay aligned down the column.
    let mark: SVGSVGElement
    if (node.isDirectory) {
      mark = chevron(Boolean(node.expanded))
      mark.setAttribute('class', `${mark.getAttribute('class')} ${chevronHover}`)
    } else {
      mark = fileIcon(node.name)
    }
    const label = element('span', 'overflow-hidden text-ellipsis whitespace-nowrap')
    label.textContent = node.name
    control.append(mark, label)
    const tone = gitDecorationTone(node.gitStatus)
    if (tone) {
      control.dataset.git = tone
      // Ignored rows carry no badge: dimming already says "not part of the repo", and a column
      // of amber marks beside every build artefact drowns the handful of real changes.
      if (tone !== 'ignored') {
        const status = element('span', decoration)
        status.textContent = (node.gitStatus ?? '').trim()
        control.append(status)
      }
    }
    item.append(control)
    if (node.isDirectory && node.expanded) item.append(renderTree(node.children ?? [], send, true))
    tree.append(item)
  }
  return tree
}
