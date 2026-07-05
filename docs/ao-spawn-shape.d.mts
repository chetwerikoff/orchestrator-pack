export declare const AO_SPAWN_DISPLAY_NAME_MAX_LENGTH: number;
export declare const SPAWN_ARGV_OPTIONS_WITH_VALUE: readonly string[];

export interface RunnableSpawnMatch {
  line: number;
  command: string;
  kind: 'line' | 'backtick' | 'inline';
}

export interface SpawnShapeFlags {
  project?: string;
  name?: string;
}

export interface SpawnShapeViolation {
  relPath?: string;
  line: number;
  command: string;
  violations: string[];
}

export declare function isNonRunnableSpawnMention(
  line: string,
  previousLine?: string,
): boolean;

export declare function hasSpawnDirectedNegation(text: string, spawnIndex: number): boolean;

export declare function extractInlineSpawnCommand(line: string, spawnIndex: number): string;

export declare function findRunnableSpawnCommands(text: string): RunnableSpawnMatch[];

export declare function parseSpawnShapeFlags(command: string): SpawnShapeFlags;

export declare function tokenizeSpawnArgv(command: string): string[];

export declare function isDocumentationSpawnTemplate(match: RunnableSpawnMatch): boolean;

export declare function validateRunnableSpawnCommand(command: string): string[];

export declare function scanSpawnShapeViolations(
  text: string,
  options?: { relPath?: string },
): SpawnShapeViolation[];

export declare function scanSpawnShapeCorpus(
  rootDir: string,
  config: { corpusRelPaths: string[]; baselineRelPath: string },
): Promise<SpawnShapeViolation[]>;

export declare function collectDefaultCorpusRelPaths(rootDir: string): Promise<string[]>;

export declare const SPAWN_GATE_CORPUS_REL_PATHS: readonly string[];
