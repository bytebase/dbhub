import { Link } from 'react-router-dom';

export default function Logo() {
  return (
    <div className="flex h-16 shrink-0 items-center border-b border-border px-4">
      <Link
        to="/"
        aria-label="DBHub home"
        className="flex min-h-11 items-center rounded-sm touch-manipulation hover:opacity-80 transition-opacity motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <img
          src="/logo-full-light.svg"
          alt=""
          width={556}
          height={146}
          className="block w-32 max-w-full h-auto dark:hidden"
        />
        <img
          src="/logo-full-dark.svg"
          alt=""
          width={556}
          height={146}
          className="hidden w-32 max-w-full h-auto dark:block"
        />
      </Link>
    </div>
  );
}
