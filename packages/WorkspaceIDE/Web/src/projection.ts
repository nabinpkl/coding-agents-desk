// The wire shapes Swift pushes into each webview, and the intents the webview posts back.
//
// These types exist because the same contract is written three times — `WorkspaceIDEProjection` in
// Swift, this file, and whatever reads it — and the abbreviated CodingKeys (`i`, `n`, `o`, `a`,
// `p`, `x`) make a drift silent rather than loud. Both spellings are declared here so
// `normalizeProjection` can accept either and everything downstream sees only the long one.

export type Region = 'sidebar' | 'editor'
export type SidebarSection = 'explorer' | 'sourceControl'
export type FileKind = 'text' | 'markdown' | 'notebook' | 'docx' | 'image' | 'pdf'
export type FileMode = 'edit' | 'preview'

export interface WorkspaceSummary {
  id: string
  name: string
  desktopOrdinal: number | null
  desktopAutoAssignEnabled: boolean
}

export interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  expanded?: boolean
  gitStatus?: string | null
  children?: TreeNode[]
}

export interface GitEntry {
  relativePath: string
  indexStatus: string | null
  workTreeStatus: string | null
}

export interface EditorTab {
  path: string
  name: string
  dirty?: boolean
  autosaving?: boolean
  conflict?: boolean
  protectedFromRemoteClose?: boolean
}

export interface FileProjection {
  id: string
  name: string
  path: string
  workspace: string
  root: string
  kind: FileKind
  mode: FileMode
  text?: string | null
  resourceURL?: string | null
  renderToken?: string | null
}

export interface SidebarProjection {
  region: 'sidebar'
  workspaces: WorkspaceSummary[]
  selectedWorkspaceID?: string | null
  section: SidebarSection
  tree: TreeNode[]
  gitEntries: GitEntry[]
  capabilities: Set<string>
  error?: string | null
  zoomScale: number
}

export interface EditorProjection {
  region: 'editor'
  workspaceName?: string | null
  tabs: EditorTab[]
  activePath?: string | null
  breadcrumb: string[]
  file?: FileProjection | null
  loading: boolean
  error?: string | null
  sidebarVisible: boolean
  terminalVisible: boolean
  zoomScale: number
}

/// Everything the webview can ask the host to do. The host validates each against the surface's
/// capabilities, so an intent reaching Swift is a request, never an instruction.
export type Intent =
  | { type: 'ready'; region: Region }
  | { type: 'diagnostic'; code: string }
  | { type: 'selectWorkspace'; id: string }
  | { type: 'addWorkspace' }
  | { type: 'selectSidebarSection'; section: SidebarSection }
  | { type: 'setDirectoryExpanded'; path: string; expanded: boolean }
  | { type: 'open'; path: string }
  | { type: 'close'; path: string }
  | { type: 'selectTab'; path: string }
  | { type: 'reorderTabs'; paths: string[] }
  | { type: 'toggleMode'; path: string }
  | { type: 'edit'; path: string | null; text: string }
  | { type: 'useHost'; path: string }
  | { type: 'keepMine'; path: string }
  | { type: 'setSidebarVisible'; visible: boolean }
  | { type: 'setTerminalVisible'; visible: boolean }
  | { type: 'zoomIn' }
  | { type: 'zoomOut' }

export type Send = (intent: Intent) => void

/// A mounted region: hand it a raw projection from Swift and it updates itself in place.
export type Receive = (projection: unknown) => void
