export interface ManagerCliOptionDeclaration {
  readonly flag: `--${string}`;
  readonly value?: string;
  readonly required?: boolean;
  readonly repeatable?: boolean;
  readonly values?: readonly string[];
}

export interface ManagerCliCommandDeclaration {
  readonly name: string;
  readonly options: readonly ManagerCliOptionDeclaration[];
}

export interface ManagerCliDeclaration {
  readonly program: string;
  readonly options?: readonly ManagerCliOptionDeclaration[];
  readonly commands?: readonly ManagerCliCommandDeclaration[];
}

export interface ManagerCliInspection {
  readonly help: string | null;
  readonly error: string | null;
  readonly command: string | null;
}

const HELP_FLAGS = new Set(['--help', '-h']);

function renderOption(option: ManagerCliOptionDeclaration): string {
  const value = option.values && option.values.length > 0
    ? ` <${option.values.join('|')}>`
    : option.value ? ` <${option.value}>` : '';
  const rendered = `${option.flag}${value}`;
  return option.required ? rendered : `[${rendered}]`;
}

function activeCommand(
  declaration: ManagerCliDeclaration,
  command?: string | null,
): ManagerCliCommandDeclaration | null {
  if (!command || !declaration.commands) return null;
  return declaration.commands.find((candidate) => candidate.name === command) ?? null;
}

export function managerCliOptionInventory(
  declaration: ManagerCliDeclaration,
  command?: string | null,
): readonly ManagerCliOptionDeclaration[] {
  const active = activeCommand(declaration, command);
  return active?.options ?? declaration.options ?? [];
}

export function renderManagerCliUsage(
  declaration: ManagerCliDeclaration,
  command?: string | null,
): string {
  const active = activeCommand(declaration, command);
  if (declaration.commands && !active) {
    const rows = declaration.commands.map((candidate) =>
      `  ${declaration.program} ${candidate.name} ${candidate.options.map(renderOption).join(' ')}`.trimEnd()
    );
    return ['Usage:', ...rows].join('\n');
  }
  const options = managerCliOptionInventory(declaration, command);
  const prefix = active ? `${declaration.program} ${active.name}` : declaration.program;
  return ['Usage:', `  ${prefix} ${options.map(renderOption).join(' ')}`.trimEnd()].join('\n');
}

function invalid(
  declaration: ManagerCliDeclaration,
  command: string | null,
  message: string,
): ManagerCliInspection {
  return {
    help: null,
    error: `${message}\n${renderManagerCliUsage(declaration, command)}`,
    command,
  };
}

export function inspectManagerCliInvocation(
  declaration: ManagerCliDeclaration,
  tokens: readonly string[],
): ManagerCliInspection {
  let command: string | null = null;
  let offset = 0;

  if (declaration.commands) {
    if (tokens.some((token) => HELP_FLAGS.has(token)) && (tokens.length === 0 || HELP_FLAGS.has(tokens[0] ?? ''))) {
      return { help: renderManagerCliUsage(declaration), error: null, command: null };
    }
    const candidate = tokens[0] ?? '';
    const active = activeCommand(declaration, candidate);
    if (!active) {
      if (HELP_FLAGS.has(candidate)) return { help: renderManagerCliUsage(declaration), error: null, command: null };
      return invalid(declaration, null, candidate ? `unknown command ${candidate}` : 'command is required');
    }
    command = active.name;
    offset = 1;
    if (tokens.slice(offset).some((token) => HELP_FLAGS.has(token))) {
      return { help: renderManagerCliUsage(declaration, command), error: null, command };
    }
  } else if (tokens.some((token) => HELP_FLAGS.has(token))) {
    return { help: renderManagerCliUsage(declaration), error: null, command: null };
  }

  const options = managerCliOptionInventory(declaration, command);
  const byFlag = new Map(options.map((option) => [option.flag, option]));
  const seen = new Map<string, number>();

  for (let index = offset; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (HELP_FLAGS.has(token)) {
      return { help: renderManagerCliUsage(declaration, command), error: null, command };
    }
    if (!token.startsWith('--')) {
      return invalid(declaration, command, `unexpected argument ${token}`);
    }
    const option = byFlag.get(token as `--${string}`);
    if (!option) return invalid(declaration, command, `unknown option ${token}`);

    const count = (seen.get(option.flag) ?? 0) + 1;
    seen.set(option.flag, count);
    if (count > 1 && !option.repeatable) {
      return invalid(declaration, command, `${option.flag} may be supplied only once`);
    }
    if (!option.value) continue;

    const value = tokens[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      const message = option.values && option.values.length > 0
        ? `${option.flag} must be one of ${option.values.join(', ')}; received ""`
        : `${option.flag} requires <${option.value}>`;
      return invalid(declaration, command, message);
    }
    if (option.values && !option.values.includes(value)) {
      return invalid(
        declaration,
        command,
        `${option.flag} must be one of ${option.values.join(', ')}; received "${value}"`,
      );
    }
    index += 1;
  }

  for (const option of options) {
    if (option.required && !seen.has(option.flag)) {
      return invalid(declaration, command, `${option.flag} is required`);
    }
  }

  return { help: null, error: null, command };
}
