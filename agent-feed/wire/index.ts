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
  ComposerKeyPress,
  ComposerImageMediaType,
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
  TmuxQuestionRefusal,
} from "./tmuxQuestion.ts";

export type {
  AddBotCommand,
  AddBotSessionsCommand,
  BotCreatedBy,
  BotDirectoryEnvironment,
  BotGrant,
  BotLaunchCommand,
  BotSessionsAdded,
  BotSessionsRetired,
  BotMetadata,
  BotRecord,
  BotSessionRef,
  BotSnapshot,
  BotView,
  DetachBotSessionsCommand,
  RetireBotSessionsCommand,
  RetiredBotSession,
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
  UsageCoverage,
  UsageDay,
  UsageModelTotals,
  UsageQuota,
  UsageReport,
  UsageStreamMessage,
  UsageTotals,
  UsageVendorId,
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
  AgentTerminalDescriptor,
  AgentTerminalHistory,
  AgentTerminalInput,
  AgentTerminalStreamEnvelope,
  AgentTerminalStreamMessage,
  AgentTerminalViewport,
  CloseAgentTerminalRequest,
  OpenAgentTerminalRequest,
  TmuxSessionSummary,
  TmuxTerminalContext,
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
  WorkspaceCommitDiff,
  WorkspaceCommitFile,
  WorkspaceDirectoryEntry,
  WorkspaceError,
  WorkspaceErrorCode,
  WorkspaceFileConflict,
  WorkspaceFileKind,
  WorkspaceFileMode,
  WorkspaceFileRead,
  WorkspaceFileRevision,
  WorkspaceFileWritten,
  WorkspaceGitEntry,
  WorkspaceGitStatus,
  WorkspaceOperation,
  WorkspaceOperationRequest,
  WorkspaceSharedState,
  WorkspaceStreamEvent,
  WorkspaceSummary,
  WorkspaceTreeNode,
} from "./workspaceIde.ts";
