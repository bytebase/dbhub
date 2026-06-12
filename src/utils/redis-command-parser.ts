export const REDIS_READONLY_COMMANDS = [
  "bitcount",
  "dbsize",
  "echo",
  "exists",
  "geodist",
  "geohash",
  "geopos",
  "georadius_ro",
  "georadiusbymember_ro",
  "geosearch",
  "get",
  "getbit",
  "getrange",
  "hexists",
  "hget",
  "hgetall",
  "hkeys",
  "hlen",
  "hmget",
  "hrandfield",
  "hscan",
  "hstrlen",
  "hvals",
  "info",
  "keys",
  "lindex",
  "llen",
  "lpos",
  "lrange",
  "mget",
  "pfcount",
  "ping",
  "pttl",
  "randomkey",
  "scan",
  "scard",
  "sinter",
  "sintercard",
  "sismember",
  "smembers",
  "smismember",
  "sort_ro",
  "srandmember",
  "sscan",
  "strlen",
  "substr",
  "sunion",
  "sdiff",
  "time",
  "ttl",
  "type",
  "xinfo",
  "xlen",
  "xrange",
  "xread",
  "xrevrange",
  "zcard",
  "zcount",
  "zdiff",
  "zinter",
  "zlexcount",
  "zmscore",
  "zrandmember",
  "zrange",
  "zrangebylex",
  "zrangebyscore",
  "zrank",
  "zrevrange",
  "zrevrangebylex",
  "zrevrangebyscore",
  "zrevrank",
  "zscan",
  "zscore",
  "zunion",
] as const;

const REDIS_READONLY_COMMAND_SET = new Set<string>(REDIS_READONLY_COMMANDS);

export function splitRedisStatements(input: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === ";" || char === "\n") {
      const statement = input.substring(start, i).trim();
      if (statement.length > 0 && !statement.startsWith("#")) {
        statements.push(statement);
      }
      start = i + 1;
    }
  }

  const finalStatement = input.substring(start).trim();
  if (finalStatement.length > 0 && !finalStatement.startsWith("#")) {
    statements.push(finalStatement);
  }

  return statements;
}

export function parseRedisCommand(statement: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let hasToken = false;

  for (let i = 0; i < statement.length; i++) {
    const char = statement[i];

    if (escaped) {
      current += char;
      escaped = false;
      hasToken = true;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      hasToken = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      hasToken = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (escaped) {
    current += "\\";
  }

  if (quote) {
    throw new Error("Unterminated quoted Redis command argument");
  }

  if (hasToken) {
    args.push(current);
  }

  if (args.length === 0) {
    throw new Error("Redis command cannot be empty");
  }

  return args;
}

export function parseRedisStatements(input: string): string[][] {
  return splitRedisStatements(input).map(parseRedisCommand);
}

export function isReadOnlyRedisCommand(args: string[]): boolean {
  const command = args[0]?.toLowerCase();
  return Boolean(command && REDIS_READONLY_COMMAND_SET.has(command));
}

export function areRedisCommandsReadOnly(input: string): boolean {
  const commands = parseRedisStatements(input);
  return commands.length > 0 && commands.every(isReadOnlyRedisCommand);
}
