interface ChevronLeftIconProps {
  className?: string;
}

export default function ChevronLeftIcon({ className = 'w-4 h-4' }: ChevronLeftIconProps) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}
