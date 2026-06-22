/**
 * Resolve static send-to-agent reaction message text from operator YAML.
 * Runtime truth is live agent-orchestrator.yaml — never in-code stub maps.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  deriveMessageShape,
  DELIVERY_PATH_PENDING_DRAFT,
  DELIVERY_PATH_SELF_SUBMITTED,
} from '../docs/worker-message-dispatch-observe.mjs';
import { printJson, resolveMechanicalCliArg } from '../docs/review-mechanical-cli.mjs';

export const REACTION_CONFIG_UNAVAILABLE = 'reaction_config_unavailable';
export const REACTION_MESSAGE_UNRESOLVED = 'reaction_message_unresolved';

const SEND_TO_AGENT = 'send-to-agent';

/**
 * @param {string} blockText
 */
function parseReactionEntry(blockText) {
  /** @type {{ action?: string, message?: string }} */
  const entry = {};
  const lines = String(blockText ?? '').split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const actionMatch = line.match(/^\s{4}action:\s*(.+)\s*$/);
    if (actionMatch) {
      entry.action = actionMatch[1].trim();
      index += 1;
      continue;
    }
    const inlineMessageMatch = line.match(/^\s{4}message:\s*(.+)\s*$/);
    if (inlineMessageMatch) {
      const raw = inlineMessageMatch[1].trim();
      if (raw === '>-' || raw === '>' || raw === '|' || raw === '|-') {
        index += 1;
        const folded = [];
        while (index < lines.length) {
          const body = lines[index];
          if (!body.startsWith('      ')) {
            break;
          }
          folded.push(body.slice(6));
          index += 1;
        }
        entry.message = foldScalarBlock(raw, folded);
        continue;
      }
      entry.message = stripYamlQuotes(raw);
      index += 1;
      continue;
    }
    index += 1;
  }
  return entry;
}

/**
 * @param {string} indicator
 * @param {string[]} bodyLines
 */
function foldScalarBlock(indicator, bodyLines) {
  const joined = bodyLines.join('\n');
  if (indicator === '|-') {
    return joined.replace(/\n+$/, '');
  }
  if (indicator === '|') {
    return joined.endsWith('\n') ? joined : `${joined}\n`;
  }
  return joined.replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} raw
 */
function stripYamlQuotes(raw) {
  const text = String(raw ?? '').trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * @param {string} yamlText
 */
export function parseReactionsSection(yamlText) {
  const lines = String(yamlText ?? '').split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^reactions:\s*$/.test(lines[index])) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) {
    return {};
  }

  /** @type {Record<string, ReturnType<typeof parseReactionEntry>>} */
  const reactions = {};
  let currentKey = '';
  /** @type {string[]} */
  let currentLines = [];

  const flush = () => {
    if (!currentKey) {
      return;
    }
    reactions[currentKey] = parseReactionEntry(currentLines.join('\n'));
    currentKey = '';
    currentLines = [];
  };

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('#')) {
      break;
    }
    const keyMatch = line.match(/^  ([a-z0-9-]+):\s*$/);
    if (keyMatch) {
      flush();
      currentKey = keyMatch[1];
      continue;
    }
    if (currentKey) {
      currentLines.push(line);
    }
  }
  flush();
  return reactions;
}

/**
 * @param {Record<string, ReturnType<typeof parseReactionEntry>>} reactions
 */
export function extractSendToAgentReactionMessages(reactions) {
  /** @type {Record<string, string>} */
  const messages = {};
  for (const [key, entry] of Object.entries(reactions ?? {})) {
    const action = String(entry?.action ?? '').trim();
    const message = String(entry?.message ?? '').trim();
    if (action === SEND_TO_AGENT && message) {
      messages[key] = message;
    }
  }
  return messages;
}

/**
 * @param {string} yamlText
 */
export function parseReactionMessagesFromYaml(yamlText) {
  try {
    const reactions = parseReactionsSection(yamlText);
    return {
      ok: true,
      messages: extractSendToAgentReactionMessages(reactions),
    };
  } catch (error) {
    return {
      ok: false,
      reason: REACTION_CONFIG_UNAVAILABLE,
      error: error instanceof Error ? error.message : String(error),
      messages: {},
    };
  }
}

/**
 * @param {string} yamlPath
 */
export function readReactionMessagesFromYamlFile(yamlPath) {
  const path = String(yamlPath ?? '').trim();
  if (!path) {
    return {
      ok: false,
      reason: REACTION_CONFIG_UNAVAILABLE,
      error: 'missing_yaml_path',
      messages: {},
    };
  }
  try {
    const yamlText = readFileSync(path, 'utf8');
    return parseReactionMessagesFromYaml(yamlText);
  } catch (error) {
    return {
      ok: false,
      reason: REACTION_CONFIG_UNAVAILABLE,
      error: error instanceof Error ? error.message : String(error),
      messages: {},
    };
  }
}

/**
 * @param {string} yamlText
 * @param {string} reactionKey
 */
export function resolveReactionDeliveryShapeFromYaml(yamlText, reactionKey) {
  const parsed = parseReactionMessagesFromYaml(yamlText);
  if (!parsed.ok) {
    return parsed;
  }
  const message = parsed.messages?.[reactionKey];
  if (!message) {
    return {
      ok: false,
      reason: REACTION_MESSAGE_UNRESOLVED,
      reactionKey,
      messages: parsed.messages,
    };
  }
  const shape = deriveMessageShape(message);
  return {
    ok: true,
    reactionKey,
    message,
    deliveryPath: shape.deliveryPath,
    messageShape: {
      charLength: shape.charLength,
      lineCount: shape.lineCount,
      multiline: shape.multiline,
    },
  };
}

export {
  DELIVERY_PATH_PENDING_DRAFT,
  DELIVERY_PATH_SELF_SUBMITTED,
};

function runCli() {
  const subcommand = process.argv[2] ?? 'help';
  if (subcommand === 'parse') {
    const yamlPath = resolveMechanicalCliArg('--path');
    printJson(readReactionMessagesFromYamlFile(yamlPath));
    return;
  }
  if (subcommand === 'shape') {
    const yamlPath = resolveMechanicalCliArg('--path');
    const reactionKey = resolveMechanicalCliArg('--reaction-key') || 'report-stale';
    const yamlText = readFileSync(yamlPath, 'utf8');
    printJson(resolveReactionDeliveryShapeFromYaml(yamlText, reactionKey));
    return;
  }
  printJson({
    ok: false,
    error: 'usage: reaction-config-messages.mjs parse --path <yaml> | shape --path <yaml> [--reaction-key report-stale]',
  });
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli();
}
