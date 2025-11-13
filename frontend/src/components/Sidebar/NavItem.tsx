import { Link, useLocation } from 'react-router-dom';
import { cn } from '../../lib/utils';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
}

export default function NavItem({ to, icon, label }: NavItemProps) {
  const location = useLocation();
  const isActive = location.pathname === to;

  return (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-3 px-6 py-3 text-sm font-medium transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        isActive && 'bg-accent text-accent-foreground'
      )}
    >
      <span className="w-5 h-5 flex items-center justify-center">
        {icon}
      </span>
      <span>{label}</span>
    </Link>
  );
}
