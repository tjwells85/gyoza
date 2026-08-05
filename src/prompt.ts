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
