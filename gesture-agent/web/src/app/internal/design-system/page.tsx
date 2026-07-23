"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const BUTTON_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
] as const;

const BADGE_VARIANTS = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
] as const;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="rounded-xl bg-card p-6 ring-1 ring-foreground/10">
        {children}
      </div>
    </section>
  );
}

export default function DesignSystemPage() {
  const [sliderValue, setSliderValue] = useState<number | readonly number[]>(50);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-2">
        <Badge variant="outline" className="w-fit">
          Internal
        </Badge>
        <h1 className="text-2xl font-semibold tracking-tight">Design System</h1>
        <p className="text-muted-foreground">
          Visual QA gallery for every shared primitive. Toggle the app theme in
          the nav to check light and dark rendering.
        </p>
      </header>

      <Section
        title="Button"
        description="Every variant across the default, small, and icon sizes."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            {BUTTON_VARIANTS.map((variant) => (
              <Button key={variant} variant={variant}>
                {variant}
              </Button>
            ))}
          </div>
          <Separator />
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" aria-label="Icon" variant="outline">
              <span className="text-xs">Aa</span>
            </Button>
            <Button disabled>Disabled</Button>
          </div>
        </div>
      </Section>

      <Section
        title="Badge"
        description="Compact status and label chips in every variant."
      >
        <div className="flex flex-wrap items-center gap-3">
          {BADGE_VARIANTS.map((variant) => (
            <Badge key={variant} variant={variant}>
              {variant}
            </Badge>
          ))}
        </div>
      </Section>

      <Section
        title="Card"
        description="Container with header, content, and footer slots."
      >
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Recording 042</CardTitle>
            <CardDescription>Captured 2.4s of audio at 16 kHz.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            The quick brown fox jumps over the lazy dog.
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button variant="ghost" size="sm">
              Discard
            </Button>
            <Button size="sm">Analyze</Button>
          </CardFooter>
        </Card>
      </Section>

      <Section
        title="Tabs"
        description="Segmented panels in the default and line variants."
      >
        <Tabs defaultValue="signals" className="max-w-md">
          <TabsList>
            <TabsTrigger value="signals">Signals</TabsTrigger>
            <TabsTrigger value="pronunciation">Pronunciation</TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
          </TabsList>
          <TabsContent value="signals" className="pt-3 text-sm text-muted-foreground">
            RMS, peak, and pitch contours of the captured audio.
          </TabsContent>
          <TabsContent
            value="pronunciation"
            className="pt-3 text-sm text-muted-foreground"
          >
            Alignment against a reference recording.
          </TabsContent>
          <TabsContent
            value="transcript"
            className="pt-3 text-sm text-muted-foreground"
          >
            The final offline transcription pass.
          </TabsContent>
        </Tabs>
      </Section>

      <Section
        title="Select"
        description="Popover menu bound to a single value."
      >
        <Select defaultValue="sherpa">
          <SelectTrigger className="w-56">
            <SelectValue placeholder="ASR engine" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sherpa">Sherpa (streaming)</SelectItem>
            <SelectItem value="mlx">MLX (chunked)</SelectItem>
            <SelectItem value="offline">Offline (final pass)</SelectItem>
          </SelectContent>
        </Select>
      </Section>

      <Section
        title="Slider"
        description="Continuous range input, useful for preamp gain."
      >
        <div className="flex max-w-md flex-col gap-2">
          <Slider
            value={sliderValue}
            onValueChange={setSliderValue}
            min={0}
            max={100}
          />
          <span className="text-sm text-muted-foreground tabular-nums">
            Value: {Array.isArray(sliderValue) ? sliderValue.join(", ") : sliderValue}
          </span>
        </div>
      </Section>

      <Section
        title="Dialog"
        description="Modal surface with header, body, and footer actions."
      >
        <Dialog>
          <DialogTrigger render={<Button variant="outline" />}>
            Open dialog
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete recording</DialogTitle>
              <DialogDescription>
                This permanently removes the recording and its analyses. This
                action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
              <DialogClose render={<Button variant="destructive" />}>
                Delete
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Section>

      <Section
        title="Tooltip"
        description="Hover and focus hint anchored to a trigger."
      >
        <Tooltip>
          <TooltipTrigger render={<Button variant="secondary" />}>
            Hover me
          </TooltipTrigger>
          <TooltipContent>Streams raw PCM over the WebSocket.</TooltipContent>
        </Tooltip>
      </Section>

      <Section
        title="Sonner"
        description="Toast notifications rendered by the global toaster."
      >
        <div className="flex flex-wrap gap-3">
          <Button
            variant="outline"
            onClick={() => toast.success("Recording saved.")}
          >
            Success
          </Button>
          <Button
            variant="outline"
            onClick={() => toast.info("Streaming partial transcript.")}
          >
            Info
          </Button>
          <Button
            variant="outline"
            onClick={() => toast.warning("Input level is low.")}
          >
            Warning
          </Button>
          <Button
            variant="outline"
            onClick={() => toast.error("Microphone permission denied.")}
          >
            Error
          </Button>
        </div>
      </Section>
    </main>
  );
}
