// Answering the AskUserQuestion dialog of a Claude CLI running in a tmux pane.
//
// Sits beside `tmuxComposerRoutes.ts` and addresses sessions the same way, because it drives the
// same keyboard -- but it is one POST rather than a stream and a push, and that shape is the point.
// The panel already holds the question's content, from the tool call in the transcript; what it
// cannot see is the pane. So it sends the answers it wants to exist and the sidecar produces them,
// as one operation that either lands or reports why while handing back everything a reader typed.
//
// Claude-only, refused by the route pattern rather than by a runtime check, for the reason the
// composer route gives: the dialog this drives is the Claude TUI's.
//
// There is no read side. Whether a question is open is a fact the transcript already carries and
// the panel already reads; a second answer to that question, polled off a pane, would drift from
// it exactly when they disagreed.

import type { TmuxQuestionAnswer, TmuxQuestionOutcome } from "@agentdesk/agent-feed-wire";
import { errorResponse, jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

const QUESTION_ROUTE = /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/question$/i;

/**
 * The furthest this will go along with a caller.
 *
 * The tool's own schema allows four questions of four options; these are loose bounds around that
 * rather than a second copy of it, so a schema that grows by one does not need this edited, and a
 * request with a thousand of anything is still refused before it reaches a pane.
 */
const MAX_QUESTIONS = 16;
const MAX_OPTIONS = 32;
/** How much free text one answer may carry, which is typed one character at a time into a row. */
const MAX_OTHER_BYTES = 4_000;

/** The driver, injected, so the route's shape can be pinned without a tmux server. */
export interface TmuxQuestionDependencies {
  answer: (
    sessionId: string,
    answers: readonly TmuxQuestionAnswer[],
  ) => Promise<TmuxQuestionOutcome>;
}

export function createTmuxQuestionRoutes(question: TmuxQuestionDependencies): RouteHandler {
  return (request, url) => {
    const match = QUESTION_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    if (request.method !== "POST") return undefined;
    return answer(question, request, match[1]!.toLowerCase());
  };
}

async function answer(
  question: TmuxQuestionDependencies,
  request: Request,
  sessionId: string,
): Promise<Response> {
  let body: { answers?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return errorResponse("invalid-body", "the request body was not JSON", 400);
  }
  const answers = readAnswers(body.answers);
  if (typeof answers === "string") return errorResponse("answers-invalid", answers, 400);
  // 200 with the reason in the body, like the composer route next door: "that session is not in a
  // pane" is a fact the panel renders beside the question, not a malformed request. It is also the
  // shape that carries `keptText` back, which a 4xx body would invite a caller to discard.
  return jsonResponse(await question.answer(sessionId, answers));
}

/** The answers this request carries, or the sentence explaining why it carries none. */
function readAnswers(raw: unknown): TmuxQuestionAnswer[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "an answer must carry one entry per question in the dialog";
  }
  if (raw.length > MAX_QUESTIONS) return `no dialog has more than ${MAX_QUESTIONS} questions`;
  const answers: TmuxQuestionAnswer[] = [];
  for (const entry of raw) {
    const answer = readAnswer(entry);
    if (typeof answer === "string") return answer;
    answers.push(answer);
  }
  return answers;
}

function readAnswer(raw: unknown): TmuxQuestionAnswer | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "each answer must be an object";
  const entry = raw as Record<string, unknown>;
  const question = typeof entry.question === "string" ? entry.question.trim() : "";
  // The text is what the driver checks the pane against before it presses anything. Without it
  // there is nothing to check and the answers would land wherever the tabs happen to sit.
  if (!question) return "each answer must name the question it answers";

  const chosen: TmuxQuestionAnswer["chosen"] = [];
  if (entry.chosen !== undefined) {
    if (!Array.isArray(entry.chosen)) return "chosen must be a list of options";
    if (entry.chosen.length > MAX_OPTIONS) return `no question has more than ${MAX_OPTIONS} options`;
    for (const pick of entry.chosen) {
      if (!pick || typeof pick !== "object" || Array.isArray(pick)) return "each choice must be an object";
      const { index, label } = pick as Record<string, unknown>;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        return "each choice must name its option by index";
      }
      if (typeof label !== "string" || !label.trim()) {
        return "each choice must carry the label its index is expected to name";
      }
      chosen.push({ index, label: label.trim() });
    }
  }

  const other = typeof entry.other === "string" ? entry.other : "";
  if (Buffer.byteLength(other, "utf8") > MAX_OTHER_BYTES) {
    return "that is more text than a question row will take";
  }
  // A newline in free text would press Return partway through typing it, committing half an answer
  // and moving the dialog on. Refused rather than stripped: silently altering somebody's words is
  // the thing this whole route is shaped to avoid.
  if (/[\r\n]/.test(other)) return "free text cannot contain a line break";
  // A question with neither is one this would walk past, leaving the dialog unfinished and the
  // review screen refusing. The panel does not offer it, and it is refused here too.
  if (chosen.length === 0 && other.length === 0) return "each question needs an answer";
  return { question, chosen, other };
}
