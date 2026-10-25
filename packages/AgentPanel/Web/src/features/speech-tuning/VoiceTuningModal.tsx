"use client";

// The processing the Mac's speech process puts on speech, tuned while listening: each control is
// sent as it moves (`speechTuning.ts`) and heard in the message already playing, so the reader can
// press "Hear it" once and drag through a whole sentence of it.

import { useRef, useState } from "react";
import { Radio, X } from "lucide-react";
import type { SpeechTuning, SpeechTuningNumber, SpeechTuningState } from "@agentdesk/agent-feed-wire";
import { panelQueryClient, queryFailure, usePanelQuery } from "@/query/panelQuery";
import { useModal } from "@/hooks/dom/overlays";
import { createTuningSender, hearTuning, readSpeechTuning } from "@/features/speech-tuning/speechTuning";

const QUERY_KEY = ["speech-tuning"] as const;

type Control = { key: SpeechTuningNumber; label: string; shown: (value: number) => string };

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

const GROUPS: { title: string; controls: Control[] }[] = [
  {
    title: "Loudness",
    controls: [
      { key: "loudnessDb", label: "Loudness", shown: (value) => `${signed(value)} dB` },
      { key: "thresholdDb", label: "Compressor threshold", shown: (value) => `${value} dB` },
      { key: "ratio", label: "Compression ratio", shown: (value) => `${value}:1` },
      { key: "releaseMs", label: "Recovery", shown: (value) => `${value} ms` },
    ],
  },
  {
    title: "Tone",
    controls: [
      { key: "boomCutHz", label: "Cut boom below", shown: (value) => `${value} Hz` },
      { key: "mudDb", label: "Mud dip at 300 Hz", shown: (value) => `${value} dB` },
      { key: "presenceDb", label: "Consonant lift at 3 kHz", shown: (value) => `${signed(value)} dB` },
    ],
  },
];

export function VoiceTuningModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useModal(dialog, open);

  return (
    <dialog
      ref={dialog}
      aria-label="Voice tuning"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      className="m-auto max-h-[88dvh] w-[min(30rem,94vw)] overflow-hidden rounded-xl border border-border
        bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      {open ? <VoiceTuningPanel onClose={onClose} /> : null}
    </dialog>
  );
}

/** The body, exported apart from the dialog because jsdom cannot open a `<dialog>`. */
export function VoiceTuningPanel({ onClose }: { onClose: () => void }) {
  const query = usePanelQuery({ queryKey: QUERY_KEY, queryFn: readSpeechTuning });
  // What the reader has moved and the speech process has not yet answered for, over its answer.
  const [edits, setEdits] = useState<Partial<SpeechTuning>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [hearing, setHearing] = useState(false);
  const [sender] = useState(() =>
    createTuningSender({
      onAnswer: (state: SpeechTuningState) => {
        panelQueryClient.setQueryData(QUERY_KEY, state);
        setEdits((current) => {
          const left: Partial<SpeechTuning> = {};
          for (const [key, value] of Object.entries(current)) {
            if (state.tuning[key as keyof SpeechTuning] !== value) Object.assign(left, { [key]: value });
          }
          return left;
        });
      },
      onFailure: (error, unsent) => {
        setStatus(`Not saved: ${error.message}`);
        setEdits((current) => {
          const left = { ...current };
          for (const key of Object.keys(unsent)) delete left[key as keyof SpeechTuning];
          return left;
        });
      },
    }),
  );

  const change = <K extends keyof SpeechTuning>(key: K, value: SpeechTuning[K]) => {
    setStatus(null);
    setEdits((current) => ({ ...current, [key]: value }));
    sender.change(key, value);
  };

  const hear = async () => {
    setHearing(true);
    setStatus(null);
    const why = await hearTuning().catch((error: unknown) => queryFailure(error));
    setHearing(false);
    if (why) setStatus(why);
  };

  const tuning = query.data ? { ...query.data.tuning, ...edits } : null;

  return (
    <div className="flex max-h-[88dvh] flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Voice tuning</h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground
            focus-visible:outline-2 focus-visible:outline-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      {query.isError ? (
        <div className="flex flex-col items-start gap-2 px-4 py-6 text-sm">
          <p role="alert">Could not read the voice settings: {queryFailure(query.error)}</p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="rounded-md border border-border px-3 py-1.5 transition-colors hover:bg-accent
              focus-visible:outline-2 focus-visible:outline-primary"
          >
            Try again
          </button>
        </div>
      ) : !tuning || !query.data ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-4 py-4">
          <div className="flex flex-col gap-2">
            <Switch label="Process speech" checked={tuning.on} onChange={(on) => change("on", on)} />
            <Switch
              label="Even out voices"
              checked={tuning.evenLevels}
              onChange={(even) => change("evenLevels", even)}
            />
          </div>
          {GROUPS.map((group) => (
            <section key={group.title} className="flex flex-col gap-3">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.title}</h3>
              {group.controls.map((control) => (
                <Slider
                  key={control.key}
                  control={control}
                  value={tuning[control.key]}
                  range={query.data.ranges[control.key]}
                  onChange={(value) => change(control.key, value)}
                />
              ))}
            </section>
          ))}
        </div>
      )}

      <footer className="flex items-center gap-3 border-t border-border px-4 py-3">
        {/* Space kept whether or not there is anything to say, so the footer never moves. */}
        <p role="status" className="min-h-5 min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {status}
        </p>
        <button
          type="button"
          disabled={hearing || !tuning}
          onClick={() => void hear()}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground
            transition-colors hover:bg-primary/90 active:bg-primary/80 focus-visible:outline-2
            focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Radio className="size-4" aria-hidden />
          Hear it
        </button>
      </footer>
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 cursor-pointer accent-primary focus-visible:outline-2 focus-visible:outline-primary"
      />
    </label>
  );
}

function Slider({
  control,
  value,
  range,
  onChange,
}: {
  control: Control;
  value: number;
  range: { min: number; max: number; step: number };
  onChange: (value: number) => void;
}) {
  const id = `voice-tuning-${control.key}`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <label htmlFor={id}>{control.label}</label>
        <output htmlFor={id} className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {control.shown(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full cursor-pointer accent-primary focus-visible:outline-2 focus-visible:outline-primary"
      />
    </div>
  );
}
