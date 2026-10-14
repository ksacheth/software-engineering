import { Link } from "react-router-dom";
import {
  ArrowRight,
  BadgeCheck,
  FileText,
  Globe,
  ListChecks,
  Radar,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { REPORT_FORMATS } from "@wvs/shared";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/layout/site-footer";
import { useSignedIn } from "@/lib/use-role";
import { HeroIllustration } from "./hero-illustration";

const STEPS: { title: string; text: string }[] = [
  {
    title: "Register your website",
    text: "Add the address of a site you are responsible for.",
  },
  {
    title: "Prove you own it",
    text: "Publish a one-time token as a DNS TXT record or a file on the site.",
  },
  {
    title: "Run a scan",
    text: "WVS crawls the site, including pages built by JavaScript, and runs its checks while you watch.",
  },
  {
    title: "Fix and report",
    text: "Work through prioritised findings, record decisions and export a report.",
  },
];

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: BadgeCheck,
    title: "Ownership first",
    text: "No scan starts until you prove control of the site, and every request is checked against the addresses that proof recorded.",
  },
  {
    icon: ShieldCheck,
    title: "Safe by design",
    text: "Rate limits, a network blocklist and an administrator kill switch keep every scan gentle on the site it tests.",
  },
  {
    icon: Radar,
    title: "Live progress",
    text: "Watch pages, requests and findings arrive as the scan runs, and pause or cancel at any moment.",
  },
  {
    icon: ListChecks,
    title: "Findings you can act on",
    text: "Severity, evidence and remediation for each issue, with triage decisions that carry forward to the next scan.",
  },
  {
    icon: FileText,
    title: "Reports in five formats",
    text: `Executive summaries and technical reports as ${REPORT_FORMATS.join(", ")}, with time-limited share links.`,
  },
  {
    icon: ScrollText,
    title: "A complete record",
    text: "Scans, triage, reports and administrator actions land in an append-only audit log.",
  },
];

const FACTS: { value: string; label: string }[] = [
  { value: "31", label: "passive checks" },
  { value: "14", label: "safe active checks" },
  { value: String(REPORT_FORMATS.length), label: "report formats" },
  { value: "10/s", label: "request ceiling per target" },
];

export function LandingPage() {
  const signedIn = useSignedIn();

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <LandingHeader signedIn={signedIn} />
      <main className="flex-1">
        <Hero signedIn={signedIn} />
        <Facts />
        <HowItWorks />
        <Features />
        <SafetyNote signedIn={signedIn} />
      </main>
      <SiteFooter />
    </div>
  );
}

/** Null while the session check is pending, which renders as signed out. */
type SignedIn = boolean | null;

function LandingHeader({ signedIn }: { signedIn: SignedIn }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <ShieldAlert className="size-5 text-primary" />
          <span>WVS</span>
        </Link>
        <nav className="flex items-center gap-2" aria-label="Account">
          {signedIn ? (
            <Button asChild>
              <Link to="/dashboard">Go to dashboard</Link>
            </Button>
          ) : (
            <>
              <Button variant="ghost" asChild>
                <Link to="/auth/sign-in">Sign in</Link>
              </Button>
              <Button asChild>
                <Link to="/auth/sign-up">Register</Link>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

function Hero({ signedIn }: { signedIn: SignedIn }) {
  return (
    <section className="bg-linear-to-br from-brand-900 to-brand-700 text-white">
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-6 py-20 md:py-28 lg:grid-cols-[minmax(0,1fr)_28rem]">
        <div className="flex flex-col gap-6">
          <p className="text-sm font-medium tracking-wide text-brand-100 uppercase">
            Website Vulnerability Scanner
          </p>
          <h1 className="max-w-3xl text-4xl leading-tight font-bold md:text-5xl">
            Find the weaknesses in your website before attackers do.
          </h1>
          <p className="max-w-2xl text-lg text-brand-100">
            WVS scans the websites you own for security weaknesses: missing
            protections, exposed files, injection flaws and more. It proves you
            control a site before sending a single request, tests without
            exploiting anything, and turns what it finds into prioritised
            findings and reports.
          </p>
          <div className="flex flex-wrap gap-3">
            {signedIn ? (
              <Button size="lg" variant="secondary" asChild>
                <Link to="/dashboard">
                  Go to dashboard
                  <ArrowRight data-icon="inline-end" />
                </Link>
              </Button>
            ) : (
              <>
                <Button size="lg" variant="secondary" asChild>
                  <Link to="/auth/sign-up">
                    Create an account
                    <ArrowRight data-icon="inline-end" />
                  </Link>
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white"
                  asChild
                >
                  <Link to="/auth/sign-in">Sign in</Link>
                </Button>
              </>
            )}
          </div>
        </div>
        <div className="hidden lg:block">
          <HeroIllustration />
        </div>
      </div>
    </section>
  );
}

function Facts() {
  return (
    <section aria-label="At a glance" className="border-b border-border">
      <dl className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-6 py-8 md:grid-cols-4">
        {FACTS.map((fact) => (
          <div key={fact.label} className="flex flex-col">
            <dt className="order-2 text-muted-foreground">{fact.label}</dt>
            <dd className="order-1 text-2xl font-bold text-primary tabular-nums">
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="mx-auto max-w-7xl px-6 py-16">
      <h2 className="text-xl font-bold">How it works</h2>
      <ol className="mt-6 grid gap-6 md:grid-cols-4">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex flex-col gap-2">
            <span className="flex size-9 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground">
              {index + 1}
            </span>
            <h3 className="font-semibold">{step.title}</h3>
            <p className="text-muted-foreground">{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Features() {
  return (
    <section className="bg-muted/40">
      <div className="mx-auto max-w-7xl px-6 py-16">
        <h2 className="text-xl font-bold">What you get</h2>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li
              key={title}
              className="flex flex-col gap-2 rounded-xl border border-border bg-background p-5"
            >
              <Icon className="size-6 text-primary" aria-hidden="true" />
              <h3 className="font-semibold">{title}</h3>
              <p className="text-muted-foreground">{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SafetyNote({ signedIn }: { signedIn: SignedIn }) {
  return (
    <section className="mx-auto flex max-w-7xl flex-col items-start gap-4 px-6 py-16 md:flex-row md:items-center md:justify-between">
      <div className="flex max-w-2xl gap-4">
        <Globe
          className="mt-1 size-6 shrink-0 text-primary"
          aria-hidden="true"
        />
        <div>
          <h2 className="text-xl font-bold">
            A detection tool, not an attack tool
          </h2>
          <p className="mt-2 text-muted-foreground">
            WVS never exploits a finding, never guesses passwords, never
            load-tests a site and never scans behind a login. It only scans
            sites whose ownership has been proven.
          </p>
        </div>
      </div>
      {!signedIn && (
        <Button size="lg" asChild>
          <Link to="/auth/sign-up">Get started</Link>
        </Button>
      )}
    </section>
  );
}
