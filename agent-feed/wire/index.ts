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
  AddBotCommand,
  AttachBotSessionsCommand,
  BotCreatedBy,
  BotDirectoryEnvironment,
  BotGrant,
  BotMetadata,
  BotRecord,
  BotSessionRef,
  BotSnapshot,
  BotView,
  DetachBotSessionsCommand,
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
  ProjectSummary,
  SessionSummary,
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
  NewSessionTerminalContext,
  SessionForkTerminalContext,
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
  TimelineEnvelope,
  TimelineMessage,
  WireErrorPayload,
  WireStreamError,
} from "./http.ts";
export * from "./desktopNavigation.ts";

export type { RailKey, RailModifier, RailModifiers } from "./railKeys.ts";
export {
  applyModifiers,
  bytesForRailKey,
  controlByte,
  modifierParameter,
  NO_MODIFIERS,
} from "./railKeys.ts";
