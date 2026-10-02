import { Link, Outlet } from 'react-router-dom';
import { UserButton } from '@/components/auth/user/user-button';
import { ShieldAlert } from 'lucide-react';
import { MainNav } from './main-nav';
import { KillSwitchBanner } from './kill-switch-banner';

export function DashboardLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/95 px-6 backdrop-blur-sm">
        <div className="flex items-center gap-6">
          <Link to="/targets" className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="size-5 text-primary" />
            <span>WVS</span>
          </Link>
          <MainNav />
        </div>
        <div className="flex items-center gap-4">
          <UserButton />
        </div>
      </header>
      <KillSwitchBanner />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
