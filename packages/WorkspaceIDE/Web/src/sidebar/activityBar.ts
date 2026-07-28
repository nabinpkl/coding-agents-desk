import { button, element, glyph } from '../dom.ts'
import type { Send, SidebarSection } from '../projection.ts'

/// Stroked outlines, not the filled brand marks the file rows use: these are chrome, so they read
/// as controls that take the row's colour rather than as another piece of content.
const sectionShapes: Record<SidebarSection, string> = {
  explorer:
    'M2.4 4.4c0-.7.6-1.3 1.3-1.3h2.6l1.5 1.6h4.5c.7 0 1.3.6 1.3 1.3v5.9c0 .7-.6 1.3-1.3 1.3H3.7c-.7 0-1.3-.6-1.3-1.3V4.4Z',
  sourceControl:
    'M4.6 5.6v5M4.6 12.7a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8ZM4.6 5.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8ZM11.6 5.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8ZM11.6 5.6v1.1a2.6 2.6 0 0 1-2.6 2.6H6.5',
}

const sections: Array<{ id: SidebarSection; label: string }> = [
  { id: 'explorer', label: 'Explorer' },
  { id: 'sourceControl', label: 'Source Control' },
]

export interface ActivityBar {
  readonly root: HTMLElement
  select(section: SidebarSection): void
}

export function activityBar(send: Send): ActivityBar {
  const root = element('nav', 'ide-activity')
  root.setAttribute('aria-label', 'Workspace sidebar sections')
  const buttons = new Map<SidebarSection, HTMLButtonElement>()
  for (const { id, label } of sections) {
    const control = button('', `Show ${label}`, () =>
      send({ type: 'selectSidebarSection', section: id }))
    control.className = 'ide-activity-button'
    // The name is gone from the pixels but not from the surface: `aria-label` carries it to
    // VoiceOver and `title` brings it back on hover for anyone still learning the two glyphs.
    control.title = label
    control.append(glyph('ide-activity-glyph', sectionShapes[id]))
    buttons.set(id, control)
    root.append(control)
  }
  return {
    root,
    select(section) {
      for (const [id, control] of buttons) {
        control.classList.toggle('is-selected', id === section)
        control.setAttribute('aria-pressed', String(id === section))
      }
    },
  }
}
