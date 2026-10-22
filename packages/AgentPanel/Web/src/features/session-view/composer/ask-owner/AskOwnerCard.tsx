"use client";

// An ask_owner call in the band, in the frame Claude's own questions are drawn in.

import { QuestionFrame } from "@/features/session-view/composer/question/QuestionFrame";
import { AskOwnerSection } from "@/features/session-view/composer/ask-owner/AskOwnerSection";
import type { AskOwnerModel } from "@/features/session-view/composer/ask-owner/useAskOwner";

export function AskOwnerCard({ model }: { model: AskOwnerModel }) {
  const { call, drafts } = model;
  const only = call.questions.length === 1 ? call.questions[0] : undefined;
  return (
    <QuestionFrame
      label="Claude asks the owner"
      name="Claude's question for the owner"
      questions={call.questions}
      answered={model.answered}
      pending={model.pending}
      disabled={false}
      error={model.error}
      canSubmit={model.canSubmit}
      hint={only?.kind === "text" ? "Type your answer" : undefined}
      onSubmit={model.submit}
      onDismiss={model.dismiss}
      renderQuestion={(at, { showHeader, inert }) => (
        <AskOwnerSection
          question={call.questions[at]!}
          draft={drafts[at]!}
          showHeader={showHeader}
          inert={inert}
          onChoose={(option) => model.choose(at, option)}
          onWriteNote={(option, note) => model.writeNote(at, option, note)}
          onWriteText={(text) => model.writeText(at, text)}
        />
      )}
    />
  );
}
