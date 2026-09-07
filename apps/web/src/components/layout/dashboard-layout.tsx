import { Link, NavLink, Outlet } from 'react-router-dom';
import { UserButton } from '@/components/auth/user/user-button';
import { cn } from '@/lib/utils';
import { ShieldAlert } from 'lucide-react';

const navItems = [
  { name: 'Targets', href: '/targets' },
  { name: 'Dashboard', href: '/dashboard' },
  { name: 'Scans', href: '/scans' },
  { name: 'Findings', href: '/findings' },
  { name: 'Reports', href: '/reports' },
  { name: 'Admin', href: '/admin' },
];

export function DashboardLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/95 px-6 backdrop-blur-sm">
        <div className="flex items-center gap-6">
          <Link to="/targets" className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="size-5 text-primary" />
            <span>WVS</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm font-medium">
            {navItems.map((item) => (
              <NavLink
                key={item.href}
                to={item.href}
                className={({ isActive }) =>
                  cn(
                    'transition-colors hover:text-foreground',
                    isActive ? 'text-foreground' : 'text-muted-foreground',
                  )
                }
              >
                {item.name}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <UserButton />
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
