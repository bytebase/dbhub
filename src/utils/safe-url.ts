/**
 * SafeURL utility
 * 
 * Provides a safer alternative to URL constructor for database connections
 * that may contain special characters in passwords or other parts
 */

/**
 * Interface defining the structure of a URL parser
 * that can handle special characters in connection strings
 */
export interface ISafeURL {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  username: string;
  password: string;
  searchParams: Map<string, string>;
  
  getSearchParam(name: string): string | null;
  forEachSearchParam(callback: (value: string, key: string) => void): void;
}

/**
 * SafeURL class implements a parser for handling DSN strings
 * with special characters that might break the standard URL constructor
 */
export class SafeURL implements ISafeURL {
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  username: string;
  password: string;
  searchParams: Map<string, string>;

  /**
   * Parse a URL and handle special characters in passwords
   * This is a safe alternative to the URL constructor
   * 
   * @param urlString - The DSN string to parse
   */
  constructor(urlString: string) {
    // Initialize with defaults
    this.protocol = '';
    this.hostname = '';
    this.port = '';
    this.pathname = '';
    this.username = '';
    this.password = '';
    this.searchParams = new Map<string, string>();

    // Validate URL string
    if (!urlString || urlString.trim() === '') {
      throw new Error('URL string cannot be empty');
    }

    try {
      // Extract protocol
      const protocolSeparator: number = urlString.indexOf('://');
      if (protocolSeparator !== -1) {
        this.protocol = urlString.substring(0, protocolSeparator + 1); // includes the colon
        urlString = urlString.substring(protocolSeparator + 3); // rest after ://
      } else {
        throw new Error('Invalid URL format: missing protocol (e.g., "mysql://")');
      }

      // Extract query params if any
      const questionMarkIndex: number = urlString.indexOf('?');
      let queryParams: string = '';
      if (questionMarkIndex !== -1) {
        queryParams = urlString.substring(questionMarkIndex + 1);
        urlString = urlString.substring(0, questionMarkIndex);

        // Parse query parameters
        queryParams.split('&').forEach(pair => {
          const parts: string[] = pair.split('=');
          if (parts.length === 2 && parts[0] && parts[1]) {
            this.searchParams.set(parts[0], decodeURIComponent(parts[1]));
          }
        });
      }

      // Extract authentication.
      //
      // The separator is the LAST '@' of the authority, not the first: '@' is a
      // legal password character, and passwords carrying one are common. Taking
      // the first '@' would cut the password short and fold its tail into the
      // hostname, which surfaces as a DNS failure rather than as a bad password.
      //
      // The search is bounded by the start of the path, because the path is
      // still attached at this point and may legitimately contain '@' (a
      // database named "a@b", say) — an unbounded lastIndexOf would then treat
      // that one as the separator.
      const pathStart: number = urlString.indexOf('/');
      const authorityEnd: number = pathStart === -1 ? urlString.length : pathStart;
      const atIndex: number = urlString.lastIndexOf('@', authorityEnd - 1);
      if (atIndex !== -1) {
        const auth: string = urlString.substring(0, atIndex);
        urlString = urlString.substring(atIndex + 1);

        // Split into username and password
        const colonIndex: number = auth.indexOf(':');
        if (colonIndex !== -1) {
          this.username = auth.substring(0, colonIndex);
          this.password = auth.substring(colonIndex + 1);
          
          // Decode username and password
          this.username = decodeURIComponent(this.username);
          this.password = decodeURIComponent(this.password);
        } else {
          this.username = auth;
        }
      }

      // Extract pathname
      const pathSeparatorIndex: number = urlString.indexOf('/');
      if (pathSeparatorIndex !== -1) {
        this.pathname = urlString.substring(pathSeparatorIndex);
        urlString = urlString.substring(0, pathSeparatorIndex);
      }

      // Extract hostname and port
      const colonIndex: number = urlString.indexOf(':');
      if (colonIndex !== -1) {
        this.hostname = urlString.substring(0, colonIndex);
        this.port = urlString.substring(colonIndex + 1);
      } else {
        this.hostname = urlString;
      }
      
      // Additional validation
      if (this.protocol === '') {
        throw new Error('Invalid URL: protocol is required');
      }
    } catch (error) {
      throw new Error(`Failed to parse URL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Helper method to safely get a parameter from query string
   * 
   * @param name - The parameter name to retrieve
   * @returns The parameter value or null if not found
   */
  getSearchParam(name: string): string | null {
    return this.searchParams.has(name) ? this.searchParams.get(name) as string : null;
  }

  /**
   * Helper method to iterate over all parameters
   * 
   * @param callback - Function to call for each parameter
   */
  forEachSearchParam(callback: (value: string, key: string) => void): void {
    this.searchParams.forEach((value, key) => callback(value, key));
  }
}
