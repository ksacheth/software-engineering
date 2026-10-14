import { Link, Outlet } from 'react-router-dom';
import { UserButton } from '@/components/auth/user/user-button';
import { BrandMark } from './brand-mark';
import { MainNav } from './main-nav';
import { KillSwitchBanner } from './kill-switch-banner';
import { SiteFooter } from './site-footer';

export function DashboardLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* The inner width matches the pages' max-w-7xl, so the header lines up with the content under it. */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 shadow-xs backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-6">
          <Link
            to="/dashboard"
            aria-label="WVS dashboard"
            className="rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <BrandMark />
          </Link>
          <MainNav />
          <div className="ml-auto flex items-center gap-4">
            <UserButton />
          </div>
        </div>
      </header>
      <KillSwitchBanner />
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
