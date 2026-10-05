// The agent-feed wire contract. See README.md: types only, long keys, no runtime exports.

export type {
  ActivityBlock,
  ActivityEvent,
  EventCacheHit,
  EventMode,
  ParsedLine,
  SourceId,
  TokenUsage,
} from "./activity.ts";

export type {
  ClaudeSessionEntrypoint,
  CliInputReceipt,
  CliInputStatus,
  CliInputUnavailableReason,
} from "./cliInput.ts";

export type {
  ComposerCommand,
  ComposerImageDrop,
  ComposerImageRef,
  ComposerPaste,
  ComposerKeyPress,
  ComposerImageMediaType,
  TmuxComposerEnvelope,
  TmuxComposerState,
  TmuxComposerUnavailableReason,
} from "./tmuxComposer.ts";

export {
  COMPOSER_IMAGE_MEDIA_TYPES,
  MAXIMUM_COMPOSER_IMAGE_BYTES,
} from "./tmuxComposer.ts";

export type {
  TmuxQuestionAnswer,
  TmuxQuestionOutcome,
  TmuxQuestionPoint,
  TmuxQuestionPointOutcome,
  TmuxQuestionRefusal,
  TmuxQuestionState,
} from "./tmuxQuestion.ts";

export {
  backfillTaskText,
  ANCHOR_POOLS,
  firstFreeAnchor,
  formatBotSessionTitle,
  parseBotSessionTitle,
  refuseTaskText,
  taskFromText,
} from "./botSessionTitle.ts";

export type {
  AddBotCommand,
  AddBotSessionsCommand,
  BotCanvasSessionChange,
  BotDeleted,
  BotCreatedBy,
  BotDirectoryEnvironment,
  BotFileRead,
  BotGitDiff,
  BotGitStatus,
  BotGrant,
  BotTree,
  BotLaunchCommand,
  BotSessionsAdded,
  BotSessionsRetired,
  BotMetadata,
  BotRecord,
  BotSessionRef,
  BotSnapshot,
  BotView,
  DetachBotSessionsCommand,
  RenameBracketCommand,
  RenamedBracket,
  ReorderBotSessionsCommand,
  RetireBotSessionsCommand,
  RetiredBotSession,
  SetBotCanvasCommand,
  UpdateBotCommand,
} from "./bot.ts";

export type {
  DesktopCursorKind,
  WebrtcCursorApplied,
  WebrtcCursorEvent,
  WebrtcCursorImage,
  WebrtcCursorPosition,
  WebrtcTileAnswer,
  WebrtcTileSourceMetadata,
} from "./desktop.ts";

export type {
  DesktopControlConfiguration,
  DesktopControlEvent,
  DesktopControlInput,
  DesktopPointerInput,
  DesktopScrollPhase,
  DesktopTextFocusEvent,
  InputRejectionReason,
  RemoteDigit,
  RemoteKeyCode,
  RemoteKeyEvent,
  RemoteLetter,
  RemoteModifier,
  TextInputEditability,
  TextInputFocusSource,
} from "./desktopControl.ts";
export type {
  DesktopAuditSnapshot,
  DesktopSpace,
  DesktopWindow,
  DesktopWindowBounds,
  WindowInputReason,
  WindowComposerEnvelope,
  WindowComposerStatus,
  WindowQuestionAction,
  WindowQuestionStatus,
  WindowResolution,
  WindowTarget,
} from "./desktopWindow.ts";
export {
  DESKTOP_CONTROL_MAX_KEY_BATCH,
  DESKTOP_CONTROL_MAX_MESSAGE_BYTES,
  DESKTOP_CONTROL_MAX_TEXT_UNITS,
} from "./desktopControl.ts";

export type {
  AgentQueueState,
  AgentRunState,
  AgentSessionCapabilities,
  Bin,
  ForkSessionCommand,
  LastSessionMessage,
  ProjectSummary,
  SessionSummary,
  StartedSession,
} from "./session.ts";

export type {
  ParkMove,
  ParkPlanResponse,
  ParkRect,
  ParkReport,
  ParkRestoreOutcome,
  ParkRestoreReport,
  ParkRestoreResult,
  ParkSide,
  ParkSpaceRef,
  ParkStateResponse,
  ParkStepResult,
  ParkUnavailable,
  ParkWindow,
} from "./park.ts";

