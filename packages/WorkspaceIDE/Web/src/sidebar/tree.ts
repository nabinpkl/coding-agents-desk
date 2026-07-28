import { button, chevron, element, fileIcon } from '../dom.ts'
import { gitDecorationTone } from '../ideModel.ts'
import type { Send, TreeNode } from '../projection.ts'

export function renderTree(nodes: TreeNode[], send: Send, nested = false): HTMLUListElement {
  const tree = element('ul', 'ide-tree')
  tree.setAttribute('role', nested ? 'group' : 'tree')
  for (const node of nodes) {
    const item = element('li', 'ide-tree-item')
    item.setAttribute('role', 'treeitem')
    if (node.isDirectory) item.setAttribute('aria-expanded', String(Boolean(node.expanded)))
    const row = button(
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
    row.className = 'ide-tree-row'
    // A directory's chevron IS its mark, so it takes the icon column outright: a folder glyph
    // beside it said the same thing twice, and dropping it lets the chevron grow to a size you
    // can actually aim at while filenames stay aligned down the column.
    const mark = node.isDirectory ? chevron(Boolean(node.expanded)) : fileIcon(node.name)
    const label = element('span', 'ide-tree-label')
    label.textContent = node.name
    row.append(mark, label)
    const tone = gitDecorationTone(node.gitStatus)
    if (tone) {
      row.dataset.git = tone
      // Ignored rows carry no badge: dimming already says "not part of the repo", and a column
      // of amber marks beside every build artefact drowns the handful of real changes.
      if (tone !== 'ignored') {
        const status = element('span', 'ide-git-decoration')
        status.textContent = (node.gitStatus ?? '').trim()
        row.append(status)
      }
    }
    item.append(row)
    if (node.isDirectory && node.expanded) item.append(renderTree(node.children ?? [], send, true))
    tree.append(item)
  }
  return tree
}
