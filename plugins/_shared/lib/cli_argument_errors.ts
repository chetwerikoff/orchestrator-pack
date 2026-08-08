export function unknownCliArgumentError(argument: string, usage: string): Error {
  return new Error(`unknown argument: ${argument}\n${usage}`);
}

export function missingCliArgumentError(argument: string, usage: string): Error {
  return new Error(`${argument} is required\n${usage}`);
}