export type {
  SummaryCoverage,
  SummaryFileAction,
  SummaryFileChange,
  SummaryPhase,
  SummaryResult,
  SummaryStreamMessage,
} from "./summary.ts";

export type {
  LimitsStreamMessage,
  QuotaReport,
  UsageCoverage,
  UsageDay,
  UsageModelTotals,
  UsageQuota,
  UsageReport,
  UsageStreamMessage,
  UsageTotals,
  UsageVendorId,
  VendorQuotas,
  VendorUsage,
} from "./usage.ts";

export type {
  SubagentForkOrigin,
  SubagentTranscriptMessage,
} from "./subagentTranscript.ts";

export type {
  AgentRunDetail,
  BackgroundTask,
  BackgroundTaskKind,
  BackgroundTaskProgress,
  BackgroundTaskSnapshot,
  BackgroundTaskState,
  RunningBackgroundTask,
  TaskActivity,
  TaskOutputMessage,
} from "./tasks.ts";

export type {
  AgentSessionTerminalContext,
  AgentTerminalContext,
  SessionTmuxTerminalContext,
  NewTmuxTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalHistory,
  AgentTerminalInput,
  AgentTerminalStreamEnvelope,
  AgentTerminalStreamMessage,
  AgentTerminalViewport,
  CloseAgentTerminalRequest,
  MachineShellBackend,
  MachineTerminalContext,
  OpenAgentTerminalRequest,
  TmuxPaneSummary,
  TmuxSessionSummary,
  TmuxTerminalContext,
  TmuxWindowSummary,
  WorkspaceTerminalContext,
} from "./terminal.ts";

export type {
  AgentCommandReceipt,
  AgentSessionDescriptor,
  AgentUiEvent,
  AgentUiRequest,
  AgentUiRequestKind,
  EventsPage,
  ProjectsPayload,
  SessionsPayload,
  SidecarConfig,
  SupervisorCommand,
  SupervisorCommandRequest,
  SupervisorMode,
  SupervisorStatus,
  TimelineEnvelope,
  TimelineMessage,
  WireErrorPayload,
  WireStreamError,
} from "./http.ts";
export { TIMELINE_HEARTBEAT_MS } from "./http.ts";
export { MACHINE_SHELL_SESSION } from "./terminal.ts";
export * from "./desktopNavigation.ts";

export type { RailKey, RailModifier, RailModifiers } from "./railKeys.ts";
export {
  applyModifiers,
  bytesForRailKey,
  controlByte,
  modifierParameter,
  NO_MODIFIERS,
} from "./railKeys.ts";

export type {
  WorkspaceBrowseEntry,
  WorkspaceBrowseListing,
  WorkspaceCommit,
  WorkspaceCommitDetail,
  WorkspaceChangeDiff,
  WorkspaceCommitDiff,
  WorkspaceCommitFile,
  WorkspaceDirectoryEntry,
  WorkspaceError,
  WorkspaceErrorCode,
  WorkspaceFileConflict,
  WorkspaceFileKind,
  WorkspaceFileList,
  WorkspaceFileMode,
  WorkspaceFileRead,
  WorkspaceFileRevision,
  WorkspaceFileWritten,
  WorkspaceFolderCreated,
  WorkspaceGitEntry,
  WorkspaceGitStatus,
  WorkspaceOperation,
  WorkspaceOperationRequest,
  WorkspaceSearchFile,
  WorkspaceSearchMatch,
  WorkspaceSearchOptions,
  WorkspaceSearchResult,
  WorkspaceSharedState,
  WorkspaceStreamEvent,
  WorkspaceSummary,
  WorkspaceTreeNode,
} from "./workspaceIde.ts";

export type {
  DirectoryEntry,
  DirectoryReachability,
  HubStreamEvent,
  Message,
  MessageAddress,
  MessageKind,
  MessagingSource,
  MessageRef,
  MessageState,
  PublishBotsRequest,
  PublishedBot,
  ReplyMessageRequest,
  SendMessageRequest,
  SenderKind,
  SessionAddress,
} from "./messaging.ts";
