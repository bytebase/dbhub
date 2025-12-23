export type DatabaseType = 'postgres' | 'mysql' | 'mariadb' | 'sqlserver' | 'sqlite';

export interface SSHTunnel {
  enabled: boolean;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
}

export interface ToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  statement?: string;
  readonly?: boolean;
  max_rows?: number;
}

export interface DataSource {
  id: string;
  type: DatabaseType;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  is_default: boolean;
  ssh_tunnel?: SSHTunnel;
  tools: Tool[];
}
