import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useRole } from '@/lib/use-role';

const navItems = [
  { name: 'Targets', href: '/targets' },
  { name: 'Dashboard', href: '/dashboard' },
  { name: 'Scans', href: '/scans' },
  { name: 'Findings', href: '/findings' },
  { name: 'Reports', href: '/reports' },
];

/**
 * The dashboard's main navigation. Administration is only offered to
 * administrators (ADR-0009); the API refuses everyone else regardless.
 */
export function MainNav() {
  const isAdmin = useRole() === 'ADMIN';
  const items = isAdmin ? [...navItems, { name: 'Admin', href: '/admin' }] : navItems;

  return (
    <nav className="flex items-center gap-4 text-sm font-medium">
      {items.map((item) => (
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
  );
}
