import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  FileSearch,
  FileText,
  Globe,
  LayoutDashboard,
  Menu,
  Radar,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRole } from '@/lib/use-role';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Targets', href: '/targets', icon: Globe },
  { name: 'Scans', href: '/scans', icon: Radar },
  { name: 'Findings', href: '/findings', icon: FileSearch },
  { name: 'Reports', href: '/reports', icon: FileText },
];

const ADMIN_ITEM: NavItem = { name: 'Admin', href: '/admin', icon: ShieldCheck };

/** Active as a tinted pill, so the current section reads without relying on a shade of grey. */
function itemClass(isActive: boolean): string {
  return cn(
    'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
    isActive
      ? 'bg-primary/10 text-primary'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
  );
}

function NavItemLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink to={item.href} className={({ isActive }) => itemClass(isActive)}>
      <Icon className="size-4" aria-hidden="true" />
      {item.name}
    </NavLink>
  );
}

/** NavLink's own rule: a section is current on its page and every page under it. */
function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Below the md breakpoint the links fold into a menu rather than overflow.
 * Each item's child is a plain Link: asChild hands it the item's role, focus
 * handling and ref, which a wrapper component would drop.
 */
function MobileNav({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
          <Menu />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {items.map(({ name, href, icon: Icon }) => {
          const current = isCurrent(pathname, href);
          return (
            <DropdownMenuItem key={href} asChild>
              <Link
                to={href}
                aria-current={current ? 'page' : undefined}
                className={current ? 'text-primary' : undefined}
              >
                <Icon aria-hidden="true" />
                {name}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The dashboard's main navigation. Administration is only offered to
 * administrators (ADR-0009); the API refuses everyone else regardless.
 */
export function MainNav() {
  const isAdmin = useRole() === 'ADMIN';
  const items = isAdmin ? [...NAV_ITEMS, ADMIN_ITEM] : NAV_ITEMS;

  return (
    <>
      <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
        {items.map((item) => (
          <NavItemLink key={item.href} item={item} />
        ))}
      </nav>
      <MobileNav items={items} />
    </>
  );
}
