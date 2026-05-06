export interface CommandFlag {
  flag: string;
  description: string;
}

type Handler = (args: string[]) => Promise<void>;
type CommandFactory = (description: string, run: Handler, flags?: CommandFlag[]) => Command;

export interface Command {
  description: string;
  flags?: CommandFlag[];
  run: Handler;
}

export interface CommandGroup {
  description: string;
  commands: Record<string, GyozaNode>;
}

export type GyozaNode = Command | CommandGroup;

export const isCommand = (node: GyozaNode): node is Command => 'run' in node;

export const gyoza = (
  description: string,
  builder: (cmd: CommandFactory) => Record<string, GyozaNode>,
): CommandGroup => {
  const cmd: CommandFactory = (desc, run, flags) => ({ description: desc, run, flags });
  return { description, commands: builder(cmd) };
};
