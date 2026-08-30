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

export type { DesktopDisplayResponse } from "./desktop.ts";

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
  WebrtcPointerInput,
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
