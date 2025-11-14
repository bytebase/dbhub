import { Link } from 'react-router-dom';

export default function NotFoundView() {
  return (
    <div className="container mx-auto px-8 py-12 max-w-4xl">
      <div className="space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-4">
            404 - Page Not Found
          </h1>
          <p className="text-xl text-muted-foreground">
            The page you're looking for doesn't exist.
          </p>
        </div>

        <div className="bg-muted rounded-lg p-6">
          <p className="text-muted-foreground mb-4">
            The URL you entered could not be found. This might be because:
          </p>
          <ul className="space-y-2 text-muted-foreground list-disc list-inside">
            <li>The page was moved or deleted</li>
            <li>You typed the URL incorrectly</li>
            <li>The resource ID is invalid</li>
          </ul>
        </div>

        <div>
          <Link
            to="/"
            className="inline-flex items-center px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            Go to Data Sources
          </Link>
        </div>
      </div>
    </div>
  );
}
