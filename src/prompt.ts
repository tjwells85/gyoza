/**
 * Ask a Y/n question on stdin. `defaultYes` decides what an empty answer means
 * and which letter is capitalised in the prompt.
 */
export const confirm = async (message: string, defaultYes = true): Promise<boolean> => {
  process.stdout.write(`${message} [${defaultYes ? 'Y/n' : 'y/N'}] `);

  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  }

  return false;
};

/**
 * Ask the user to pick one of `options` on stdin, by number or by name. Returns
 * `undefined` on an unrecognised answer or closed stdin — the caller decides what
 * "no choice" means.
 */
export const choose = async <T extends string>(message: string, options: readonly T[]): Promise<T | undefined> => {
  const listing = options.map((option, i) => `[${i + 1}] ${option}`).join('  ');
  process.stdout.write(`${message} ${listing}: `);

  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1];
    return options.find((option) => option.toLowerCase() === answer);
  }

  return undefined;
};
