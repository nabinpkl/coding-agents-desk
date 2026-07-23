import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { appRoutes } from "@/components/layout/routes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-6 py-16">
      <header className="flex flex-col items-start gap-4">
        <Badge variant="secondary">Local-first interaction agents</Badge>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance">
          Gesture and voice, inferred on your own machine.
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Hand and face landmarks run entirely in the browser. Speech streams to
          a local Python backend for live transcription, then every recording is
          yours to analyze. Three surfaces, one hybrid pipeline.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {appRoutes.map(({ href, label, description, icon: Icon }) => (
          <Card
            key={href}
            className="group/route flex flex-col justify-between transition-shadow hover:ring-foreground/20"
          >
            <CardHeader>
              <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground">
                <Icon className="size-5" aria-hidden />
              </span>
              <CardTitle className="mt-3">{label}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="ghost"
                className="px-0 text-muted-foreground group-hover/route:text-foreground"
                nativeButton={false}
                render={<Link href={href} />}
              >
                Open {label}
                <ArrowRight className="transition-transform group-hover/route:translate-x-0.5" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
