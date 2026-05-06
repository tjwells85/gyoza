export interface CommandFlag {
  flag: string;
  description: string;
}

export interface Command {
  name: string;
  description: string;
  flags?: CommandFlag[];
  run(args: string[]): Promise<void>;
}
