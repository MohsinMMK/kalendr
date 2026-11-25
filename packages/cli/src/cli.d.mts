export interface CliIo {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
}
export function run(argv: string[], io: CliIo): Promise<number>;
