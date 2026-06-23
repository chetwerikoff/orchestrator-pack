export declare const REACTION_CONFIG_UNAVAILABLE: 'reaction_config_unavailable';
export declare const REACTION_MESSAGE_UNRESOLVED: 'reaction_message_unresolved';

export declare function validateReactionsSection(yamlText: string): {
  ok: boolean;
  reactions?: Record<string, { action?: string; message?: string }>;
  error?: string;
};

export declare function parseReactionsSection(
  yamlText: string,
): Record<string, { action?: string; message?: string }>;

export declare function extractSendToAgentReactionMessages(
  reactions: Record<string, { action?: string; message?: string }>,
): Record<string, string>;

export declare function parseReactionMessagesFromYaml(yamlText: string): {
  ok: boolean;
  messages: Record<string, string>;
  reason?: string;
  error?: string;
};

export declare function readReactionMessagesFromYamlFile(yamlPath: string): {
  ok: boolean;
  messages: Record<string, string>;
  reason?: string;
  error?: string;
};

export declare function resolveReactionDeliveryShapeFromYaml(
  yamlText: string,
  reactionKey: string,
): {
  ok: boolean;
  reactionKey?: string;
  message?: string;
  deliveryPath?: string;
  messageShape?: { charLength: number; lineCount: number; multiline: boolean };
  messages?: Record<string, string>;
  reason?: string;
  error?: string;
};
