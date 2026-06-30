/** gh api option tokens that consume the following argv value */
export const GH_API_OPTION_WITH_VALUE = new Set([
  '--hostname', '--method', '--header', '-H', '-F', '-f', '--input', '--raw-field', '--repo', '--jq', '-q',
]);

/**
 * @param {string[]} tokens
 * @param {number} cursor index after the `api` token
 * @returns {string | null}
 */
export function ghApiEndpointAfterApi(tokens, cursor) {
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (!token.startsWith('-')) {
      return token;
    }
    if (token.includes('=')) {
      cursor += 1;
      continue;
    }
    if (GH_API_OPTION_WITH_VALUE.has(token)) {
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
  return null;
}

/**
 * @param {string[] | null} tokens tokens from commandTemplateToArgv (first token is `api`)
 * @returns {string | null}
 */
export function ghApiEndpointFromApiTokens(tokens) {
  if (!tokens || tokens[0] !== 'api') {
    return null;
  }
  return ghApiEndpointAfterApi(tokens, 1);
}

/**
 * @param {string[]} argv process argv (may include gh binary path before `api`)
 * @returns {string | null}
 */
export function ghApiEndpointFromArgv(argv) {
  const apiIdx = argv.indexOf('api');
  if (apiIdx === -1) {
    return null;
  }
  return ghApiEndpointAfterApi(argv, apiIdx + 1);
}
