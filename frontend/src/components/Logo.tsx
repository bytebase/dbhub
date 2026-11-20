import { Link } from 'react-router-dom';

export default function Logo() {
  return (
    <Link
      to="/"
      aria-label="DBHub home"
      className="flex min-h-11 min-w-11 justify-center items-center rounded-sm touch-manipulation hover:opacity-80 transition-opacity motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <img
        src="/logo-full-light.svg"
        alt=""
        width={547}
        height={132}
        className="block w-32 max-w-full h-auto dark:hidden"
      />
      <img
        src="/logo-full-dark.svg"
        alt=""
        width={547}
        height={132}
        className="hidden w-32 max-w-full h-auto dark:block"
      />
    </Link>
  );
}
