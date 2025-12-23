import { Link } from 'react-router-dom';

export default function Logo() {
  return (
    <div className="px-6 py-4">
      <Link to="/" className="block hover:opacity-80 transition-opacity">
        <img
          src="/logo-full-light.svg"
          alt="DBHub"
          className="w-[200px] h-auto"
        />
      </Link>
    </div>
  );
}
