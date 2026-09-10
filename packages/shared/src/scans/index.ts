export {
  SCAN_STATUSES,
  SCAN_PHASES,
  TERMINAL_SCAN_STATUSES,
  QUOTA_OCCUPYING_SCAN_STATUSES,
  isTerminalScanStatus,
  isScanStatus,
  canTransition,
  occupiesQuota,
  canPause,
  canResume,
  canCancel,
  type ScanStatus,
  type ScanPhase,
} from './lifecycle.js';

export {
  SCAN_PROFILES,
  SCAN_PROFILE_PRESETS,
  SCAN_CONFIGURATION_BOUNDS,
  resolveScanConfiguration,
  type ScanProfile,
  type ScanConfiguration,
  type ScanConfigurationProblem,
  type ScanConfigurationProblemCode,
  type ResolvedScanConfiguration,
} from './profiles.js';

export {
  SCAN_EVENT_TYPES,
  SCAN_WARNING_CODES,
  FINDING_SEVERITIES,
  isScanEvent,
  type ScanEventType,
  type ScanWarningCode,
  type FindingSeverity,
  type ScanEventBase,
  type ScanStatusEvent,
  type ScanProgressEvent,
  type ScanFindingEvent,
  type ScanWarningEvent,
  type ScanEvent,
} from './events.js';

export {
  SCAN_QUEUE_NAME,
  isScanJobPayload,
  scanJobQueueId,
  type ScanJobPayload,
} from './queue.js';

export {
  PROGRESS_INTERVAL_MS,
  CANCEL_DEADLINE_MS,
  POLL_INTERVAL_MS,
  WS_PING_INTERVAL_MS,
} from './timing.js';

export {
  deriveScanWarnings,
  mergeScanWarnings,
  type ScanWarning,
  type ScanWarningSource,
} from './warnings.js';

export {
  SCAN_SOCKET_PING_TYPE,
  isScanSocketPing,
  type ScanSocketPing,
} from './socket.js';
