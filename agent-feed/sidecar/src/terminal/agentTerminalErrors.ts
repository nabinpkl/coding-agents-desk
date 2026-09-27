// What a terminal request can be refused for, and the checks that refuse it.
//
// The four errors are the whole vocabulary the HTTP routes map onto status codes, so they
// live together rather than beside whichever call site throws them first. The validators
// are here for the same reason: each exists only to produce an `AgentTerminalInvalidError`,
// and a reader looking for what makes a request invalid finds both halves in one place.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class AgentTerminalInvalidError extends Error {}
export class AgentTerminalNotFoundError extends Error {}
export class AgentTerminalConflictError extends Error {}
export class AgentTerminalUnavailableError extends Error {}

/**
 * A canonical lower-case UUID, or a refusal naming which field was wrong.
 *
 * A pane name is derived from these, so a value that is merely close enough would put two
 * different requests on one pane.
 */
export function requiredSessionUuid(value: string, field: string): string {
  const canonical = value.toLowerCase();
  if (!UUID_PATTERN.test(canonical) || value !== canonical) {
    throw new AgentTerminalInvalidError(`${field} must be a canonical UUID`);
  }
  return canonical;
}

/**
 * An opencode session id, or a refusal naming which field was wrong.
 *
 * The serve mints `ses_`-prefixed ids, not UUIDs, so the pane-name rule above -- one id, one
 * pane -- is kept by checking the serve's own shape rather than by forcing opencode ids
 * through the UUID check, which would refuse every one of them.
 */
export function requiredOpencodeSessionId(value: string, field: string): string {
  if (!/^ses_[A-Za-z0-9]+$/.test(value)) {
    throw new AgentTerminalInvalidError(`${field} must be an opencode session id`);
  }
  return value;
}

export function requiredDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new AgentTerminalInvalidError(`${name} must be an integer between 1 and 1000`);
  }
  return value;
}

export function decodedBase64Length(value: string): number {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AgentTerminalInvalidError("base64 terminal input is malformed");
  }
  return Buffer.from(value, "base64").byteLength;
}