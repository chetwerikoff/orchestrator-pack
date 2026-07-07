export const AO_SEND_0102_HELP = `Send a message to a running agent session

Usage:
  ao send [flags]

Flags:
  -h, --help             help for send
      --message string   Message body (required)
      --session string   Session id (required)`;

export function aoSend0102HelpBash(): string {
  return `if [[ "$1" == "send" && "$2" == "--help" ]]; then
  cat <<'AO_SEND_HELP_EOF'
${AO_SEND_0102_HELP}
AO_SEND_HELP_EOF
  exit 0
fi`;
}

export function aoSend0102ParseMessageBash(targetVar = 'message'): string {
  return `${targetVar}=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    send) shift ;;
    --message) ${targetVar}="$2"; shift 2 ;;
    --session) shift 2 ;;
    *) shift ;;
  esac
done`;
}

export function aoSend0102AcceptSendBash(body: string): string {
  return `if [[ "$1" == "send" ]]; then
${body}
  exit 0
fi`;
}

export function buildAoSend0102Stub(options: {
  helpText?: string;
  onSendBody?: string;
  trailing?: string;
}): string {
  const help = options.helpText ?? AO_SEND_0102_HELP;
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `if [[ "$1" == "send" && "$2" == "--help" ]]; then`,
    `cat <<'AO_SEND_HELP_EOF'`,
    help,
    `AO_SEND_HELP_EOF`,
    'exit 0',
    'fi',
  ];
  if (options.onSendBody) {
    lines.push('if [[ "$1" == "send" ]]; then');
    lines.push(options.onSendBody);
    lines.push('exit 0');
    lines.push('fi');
  }
  if (options.trailing) {
    lines.push(options.trailing);
  }
  lines.push('exit 99');
  return `${lines.join('\n')}\n`;
}
