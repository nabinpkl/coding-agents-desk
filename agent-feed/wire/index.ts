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

export type { ClaudeSessionEntrypoint, CliSessionStatus } from "./cliSession.ts";

export type {
  ClaudeRunMode,
  ClaudeSdkAnswerCommand,
  ClaudeSdkAnswerOutcome,
  ClaudeSdkApprovalRequest,
  ClaudeSdkCommandOutcome,
  ClaudeSdkDecideCommand,
  ClaudeSdkModeCommand,
  ClaudeSdkModel,
  ClaudeSdkQueuedPrompt,
  ClaudeSdkModelCommand,
  ClaudeSdkPendingRequest,
  ClaudeSdkPromptCommand,
  ClaudeSdkQuestion,
  ClaudeSdkQuestionRequest,
  ClaudeSdkRefusal,
  ClaudeSdkRunStatus,
  ClaudeSdkSessionState,
  ClaudeSdkStreamMessage,
  ClaudeSdkSwitchCommand,
  ClaudeSdkSwitchOutcome,
  ClaudeSdkSwitchRefusal,
  ClaudeEffortLevel,
  ClaudeSdkEffortCommand,
} from "./claudeSdk.ts";
export { CLAUDE_EFFORT_LEVELS, CLAUDE_SDK_HEARTBEAT_MS, DISCONNECTED_CLAUDE_SDK_STATE } from "./claudeSdk.ts";

export type {
  ComposerCommand,
  ComposerImageDrop,
  ComposerImageRef,
  ComposerPaste,
  ComposerKeyPress,
  ComposerImageMediaType,
  ClaudePermissionMode,
  TmuxComposerEnvelope,
  TmuxComposerState,
  TmuxComposerUnavailableReason,
  TmuxPermissionModeOutcome,
  TmuxPermissionModeRequest,
} from "./tmuxComposer.ts";

export { CLAUDE_PERMISSION_MODES, COMPOSER_IMAGE_MEDIA_TYPES, MAXIMUM_COMPOSER_IMAGE_BYTES } from "./tmuxComposer.ts";

export type {
  AnswerAskOwnerCommand,
  AskOwnerAnswer,
  AskOwnerCall,
  AskOwnerChoice,
  AskOwnerOption,
  AskOwnerOutcome,
  AskOwnerQuestion,
  AskOwnerQuestionKind,
  AskOwnerRefusal,
  AskOwnerStreamMessage,
  AskOwnerVerdict,
  WaitAskOwnerCommand,
} from "./askOwner.ts";

export { ASK_OWNER_MAX_QUESTIONS } from "./askOwner.ts";

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
  isPoolAnchor,
  formatBotSessionTitle,
  parseBotSessionTitle,
  refuseTaskText,
  taskFromText,
} from "./botSessionTitle.ts";
export { isSaidText } from "./saidText.ts";
export { SCRATCH_BRIEF_LABEL, splitScratchBrief, withScratchBrief } from "./scratchBrief.ts";
export type { EventsPageAt } from "./pageAt.ts";
export { eventsPageAtFromQuery, eventsPageAtQuery } from "./pageAt.ts";
export { BOT_CANVAS_NAMES, BOT_SESSION_HUE_COUNT } from "./bot.ts";

export type {
  AddBotCommand,
  AddBotSessionsCommand,
  BotCanvasMembership,
  BotCanvasName,
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
  BotSessionPlaced,
  BotSessionsAdded,
  BotSessionsRetired,
  BotMetadata,
  BotRecord,
  BotSessionRef,
  BotSnapshot,
  BotView,
  DetachBotSessionsCommand,
  PlaceBotSessionCommand,
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
  SessionAutomation,
  SessionSummary,
  StartedSession,
  StartedSourceSession,
  StartScratchCommand,
  StartSessionCommand,
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
  ArenaContestantDetail,
  ArenaContestantSource,
  ArenaContestantStatus,
  ArenaContestantSummary,
  ArenaCreateRunRequest,
  ArenaManagerStatus,
  ArenaManagerSummary,
  ArenaLaneRequest,
  ArenaLaneStance,
  ArenaAddLanesRequest,
  ArenaNewRunDefaults,
  ArenaOutsideReach,
  ArenaPassRequest,
  ArenaFoldersRequest,
  ArenaFolderCheck,
  ArenaFoldersResponse,
  ArenaMakeRepositoryRequest,
  ArenaPromptRequest,
  ArenaRunDetail,
  ArenaRunMode,
  ArenaRunSummary,
  ArenaRunsStreamMessage,
} from "./arena.ts";
export { ARENA_LIVE_STATUSES } from "./arena.ts";

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
  QuotaVendorId,
  VendorQuotas,
  VendorUsage,
} from "./usage.ts";

export type { SubagentForkOrigin, SubagentTranscriptMessage } from "./subagentTranscript.ts";

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
  ClaudeSessionActivity,
  RestartStaleSessionsRequest,
  RestartStaleSessionsResponse,
  StaleClaudeSession,
  StaleClaudeSessions,
  StaleSessionReason,
  StaleSessionRestartOutcome,
  StaleSessionRestartResult,
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
  RecentSession,
  RecentSessionsPayload,
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
export { applyModifiers, bytesForRailKey, controlByte, modifierParameter, NO_MODIFIERS } from "./railKeys.ts";

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
  FolderFileRead,
  FolderGitDiff,
  FolderGitStatus,
  FolderTree,
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
  SentMessageKind,
  SessionAddress,
} from "./messaging.ts";
export { SENT_MESSAGE_KIND_HELP, SENT_MESSAGE_KINDS } from "./messaging.ts";
export type { PushKeyResponse, PushTestResponse } from "./webPush.ts";
export { PUSH_KEY_ROUTE, PUSH_SUBSCRIPTIONS_ROUTE, PUSH_TEST_ROUTE } from "./webPush.ts";
export type {
  AudioListenersResponse,
  AudioMix,
  AudioMixRequest,
  AudioNoiseColor,
  AudioSpeakRequest,
  AudioSpeakResponse,
  SpeechHereRequest,
  SpeechReadRequest,
  SpeechReadResponse,
} from "./audioChannel.ts";
export {
  AUDIO_LEVEL_MAX,
  AUDIO_LISTENERS_ROUTE,
  AUDIO_MIX_ROUTE,
  AUDIO_NOISE_COLORS,
  AUDIO_SPEAK_MAX_CHARS,
  AUDIO_SPEAK_ROUTE,
  AUDIO_STREAM_ROUTE,
  SPEECH_HERE_ROUTE,
  SPEECH_HERE_STOP_ROUTE,
  SPEECH_READ_MAX_CHARS,
  SPEECH_READ_ROUTE,
  SPEECH_SAMPLE_RATE,
  SPEECH_STOP_ROUTE,
} from "./audioChannel.ts";
