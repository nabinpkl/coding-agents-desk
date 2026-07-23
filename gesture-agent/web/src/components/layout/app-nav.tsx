"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Waypoints } from "lucide-react";

import { appRoutes } from "@/components/layout/routes";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { cn } from "@/lib/utils";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Global top navigation: app identity, links to the three product surfaces plus
 * home, and the theme toggle. Sticky across every route. Active state is derived
 * from the current pathname so the highlight follows client-side navigation.
 */
export function AppNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur supports-backdrop-filter:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-4 px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 font-semibold tracking-tight"
        >
          <Waypoints className="size-5 text-primary" aria-hidden />
          <span>Gesture Agent</span>
        </Link>
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {appRoutes.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}
