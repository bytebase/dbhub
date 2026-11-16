import { Link } from 'react-router-dom';

export default function Logo() {
  return (
    <div className="px-6 py-4">
      <Link
        to="/"
        aria-label="DBHub home"
        className="block rounded-sm hover:opacity-80 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        <img
          src="/logo-full-light.svg"
          alt=""
          width={556}
          height={146}
          className="block w-[200px] max-w-full h-auto dark:hidden"
        />
        <img
          src="/logo-full-dark.svg"
          alt=""
          width={556}
          height={146}
          className="hidden w-[200px] max-w-full h-auto dark:block"
        />
      </Link>
    </div>
  );
}
