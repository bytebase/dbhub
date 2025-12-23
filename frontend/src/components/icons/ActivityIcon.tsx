interface ActivityIconProps {
  className?: string;
}

export default function ActivityIcon({ className = 'w-5 h-5' }: ActivityIconProps) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <polyline strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
